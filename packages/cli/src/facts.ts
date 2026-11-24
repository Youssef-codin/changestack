import type { BriefingFacts } from "@changestack/schema";
import { type PullRequest, prChecks } from "./gh";
import type { FileDiff } from "./git";
import type { Harness } from "./harness";

/** Test files by name: `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, or anything under a tests dir. */
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

/** Re-ask GitHub about CI at most this often, and only while someone is looking. */
const CI_TTL_MS = 30_000;

/** Facts that need no model: the diff's test files and the session's test runs, right away; CI once gh answers. */
export async function gatherFacts(root: string, pr: PullRequest, files: FileDiff[], harness: Harness): Promise<BriefingFacts> {
  const testFiles = files
    .filter((f) => TEST_FILE.test(f.file) && (f.status === "added" || f.status === "modified" || f.status === "renamed"))
    .map((f) => ({ file: f.file, status: f.status === "added" ? ("added" as const) : ("modified" as const) }));
  let testRuns: BriefingFacts["testRuns"] = [];
  try {
    testRuns = harness.testRuns?.({ root, branch: pr.headRefName, files: files.map((f) => f.file) }) ?? [];
  } catch {
    // An unreadable transcript only costs this fact.
  }
  return { ci: await prChecks(root, pr).catch(() => null), testRuns, testFiles };
}

/** Refresh CI in the background when it's stale and not settled, so a pending run turns green or red on its own. */
export function refreshCi(root: string, pr: PullRequest, facts: BriefingFacts, tries: { busy: boolean; at: number }): void {
  if (tries.busy || (facts.ci && facts.ci.state !== "pending") || Date.now() - tries.at < CI_TTL_MS) return;
  tries.busy = true;
  tries.at = Date.now();
  prChecks(root, pr)
    .then((next) => {
      if (next) facts.ci = next;
    })
    .catch(() => {})
    .finally(() => (tries.busy = false));
}
