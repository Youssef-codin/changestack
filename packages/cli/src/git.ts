export interface FileDiff {
  file: string;
  status: "added" | "deleted" | "modified" | "renamed";
  text: string;
}

/** Split a unified diff into per-file chunks. */
export function splitDiff(diff: string): FileDiff[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  return chunks.map((text) => {
    const plus = text.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const minus = text.match(/^--- (?:a\/)?(.+)$/m)?.[1];
    const header = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = plus && plus !== "/dev/null" ? plus : (minus ?? header?.[2] ?? "unknown");
    const status =
      minus === "/dev/null" ? "added"
      : plus === "/dev/null" ? "deleted"
      : /^rename from /m.test(text) ? "renamed"
      : "modified";
    return { file, status, text };
  });
}
