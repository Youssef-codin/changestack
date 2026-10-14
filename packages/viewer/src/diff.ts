export type LineKind = "add" | "del" | "ctx" | "hunk";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface ParsedFile {
  file: string;
  status: "added" | "deleted" | "modified" | "renamed";
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

/** Minimal unified-diff parser: enough for `git diff` output. */
export function parseDiff(diff: string): ParsedFile[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  return chunks.map((chunk) => {
    const plus = chunk.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const minus = chunk.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = plus && plus !== "/dev/null" ? plus : (minus ?? header?.[2] ?? "unknown");
    const status: ParsedFile["status"] =
      minus === "/dev/null" ? "added"
      : plus === "/dev/null" ? "deleted"
      : /^rename from /m.test(chunk) ? "renamed"
      : "modified";

    const lines: DiffLine[] = [];
    let oldNo = 0;
    let newNo = 0;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    for (const raw of chunk.split("\n")) {
      const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (hunk) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        inHunk = true;
        lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
        continue;
      }
      if (!inHunk || raw.startsWith("\\")) continue;
      const body = raw.slice(1);
      if (raw.startsWith("+")) {
        lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: body });
        additions++;
      } else if (raw.startsWith("-")) {
        lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: body });
        deletions++;
      } else if (raw.startsWith(" ")) {
        lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: body });
      }
    }
    return { file, status, lines, additions, deletions };
  });
}
