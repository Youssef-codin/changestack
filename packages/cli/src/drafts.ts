import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Draft, DraftScope, DraftSet } from "@changestack/schema";
import { draftsPath } from "./paths";

/** Default scope for the working tree: the current branch, or the commit when detached. */
export function currentScope(root: string): DraftScope {
  const run = (args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: root });
    return res.exitCode === 0 ? res.stdout.toString().trim() : null;
  };
  const branch = run(["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch) return `branch:${branch}`;
  return `detached:${run(["rev-parse", "--short", "HEAD"]) ?? "unborn"}`;
}

export function loadDrafts(root: string, scope: DraftScope): DraftSet {
  const path = draftsPath(root, scope);
  const empty: DraftSet = { version: 1, scope, drafts: [] };
  if (!existsSync(path)) return empty;
  try {
    const parsed = DraftSet.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.scope === scope ? parsed.data : empty;
  } catch {
    return empty;
  }
}

function save(root: string, set: DraftSet): void {
  const path = draftsPath(root, set.scope);
  // Write then rename so a crash never leaves a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(set, null, 2));
  renameSync(tmp, path);
}

/** Insert or replace drafts by id. */
export function upsertDrafts(root: string, scope: DraftScope, drafts: Draft[]): DraftSet {
  const set = loadDrafts(root, scope);
  const byId = new Map(set.drafts.map((d) => [d.id, d]));
  for (const d of drafts) byId.set(d.id, d);
  const next: DraftSet = { ...set, drafts: [...byId.values()] };
  save(root, next);
  return next;
}

export function deleteDraft(root: string, scope: DraftScope, id: string): DraftSet {
  const set = loadDrafts(root, scope);
  const next: DraftSet = { ...set, drafts: set.drafts.filter((d) => d.id !== id) };
  save(root, next);
  return next;
}
