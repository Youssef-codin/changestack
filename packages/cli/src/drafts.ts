import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Draft, DraftScope, DraftSet } from "@changestack/schema";
import { draftsPath } from "./paths";

export const prScope = (pr: number): DraftScope => `pr:${pr}`;

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

/** Remove several drafts at once (after they were posted). Drafts added meanwhile survive. */
export function removeDrafts(root: string, scope: DraftScope, ids: Set<string>): DraftSet {
  const set = loadDrafts(root, scope);
  const next: DraftSet = { ...set, drafts: set.drafts.filter((d) => !ids.has(d.id)) };
  save(root, next);
  return next;
}

export function deleteDraft(root: string, scope: DraftScope, id: string): DraftSet {
  const set = loadDrafts(root, scope);
  const next: DraftSet = { ...set, drafts: set.drafts.filter((d) => d.id !== id) };
  save(root, next);
  return next;
}
