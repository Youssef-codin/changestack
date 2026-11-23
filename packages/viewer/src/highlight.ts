/**
 * A deliberately small highlighter, one line at a time, colored as Catppuccin colors code:
 * keywords mauve, strings green, comments overlay, functions blue, types yellow,
 * numbers and literals peach, operators sky, punctuation overlay2.
 * Returns escaped HTML. Good enough to read a diff by; not a parser.
 */

const KEYWORDS = new Set(
  (
    // JS / TS
    "import from export default async function const let var await return if else for while do new class interface type " +
    "extends implements enum switch case break continue try catch finally throw yield in of as static public private protected " +
    "readonly typeof instanceof void delete keyof satisfies declare abstract get set " +
    // Go
    "package func go defer chan map range struct select fallthrough goto " +
    // Rust / Python / misc
    "fn pub impl match mut use mod where def elif lambda with pass raise and or not is"
  ).split(" "),
);

/** Language literals and the receiver words, colored like numbers. */
const LITERALS = new Set("true false null undefined nil None True False this self super iota".split(" "));

/** Line-comment prefix by file extension; files not listed get `//`. */
const COMMENT: Record<string, string> = {
  py: "#", rb: "#", sh: "#", bash: "#", zsh: "#", yml: "#", yaml: "#", toml: "#", nix: "#", mod: "//",
  sql: "--", lua: "--", hs: "--",
  md: "", json: "", lock: "", txt: "", css: "", html: "", sum: "",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;

export function commentPrefix(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return COMMENT[ext] ?? "//";
}

const WORD = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;
const OPERATOR = /^(?:=>|:=|<-|\.\.\.|[=!<>]=?=?|&&|\|\||\?\?|[+\-*/%&|^~!?]=?|<<|>>)/;
const PUNCT = /^[()[\]{}.,;:]/;

export function highlight(text: string, comment: string): string {
  if (text.length > 2000) return esc(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 80);
    const ch = text[i]!;
    if (comment && text.startsWith(comment, i)) {
      out += span("text-com italic", text.slice(i));
      break;
    }
    // Block-comment lines (` * like this`, `/* ... */`) read as comments too.
    if (i === 0 && /^\s*(\/\*|\*\/|\*(\s|$))/.test(text) && comment === "//") {
      out += span("text-com italic", text);
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out += span("text-str", text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const word = WORD.exec(rest)?.[0];
    if (word) {
      const next = text.slice(i + word.length).trimStart()[0];
      const cls = KEYWORDS.has(word)
        ? "text-kw"
        : LITERALS.has(word)
          ? "text-lit"
          : next === "("
            ? "text-fn"
            : /^[A-Z]/.test(word)
              ? "text-ty"
              : "";
      out += cls ? span(cls, word) : esc(word);
      i += word.length;
      continue;
    }
    const num = NUMBER.exec(rest)?.[0];
    if (num) {
      out += span("text-num", num);
      i += num.length;
      continue;
    }
    const op = OPERATOR.exec(rest)?.[0];
    if (op) {
      out += span("text-op", op);
      i += op.length;
      continue;
    }
    if (PUNCT.test(ch)) {
      out += span("text-punc", ch);
      i++;
      continue;
    }
    out += esc(ch);
    i++;
  }
  return out;
}
