import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function repoRoot(cwd = process.cwd()): string {
  const res = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (res.exitCode !== 0) throw new Error(`not a git repository: ${cwd}`);
  return res.stdout.toString().trim();
}

export function stateDir(root: string): string {
  const dir = join(root, ".changestack");
  mkdirSync(join(dir, "review"), { recursive: true });
  return dir;
}

export const intentLogPath = (root: string) => join(stateDir(root), "intent.jsonl");
export const reviewPath = (root: string, name: string) => join(stateDir(root), "review", `${name}.json`);

/**
 * `.git/changestack/`: state that should survive restarts but never be
 * committed (drafts, and anything else private to this clone).
 * Uses the common git dir, so every worktree of a repo shares it; key files
 * by branch or PR inside it. Pass `sub` to get (and create) a subdirectory.
 */
export function gitStateDir(root: string, ...sub: string[]): string {
  const res = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: root });
  if (res.exitCode !== 0) throw new Error(`not a git repository: ${root}`);
  const dir = join(resolve(root, res.stdout.toString().trim()), "changestack", ...sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Drafts for one scope (`branch:<name>`, later `pr:<n>`). The scope is encoded so `/` in branch names is safe. */
export const draftsPath = (root: string, scope: string) =>
  join(gitStateDir(root, "drafts"), `${encodeURIComponent(scope)}.json`);
