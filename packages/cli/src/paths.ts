import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
