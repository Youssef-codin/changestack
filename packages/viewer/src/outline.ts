import type { DiffLine } from "./diff";
import type { Region } from "./folds";

/** One entry in a file's "In this file" list: a declaration whose block the diff changes. */
export interface OutlineItem {
  kind: string;
  name: string;
  /** Index of the declaration's first line in the file's diff lines. */
  index: number;
  /** End of its block (exclusive), as in Region. */
  end: number;
  /** Line number to show and jump to. */
  side: "old" | "new";
  line: number;
  /** How many listed declarations it sits inside (a method in a class is 1). */
  depth: number;
}

/** Declaration openers, tried in order: [pattern with the name in group 1, label]. */
const DECLS: [RegExp, string][] = [
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "func"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)/, "func"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "const"],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "def"],
  [/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, "class"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, "fn"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait|impl(?:<[^>]*>)?)\s+([A-Za-z_][\w:<>]*)/, "type"],
  [/^\s*(?:describe|it|test)(?:\.\w+)?\(\s*["'`]([^"'`]+)/, "test"],
  [/^\s*import\s*\(/, "import"],
  // A method: `name(args) {` or `async name(...): T {`, not a control-flow keyword.
  [/^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*(?!(?:if|for|while|switch|catch|return|else|do|with)\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::[^{]*)?\{?\s*$/, "method"],
];

export function declOf(text: string): { kind: string; name: string } | null {
  for (const [re, kind] of DECLS) {
    const m = re.exec(text);
    if (m) return { kind, name: m[1] ?? "imports" };
  }
  return null;
}

/**
 * The declarations this diff changes, in file order, from the file's foldable blocks: a block
 * is listed when its first line reads as a declaration and some line inside it was added or
 * removed. Nested ones (methods in a class) are listed under their parent.
 */
export function outlineOf(lines: DiffLine[], regions: Region[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const r of regions) {
    const first = lines[r.start];
    if (!first || first.kind === "hunk") continue;
    const d = declOf(first.text);
    if (!d) continue;
    let changed = false;
    for (let i = r.start; i < r.end && i < lines.length && !changed; i++) changed = lines[i]!.kind === "add" || lines[i]!.kind === "del";
    if (!changed) continue;
    const side = first.kind === "del" ? "old" : "new";
    const line = (side === "old" ? first.oldNo : first.newNo) ?? 0;
    const depth = out.filter((o) => o.index < r.start && r.start < o.end).length;
    out.push({ ...d, index: r.start, end: r.end, side, line, depth });
  }
  return out;
}
