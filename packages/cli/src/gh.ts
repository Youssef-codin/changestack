/** Thin wrapper over the GitHub CLI. Everything here reads from GitHub; nothing touches the working tree. */

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
}

const PR_FIELDS = "number,title,url,baseRefName,headRefName,headRefOid,isDraft";

export class GhError extends Error {}

let checked = false;

/** Fail early, with an actionable message, when `gh` is missing or logged out. */
export function requireGh(): void {
  if (checked) return;
  if (!Bun.which("gh")) {
    throw new GhError("GitHub CLI `gh` not found on PATH; install it from https://cli.github.com and run `gh auth login`");
  }
  const res = Bun.spawnSync(["gh", "auth", "status"], { stdout: "ignore", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new GhError("GitHub CLI is not logged in; run `gh auth login`");
  }
  checked = true;
}

function gh(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  requireGh();
  const res = Bun.spawnSync(["gh", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, stdout: res.stdout.toString(), stderr: res.stderr.toString().trim() };
}

function ghOrThrow(root: string, args: string[]): string {
  const res = gh(root, args);
  if (!res.ok) throw new GhError(`gh ${args[0]} ${args[1] ?? ""} failed: ${res.stderr || "unknown error"}`.trim());
  return res.stdout;
}

const PR_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/;

/** A PR number (`123`, `#123`) or URL, as `gh pr` accepts it; null if `arg` is neither. */
export function parsePrTarget(arg: string): string | null {
  const num = arg.match(/^#?(\d+)$/)?.[1];
  if (num) return num;
  const url = arg.match(PR_URL);
  // Strip trailing /files, query strings etc. so gh gets a URL it recognises.
  if (url) return arg.slice(0, arg.indexOf(`/pull/${url[1]}`)) + `/pull/${url[1]}`;
  return null;
}

/** Look up one PR by number or URL. */
export function viewPr(root: string, target: string): PullRequest {
  const res = gh(root, ["pr", "view", target, "--json", PR_FIELDS]);
  if (!res.ok) {
    if (/could not resolve|not found/i.test(res.stderr)) throw new GhError(`no pull request ${target}`);
    throw new GhError(`gh pr view ${target} failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout) as PullRequest;
}

/** The PR for the current branch, or null if it has none. */
export function currentBranchPr(root: string): PullRequest | null {
  const res = gh(root, ["pr", "view", "--json", PR_FIELDS]);
  if (res.ok) return JSON.parse(res.stdout) as PullRequest;
  // gh says "no pull requests found for branch …" (or errors on a detached HEAD).
  if (/no (open )?pull requests? found|not on any branch|detached/i.test(res.stderr)) return null;
  throw new GhError(`gh pr view failed: ${res.stderr}`);
}

export function openPrs(root: string, limit = 30): PullRequest[] {
  return JSON.parse(ghOrThrow(root, ["pr", "list", "--state", "open", "--limit", String(limit), "--json", PR_FIELDS])) as PullRequest[];
}

/** Unified diff of a PR straight from GitHub; no checkout. */
export function prDiff(root: string, pr: PullRequest): string {
  return ghOrThrow(root, ["pr", "diff", String(pr.number), "--color", "never"]);
}

function label(pr: PullRequest): string {
  return `#${pr.number} ${pr.title}${pr.isDraft ? " (draft)" : ""}  [${pr.headRefName} → ${pr.baseRefName}]`;
}

/** Ask the user to choose among open PRs. Needs a TTY; otherwise lists them and fails. */
export function pickPr(root: string): PullRequest {
  const prs = openPrs(root);
  if (prs.length === 0) throw new GhError("current branch has no pull request, and the repository has no open ones");
  const list = prs.map((pr, i) => `  ${String(i + 1).padStart(2)}. ${label(pr)}`).join("\n");

  if (!process.stdin.isTTY) {
    throw new GhError(`current branch has no pull request; pass one of these:\n${list}`);
  }
  console.error(`changestack: current branch has no pull request. Open PRs:\n${list}`);
  for (;;) {
    const answer = prompt("Pick a PR (number in list, or #PR):")?.trim();
    if (!answer) throw new GhError("no pull request selected");
    const byPr = answer.match(/^#(\d+)$/)?.[1];
    const pick = byPr
      ? prs.find((pr) => pr.number === Number(byPr))
      : /^\d+$/.test(answer) ? prs[Number(answer) - 1] : undefined;
    if (pick) return pick;
    console.error(`changestack: "${answer}" is not in the list`);
  }
}

/**
 * Resolve which PR to review: an explicit number/URL, else the current
 * branch's PR, else an interactive pick from the open PRs.
 */
export function resolvePr(root: string, target?: string): PullRequest {
  if (target !== undefined) {
    const ref = parsePrTarget(target);
    if (!ref) throw new GhError(`not a PR number or URL: ${target}`);
    return viewPr(root, ref);
  }
  return currentBranchPr(root) ?? pickPr(root);
}

export const describePr = label;
