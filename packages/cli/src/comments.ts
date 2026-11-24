import { ensurePrCommits, type PullRequest } from "./gh";
import type { FileDiff } from "./git";

/**
 * Finds files whose change only touches comments, without a model: both versions of the
 * file are read from git, comments are stripped by a small scanner that knows strings, and
 * the two results must match exactly.
 *
 * Errs toward "not comments-only": an unknown language, a rename, an add or delete, or any
 * leftover difference sends the file to the classifier as usual. Leading indentation and
 * everything inside strings is kept as is, so a Python re-indent or an edited string literal
 * never passes. A change that only moves whitespace isn't comments-only either.
 */

interface Syntax {
  /** Line comment openers. */
  line: string[];
  /** `#` starts a comment anywhere outside a string (Python). */
  hash: boolean;
  block: boolean;
  /** Quote characters that open a string. */
  quotes: string[];
  /** Python's ''' and """. */
  triple: boolean;
  /** JS template literals: `${…}` holds code, which can nest more templates. */
  templates: boolean;
  /** JS regex literals, so a quote or // inside one isn't misread. */
  regex: boolean;
  /** Quotes whose strings have no backslash escapes (Go's raw `…`). */
  raw: string[];
  /** JSX: a `{…}` holding only comments is itself a comment. */
  jsx: boolean;
}

const JS: Syntax = { line: ["//"], hash: false, block: true, quotes: ['"', "'", "`"], triple: false, templates: true, regex: true, raw: [], jsx: false };
const JSX: Syntax = { ...JS, jsx: true };
const C: Syntax = { line: ["//"], hash: false, block: true, quotes: ['"', "'"], triple: false, templates: false, regex: false, raw: [], jsx: false };
const GO: Syntax = { ...C, quotes: ['"', "'", "`"], raw: ["`"] };
const CSS: Syntax = { ...C, line: [] }; // `//` isn't a comment in CSS, and appears in unquoted url(…).
const SCSS: Syntax = { ...C };
const PY: Syntax = { line: [], hash: true, block: false, quotes: ['"', "'"], triple: true, templates: false, regex: false, raw: [], jsx: false };

const BY_EXT: Record<string, Syntax> = {
  ts: JS, tsx: JSX, mts: JS, cts: JS, js: JS, jsx: JSX, mjs: JS, cjs: JS,
  go: GO,
  java: C, c: C, h: C, cc: C, cpp: C, hpp: C, cxx: C,
  css: CSS, scss: SCSS, less: SCSS,
  py: PY,
};

export function syntaxFor(file: string): Syntax | null {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return file.includes(".") ? (BY_EXT[ext] ?? null) : null;
}

/** Characters after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
/** A JSX `{…}` holding nothing but block comments. */
const JSX_COMMENT = /\{\s*(?:\/\*[\s\S]*?\*\/\s*)+\}/y;

const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * The file's text with comments removed (or, with `strip` false, kept) and whitespace
 * normalised outside strings: indentation kept, runs inside a line collapsed to one space,
 * trailing space and blank lines dropped. Strings are copied verbatim.
 */
export function normalize(text: string, syn: Syntax, strip = true): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  let lineStart = true; // only indentation emitted on this line so far
  let stripped = false; // a comment was stripped at the start of this line: the space after it isn't indentation
  let lastSig = ""; // last non-space code character, for regex detection
  // For templates: each entry is the brace depth of a `${` we're inside.
  const braces: number[] = [];

  let tail = ""; // the last few characters emitted, for regex detection after keywords
  const emit = (s: string) => {
    out.push(s);
    tail = (tail + s).slice(-16);
    for (const ch of s) {
      if (ch === "\n") {
        lineStart = true;
        stripped = false;
      } else if (ch !== " " && ch !== "\t") lineStart = false;
    }
  };
  const space = () => {
    const last = out[out.length - 1] ?? "\n";
    if (!lineStart && last !== " " && !last.endsWith("\n")) emit(" ");
  };
  const at = (s: string) => text.startsWith(s, i);

  /** Copy a quoted string starting at i (the opening quote), verbatim. */
  const copyString = (q: string) => {
    const start = i;
    const raw = syn.raw.includes(q);
    i += q.length;
    while (i < n && !at(q)) {
      if (!raw && text[i] === "\\") i += 2;
      else if (q.length === 1 && q !== "`" && text[i] === "\n") break; // unterminated: stop at the line end
      else i++;
    }
    i = Math.min(n, i + q.length);
    emit(text.slice(start, i));
  };

  /** A template literal from i (the backtick), up to its end or a `${`, which hands back to code. */
  const copyTemplate = () => {
    const start = i;
    i++;
    while (i < n) {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "`") {
        i++;
        break;
      } else if (at("${")) {
        i += 2;
        braces.push(0);
        break;
      } else i++;
    }
    emit(text.slice(start, Math.min(i, n)));
  };

  while (i < n) {
    const ch = text[i]!;

    if (ch === "\n") {
      emit("\n");
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (lineStart) {
        if (!stripped && ch !== "\r") emit(ch);
      } else space();
      i++;
      continue;
    }

    // A JSX comment, `{/* … */}`, which only appears as a child: right after a tag's `>`
    // (not an arrow's `=>`) or after another `{…}`. Anywhere else, dropping braces could change code.
    if (syn.jsx && ch === "{" && (lastSig === "}" || (lastSig === ">" && !tail.trimEnd().endsWith("=>")))) {
      JSX_COMMENT.lastIndex = i;
      const m = JSX_COMMENT.exec(text);
      if (m) {
        if (!strip) emit(m[0]);
        else if (lineStart) stripped = true;
        else space();
        i += m[0].length;
        continue;
      }
    }

    // Comments.
    const lineOpener = syn.line.find((o) => at(o)) ?? (syn.hash && ch === "#" ? "#" : undefined);
    if (lineOpener) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      if (strip) space();
      else emit(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (syn.block && at("/*")) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      const body = text.slice(i, stop);
      if (!strip) emit(body);
      // A block comment holding a newline still ends the line (JS's ASI cares).
      else if (body.includes("\n")) {
        emit("\n");
        stripped = true;
      } else if (lineStart) stripped = true;
      else space();
      i = stop;
      continue;
    }

    // Strings.
    if (syn.triple && (at('"""') || at("'''"))) {
      copyString(text.slice(i, i + 3));
      lastSig = "a";
      continue;
    }
    if (syn.templates && ch === "`") {
      copyTemplate();
      lastSig = "a";
      continue;
    }
    if (syn.quotes.includes(ch)) {
      copyString(ch);
      lastSig = "a";
      continue;
    }
    if (syn.templates && braces.length) {
      if (ch === "{") braces[braces.length - 1]!++;
      else if (ch === "}") {
        if (braces[braces.length - 1] === 0) {
          // End of `${…}`: back into the template's text.
          braces.pop();
          emit("}");
          i++;
          const start = i;
          while (i < n) {
            if (text[i] === "\\") i += 2;
            else if (text[i] === "`") {
              i++;
              break;
            } else if (at("${")) {
              i += 2;
              braces.push(0);
              break;
            } else i++;
          }
          emit(text.slice(start, Math.min(i, n)));
          lastSig = "a";
          continue;
        }
        braces[braces.length - 1]!--;
      }
    }
    // A regex literal, unless it's a JSX tag's `</` or `/>`. One that doesn't close on its
    // line isn't a regex after all, so the `/` is copied as a plain character.
    const tag = syn.jsx && (tail.endsWith("<") || text[i + 1] === ">");
    if (syn.regex && ch === "/" && !tag && (REGEX_AFTER.has(lastSig) || REGEX_KEYWORDS.test(tail.trimEnd()))) {
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < n && text[j] !== "\n") {
        const c = text[j]!;
        if (c === "\\") j += 2;
        else {
          j++;
          if (c === "[") cls = true;
          else if (c === "]") cls = false;
          else if (c === "/" && !cls) {
            closed = true;
            break;
          }
        }
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(text[j]!)) j++; // flags
        emit(text.slice(i, j));
        i = j;
        lastSig = "a";
        continue;
      }
    }
    // Outside strings a backslash escapes the next character (line continuations, stray escapes).
    if (ch === "\\" && i + 1 < n && text[i + 1] !== "\n") {
      emit(text.slice(i, i + 2));
      i += 2;
      lastSig = "a";
      continue;
    }

    emit(ch);
    lastSig = ch;
    i++;
  }

  const lines: string[] = [];
  for (const raw of out.join("").split("\n")) {
    const l = raw.trimEnd();
    if (!l.length) continue;
    // Empty braces read the same on one line or two: `{` / `}` and `{}`.
    const prev = lines[lines.length - 1];
    if (prev?.endsWith("{") && l.trimStart().startsWith("}")) lines[lines.length - 1] = prev + l.trimStart();
    else lines.push(l);
  }
  return lines.join("\n");
}

/** True when two versions of a file differ only in comments (and the whitespace around them). */
export function onlyCommentsChanged(before: string, after: string, syn: Syntax): boolean {
  if (before === after) return false;
  if (normalize(before, syn) !== normalize(after, syn)) return false;
  // Something must have changed besides whitespace, and with code equal that's a comment.
  return normalize(before, syn, false) !== normalize(after, syn, false);
}

function git(root: string, args: string[], stdin?: string): Buffer | null {
  const res = Bun.spawnSync(["git", ...args], { cwd: root, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return res.exitCode === 0 ? res.stdout : null;
}

/** Read many blobs in one `git cat-file --batch`; null for any that's missing. */
function readBlobs(root: string, specs: string[]): (string | null)[] {
  if (!specs.length) return [];
  const out = git(root, ["cat-file", "--batch"], specs.map((s) => `${s}\n`).join(""));
  if (!out) return specs.map(() => null);
  const result: (string | null)[] = [];
  let pos = 0;
  for (let k = 0; k < specs.length; k++) {
    const nl = out.indexOf(10, pos);
    if (nl === -1) break;
    const header = out.subarray(pos, nl).toString();
    pos = nl + 1;
    const m = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (!m) {
      result.push(null); // "<spec> missing"
      continue;
    }
    const size = Number(m[2]);
    const body = out.subarray(pos, pos + size);
    pos += size + 1;
    // Binary files aren't comments-only.
    result.push(m[1] === "blob" && !body.includes(0) ? body.toString("utf8") : null);
  }
  while (result.length < specs.length) result.push(null);
  return result;
}

/**
 * The PR's files whose change only touches comments. Empty when the commits can't be
 * fetched; the classifier then sees every file, as before.
 */
export function commentOnlyFiles(root: string, pr: PullRequest, files: FileDiff[]): Set<string> {
  const found = new Set<string>();
  const candidates = files.filter((f) => f.status === "modified" && syntaxFor(f.file) && !/[\n"]/.test(f.file));
  if (!candidates.length) return found;
  if (ensurePrCommits(root, pr)) return found;
  // The diff is base...head, so the "before" side is the merge base.
  const base = git(root, ["merge-base", pr.baseRefOid, pr.headRefOid])?.toString().trim();
  if (!base) return found;

  const blobs = readBlobs(root, candidates.flatMap((f) => [`${base}:${f.file}`, `${pr.headRefOid}:${f.file}`]));
  candidates.forEach((f, k) => {
    const before = blobs[2 * k];
    const after = blobs[2 * k + 1];
    if (before != null && after != null && onlyCommentsChanged(before, after, syntaxFor(f.file)!)) found.add(f.file);
  });
  return found;
}
