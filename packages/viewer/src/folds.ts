import type { DiffLine } from "./diff";

/**
 * A foldable block in a file's diff: `start` stays visible, the lines strictly between
 * `start` and `end` fold away, and `end` (the closing line, or the first line after an
 * indented block) stays visible too. Indexes are into the file's diff lines.
 */
export interface Region {
  start: number;
  end: number;
}

/** Fewest hidden lines worth a fold. */
const MIN_HIDDEN = 2;

/** Blanks out string contents and the trailing comment, so brackets inside them don't count. */
function code(text: string, comment: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (comment && text.startsWith(comment, i)) break;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out += " ".repeat(Math.min(j, text.length) - i + 1);
      i = j;
      continue;
    }
    out += ch;
  }
  return out;
}

const indentOf = (s: string) => s.length - s.trimStart().length;

/**
 * Finds foldable blocks from the diff itself, on the new side (added and unchanged lines;
 * removed lines inside a block fold with it). Brace languages: a line ending in an opener
 * runs to the line that closes it. Indentation languages (comment prefix `#`): a line
 * ending in `:` runs until the indentation comes back. Blocks never cross a hunk header,
 * since the code between hunks isn't in the diff.
 */
export function foldRegions(lines: DiffLine[], comment: string): Region[] {
  const out = new Map<number, Region>();
  const add = (start: number, end: number) => {
    if (end - start - 1 < MIN_HIDDEN) return;
    const prev = out.get(start);
    if (!prev || prev.end < end) out.set(start, { start, end });
  };

  if (comment === "#") {
    // Indentation: open blocks on a stack of (start, indent).
    let stack: { start: number; indent: number }[] = [];
    let last = -1;
    lines.forEach((l, i) => {
      if (l.kind === "hunk") {
        for (const b of stack) add(b.start, last + 1);
        stack = [];
        return;
      }
      if (l.kind === "del" || !l.text.trim()) return;
      const ind = indentOf(l.text);
      while (stack.length && ind <= stack.at(-1)!.indent) add(stack.pop()!.start, i);
      if (/:\s*(#.*)?$/.test(l.text)) stack.push({ start: i, indent: ind });
      last = i;
    });
    for (const b of stack) add(b.start, last + 1);
  } else {
    let stack: number[] = [];
    lines.forEach((l, i) => {
      if (l.kind === "hunk") {
        stack = [];
        return;
      }
      if (l.kind === "del") return;
      const t = code(l.text, comment).trim();
      // Closers at the start of the line end the blocks they close here.
      let j = 0;
      while (j < t.length && ")]}".includes(t[j]!)) {
        const start = stack.pop();
        if (start !== undefined && start >= 0) add(start, i);
        j++;
      }
      let net = 0;
      for (const ch of t.slice(j)) net += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
      // Brackets left open mid-line (`{ a: 1,`) are tracked too, as -1, so their closer doesn't end
      // the enclosing block; only a line that ends in its opener starts a foldable block.
      const foldable = /[([{]$/.test(t);
      for (let k = 0; k < net; k++) stack.push(foldable ? i : -1);
      for (let k = 0; k < -net; k++) stack.pop();
    });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/** One row of a file's diff as drawn: a line, or the "N lines folded" row standing in for a folded block. */
export type DisplayRow = { kind: "line"; index: number; line: DiffLine } | { kind: "fold"; region: Region; hidden: number };

/** The rows to draw for `lines[0..count)`, with folded blocks collapsed to one row each. */
export function displayRows(lines: DiffLine[], count: number, regions: Region[], folded: (start: number) => boolean): DisplayRow[] {
  const byStart = new Map(regions.map((r) => [r.start, r]));
  const out: DisplayRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ kind: "line", index: i, line: lines[i]! });
    const r = byStart.get(i);
    if (r && folded(i)) {
      const end = Math.min(r.end, count);
      out.push({ kind: "fold", region: r, hidden: end - i - 1 });
      i = end - 1;
    }
  }
  return out;
}

/** Top-level blocks: not inside another block. "Fold all" folds these. */
export function outermost(regions: Region[]): Region[] {
  const out: Region[] = [];
  for (const r of regions) if (!out.some((o) => r.start > o.start && r.end <= o.end)) out.push(r);
  return out;
}
