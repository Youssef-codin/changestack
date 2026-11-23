import type { Parser, Tree } from "@lezer/common";
import type { DiffLine } from "./diff";
import { foldRegions as guessRegions, type Region } from "./folds";
import { commentPrefix } from "./highlight";
import { type Def, defsIn, guessDefs, type ParsedHunk } from "./definitions";

/**
 * Folding from a real parse. Each language's Lezer grammar (the parsers behind CodeMirror) is
 * loaded on first use. A fold starting on a line covers the largest syntax node that begins on
 * that line, so `func Name(` folds the whole function, signature through closing brace, and
 * `import (` folds the import block. Languages without a grammar fall back to the bracket and
 * indentation guess in folds.ts.
 */

type Loader = () => Promise<Parser>;

const js = (dialect: string): Loader => () => import("@lezer/javascript").then((m) => m.parser.configure({ dialect }));

const GRAMMARS: Record<string, Loader> = {
  go: () => import("@lezer/go").then((m) => m.parser),
  ts: js("ts"),
  mts: js("ts"),
  cts: js("ts"),
  tsx: js("ts jsx"),
  js: js("jsx"),
  mjs: js("jsx"),
  cjs: js("jsx"),
  jsx: js("jsx"),
  py: () => import("@lezer/python").then((m) => m.parser),
  rs: () => import("@lezer/rust").then((m) => m.parser),
  java: () => import("@lezer/java").then((m) => m.parser),
  c: () => import("@lezer/cpp").then((m) => m.parser),
  h: () => import("@lezer/cpp").then((m) => m.parser),
  cc: () => import("@lezer/cpp").then((m) => m.parser),
  cpp: () => import("@lezer/cpp").then((m) => m.parser),
  hpp: () => import("@lezer/cpp").then((m) => m.parser),
  css: () => import("@lezer/css").then((m) => m.parser),
  json: () => import("@lezer/json").then((m) => m.parser),
  html: () => import("@lezer/html").then((m) => m.parser),
  yml: () => import("@lezer/yaml").then((m) => m.parser),
  yaml: () => import("@lezer/yaml").then((m) => m.parser),
};

const loaded = new Map<string, Promise<Parser>>();
function grammarFor(file: string): Promise<Parser> | null {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const load = GRAMMARS[ext];
  if (!load) return null;
  if (!loaded.has(ext)) loaded.set(ext, load());
  return loaded.get(ext)!;
}

/** Fewest hidden lines worth a fold. */
const MIN_HIDDEN = 2;

/** Closing lines stay visible under a fold (`}`, `)`, `]`, `</div>`); anything else folds too. */
const CLOSER = /^\s*([)}\]]|<\/|end\b)/;

/** Split into hunks of one side's lines (removed lines skipped for "new", added for "old") and parse each. */
function parseHunks(parser: Parser, lines: DiffLine[], side: "old" | "new"): ParsedHunk[] {
  const skip = side === "new" ? "del" : "add";
  const hunks: number[][] = [];
  let cur: number[] = [];
  lines.forEach((l, i) => {
    if (l.kind === "hunk") {
      if (cur.length) hunks.push(cur);
      cur = [];
    } else if (l.kind !== skip) cur.push(i);
  });
  if (cur.length) hunks.push(cur);

  const out: ParsedHunk[] = [];
  for (const idx of hunks) {
    // The old side only matters where something was removed.
    if (side === "old" && !idx.some((i) => lines[i]!.kind === "del")) continue;
    const text = idx.map((i) => lines[i]!.text).join("\n");
    const starts: number[] = [];
    let at = 0;
    for (const i of idx) {
      starts.push(at);
      at += lines[i]!.text.length + 1;
    }
    const lineOf = (pos: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    let tree: Tree;
    try {
      tree = parser.parse(text);
    } catch {
      continue;
    }
    out.push({ tree, text, idx, lineOf, starts });
  }
  return out;
}

/**
 * Foldable blocks for one file's diff. The new side of each hunk (added and unchanged lines)
 * is parsed on its own, since the code between hunks isn't in the diff; removed lines inside a
 * block fold with it. Indexes are into `lines`.
 */
function regionsIn(hunks: ParsedHunk[], lines: DiffLine[]): Region[] {
  const best = new Map<number, number>(); // start index → end index (exclusive of hidden range)
  for (const { tree, idx, lineOf } of hunks) {
    tree.iterate({
      enter(node) {
        if (node.type.isTop || node.type.isError) return;
        const first = lineOf(node.from);
        // A node's last line: where its last character sits (to - 1), skipping a trailing newline.
        const last = lineOf(Math.max(node.from, node.to - 1));
        if (last <= first) return;
        const startIdx = idx[first]!;
        const lastIdx = idx[last]!;
        const end = CLOSER.test(lines[lastIdx]!.text) ? lastIdx : lastIdx + 1;
        if ((best.get(startIdx) ?? -1) < end) best.set(startIdx, end);
      },
    });
  }

  const regions: Region[] = [];
  for (const [start, end] of best) {
    // Count only the hidden lines that are part of the code (not removed lines) toward the minimum.
    let hidden = 0;
    for (let i = start + 1; i < end && i < lines.length; i++) if (lines[i]!.kind !== "del") hidden++;
    if (hidden >= MIN_HIDDEN) regions.push({ start, end: Math.min(end, lines.length) });
  }
  return regions.sort((a, b) => a.start - b.start);
}

/** One file's foldable blocks and the definitions in its diff, from one parse per side. */
export async function syntaxFor(file: string, lines: DiffLine[]): Promise<{ regions: Region[]; defs: Def[] }> {
  const guess = () => ({ regions: guessRegions(lines, commentPrefix(file)), defs: guessDefs(file, lines) });
  const grammar = grammarFor(file);
  if (!grammar) return guess();
  let parser: Parser;
  try {
    parser = await grammar;
  } catch {
    return guess();
  }
  const fresh = parseHunks(parser, lines, "new");
  const removed = parseHunks(parser, lines, "old");
  return {
    regions: regionsIn(fresh, lines),
    defs: [...fresh.flatMap((h) => defsIn(file, h, "new", lines)), ...removed.flatMap((h) => defsIn(file, h, "old", lines))],
  };
}
