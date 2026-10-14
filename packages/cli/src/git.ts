const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(root: string, args: string[], allowExit1 = false): string {
  const res = Bun.spawnSync(["git", ...args], { cwd: root });
  // `git diff --no-index` exits 1 when the files differ.
  if (res.exitCode !== 0 && !(allowExit1 && res.exitCode === 1)) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

export function headSha(root: string): string | null {
  const res = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  return res.exitCode === 0 ? res.stdout.toString().trim() : null;
}

/**
 * Diff of the working tree (tracked + untracked) against `base`.
 * Untracked files are diffed against /dev/null so new files show up
 * without touching the index.
 */
export function workingDiff(root: string, base: string): string {
  // A repo with no commits has no HEAD; diff against the empty tree instead.
  if (base === "HEAD" && headSha(root) === null) base = EMPTY_TREE;
  const tracked = git(root, ["diff", "--no-color", "--no-ext-diff", base]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((file) => git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], true));
  return [tracked, ...untracked].filter(Boolean).join("");
}

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
