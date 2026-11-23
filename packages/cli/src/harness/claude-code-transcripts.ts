import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TestRun } from "@changestack/schema";
import type { SessionContext, SessionContextRequest, TestRunsRequest } from "./index";

/**
 * Reads Claude Code session transcripts (`~/.claude/projects/<encoded cwd>/<session>.jsonl`)
 * and boils them down to what helps a classifier: what the agent said, which files it
 * edited, test runs that failed, tests it skipped, and edits the user rejected.
 *
 * Matching: a session belongs to the PR when it ran in this repo (the main checkout, any
 * worktree, or a sibling dir named `<repo>-*`, which is how removed worktrees usually
 * looked) and its entries carry the PR's head branch as `gitBranch`.
 */

/** Newest sessions considered per PR. */
const MAX_SESSIONS = 5;
/** Longest single snippet of agent text. */
const MAX_SNIPPET = 600;

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** Claude Code names a project dir after its cwd with every non-alphanumeric char turned into `-`. */
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

function worktrees(root: string): string[] {
  const res = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: root });
  const paths = res.exitCode === 0
    ? res.stdout.toString().split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))
    : [];
  return [...new Set([root, ...paths])];
}

/** Transcript files for `branch`, newest first. */
export function findTranscripts(root: string, branch: string): { file: string; roots: string[] }[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  const trees = worktrees(root);
  const prefixes = trees.map(encode);
  // Removed worktrees are often named after the repo's first word, not its full name
  // (`lustre-day` beside `lustre-clinic`); the gitBranch check below keeps this narrow.
  const parent = root.slice(0, root.lastIndexOf("/"));
  const stem = root.slice(parent.length + 1).split("-")[0]!;
  if (stem && stem !== root.slice(parent.length + 1)) prefixes.push(encode(`${parent}/${stem}`));
  const dirs = readdirSync(dir).filter((name) => prefixes.some((p) => name === p || name.startsWith(`${p}-`)));

  const files = dirs.flatMap((d) =>
    readdirSync(join(dir, d))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, d, f)),
  );
  return files
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .filter(({ file }) => readFileSync(file, "utf8").includes(`"gitBranch":${JSON.stringify(branch)}`))
    .slice(0, MAX_SESSIONS)
    .map(({ file }) => ({ file, roots: trees }));
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown };

interface Entry {
  type?: string;
  isSidechain?: boolean;
  /** `sdk-cli` marks headless `claude -p` calls (e.g. changestack's own); never the agent's real work. */
  entrypoint?: string;
  gitBranch?: string;
  cwd?: string;
  timestamp?: string;
  message?: { content?: string | Block[] };
}

/** One piece of evidence, with a score so the budget keeps the most telling ones. */
interface Snippet {
  order: number;
  score: number;
  text: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** A test or type-check run, matched at the start of a `&&`/`;`/`|` segment so commit messages and heredocs don't count. */
const TEST_SEGMENT =
  /^\s*(?:\w+=\S+\s+)*(?:(?:bun|npm|pnpm|yarn|npx|bunx)\s+(?:run\s+)?(?:test|typecheck|check|lint)\b|(?:jest|vitest|pytest|mocha|tsc|playwright\s+test)\b|(?:cargo|go)\s+test\b|python3?\s+-m\s+(?:pytest|unittest)\b)/i;
/** Shell commands that write a file they name. */
const SHELL_WRITE = /(>\s*\S|\bsed\s+-i|\btee\b|\.write\(|open\([^)]*['"]w|\bpatch\b|\bgit\s+mv\b|\bmv\b|\bcp\b|\brm\b)/;
/** User messages that are harness noise rather than something the user typed. */
const NOISE = /^\s*<(command-|local-command|system-reminder|bash-|task-notification)/;

function isTestRun(cmd: string): boolean {
  const head = cmd.split("<<")[0]!;
  return head.split(/&&|\|\||;|\|/).some((seg) => TEST_SEGMENT.test(seg));
}
/** A run that executes tests, as opposed to only type-checking or linting. */
const RUNS_TESTS = /\b(test|jest|vitest|pytest|mocha|unittest)\b/i;
const SKIP_IN_CODE = /\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe)\(|@(pytest\.mark\.)?skip\b|#\[ignore\]|t\.Skip\(/;
const TELLING =
  /\b(not sure|unsure|uncertain|guess|assum|probably|might|unclear|workaround|hack|todo|skip|instead|revert|abandon|give up|gave up|fall ?back|for now|temporar|doesn'?t work|didn'?t work|couldn'?t|can'?t|fail|broke|flaky|deviat|out of scope)/i;

const clip = (s: string, n = MAX_SNIPPET) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function relTo(file: string, roots: string[], changed: Set<string>): string {
  const root = roots.filter((r) => file.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (root) return file.slice(root.length + 1);
  // A removed worktree: match the longest changed path the absolute path ends with.
  const hit = [...changed].filter((f) => file.endsWith(`/${f}`)).sort((a, b) => b.length - a.length)[0];
  return hit ?? file;
}

function readSession(file: string, roots: string[], branch: string, changed: Set<string>) {
  const snippets: Snippet[] = [];
  const edited = new Set<string>();
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  let order = 0;
  let started: string | undefined;
  /** User prompts seen so far: the turn a test run belongs to. */
  let turn = 0;
  const runs: Omit<TestRun, "session">[] = [];
  // Shell commands often name a file relative to a subdirectory; trust a bare basename only when it's unambiguous.
  const base = (f: string) => f.split("/").pop()!;
  const counts = new Map<string, number>();
  for (const f of changed) counts.set(base(f), (counts.get(base(f)) ?? 0) + 1);
  const uniqueBase = new Set([...counts].filter(([, n]) => n === 1).map(([b]) => b));

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain || e.entrypoint === "sdk-cli" || e.gitBranch !== branch) continue;
    if (e.type !== "user" && e.type !== "assistant") continue;
    started ??= e.timestamp;
    const content = e.message?.content;

    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

    for (const b of blocks) {
      if (b.type === "text" && e.type === "user") {
        // The user's own prompts frame everything else; harness noise is skipped.
        if (!NOISE.test(b.text)) {
          turn++;
          snippets.push({ order: order++, score: 4, text: `User asked: ${clip(b.text, 400)}` });
        }
      } else if (b.type === "text" && e.type === "assistant") {
        snippets.push({ order: order++, score: TELLING.test(b.text) ? 3 : 1, text: `Agent: ${clip(b.text)}` });
      } else if (b.type === "thinking" && b.thinking) {
        // Usually redacted; when present it's the best evidence of guessing.
        snippets.push({ order: order++, score: TELLING.test(b.thinking) ? 3 : 1, text: `Agent reasoning: ${clip(b.thinking)}` });
      } else if (b.type === "tool_use") {
        pending.set(b.id, { name: b.name, input: b.input });
        const path = typeof b.input.file_path === "string" ? b.input.file_path : typeof b.input.notebook_path === "string" ? b.input.notebook_path : null;
        if (b.name === "Bash" && typeof b.input.command === "string" && SHELL_WRITE.test(b.input.command)) {
          const cmd = b.input.command;
          for (const f of changed) if (cmd.includes(f) || (uniqueBase.has(base(f)) && cmd.includes(base(f)))) edited.add(f);
        }
        if (EDIT_TOOLS.has(b.name) && path) {
          const rel = relTo(path, roots, changed);
          edited.add(rel);
          const code = JSON.stringify(b.input.new_string ?? b.input.content ?? b.input.edits ?? "");
          if (SKIP_IN_CODE.test(code)) snippets.push({ order: order++, score: 5, text: `Agent added a skipped/todo test in ${rel}` });
        }
      } else if (b.type === "tool_result") {
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        if (EDIT_TOOLS.has(call.name) && /doesn't want to proceed|rejected/i.test(out)) {
          const path = String(call.input.file_path ?? call.input.notebook_path ?? "?");
          snippets.push({ order: order++, score: 5, text: `User rejected an edit to ${relTo(path, roots, changed)} (approach abandoned)` });
        } else if (call.name === "Bash" && isTestRun(String(call.input.command ?? ""))) {
          const cmd = clip(String(call.input.command), 160);
          runs.push({ command: cmd, kind: RUNS_TESTS.test(cmd) ? "test" : "check", ok: !b.is_error, turn, at: e.timestamp ?? null });
          if (b.is_error) snippets.push({ order: order++, score: 4, text: `Failed: \`${cmd}\` → ${clip(out, 300)}` });
          else if (/\bskip(ped)?\b/i.test(out)) snippets.push({ order: order++, score: 4, text: `Reported skips: \`${cmd}\` → ${clip(out, 200)}` });
          else snippets.push({ order: order++, score: 2, text: `Passed: \`${cmd}\`` });
        }
      }
    }
  }

  const touched = [...edited].filter((f) => changed.has(f)).sort();
  return { snippets, touched, started, runs };
}

/**
 * Fit the most telling snippets into `budget` chars: rank by score, then recency,
 * and print the survivors in the order they happened.
 */
function fit(snippets: Snippet[], budget: number): Snippet[] {
  const ranked = [...snippets].sort((a, b) => b.score - a.score || b.order - a.order);
  const kept: Snippet[] = [];
  let used = 0;
  for (const s of ranked) {
    if (used + s.text.length + 3 > budget) continue;
    kept.push(s);
    used += s.text.length + 3;
  }
  return kept.sort((a, b) => a.order - b.order);
}

export function sessionContext(req: SessionContextRequest): SessionContext | null {
  if (req.budget <= 0) return null;
  const found = findTranscripts(req.root, req.branch);
  if (found.length === 0) return null;

  const changed = new Set(req.files);
  const perSession = Math.floor(req.budget / found.length);
  const parts: string[] = [];
  const touchedAll = new Set<string>();
  const sources: string[] = [];

  // Oldest first, so the model reads the work in the order it happened.
  for (const { file, roots } of [...found].reverse()) {
    const { snippets, touched, started } = readSession(file, roots, req.branch, changed);
    if (snippets.length === 0 && touched.length === 0) continue;
    touched.forEach((f) => touchedAll.add(f));
    sources.push(file);
    const kept = fit(snippets, perSession);
    const dropped = snippets.length - kept.length;
    parts.push(
      [
        `<session started="${started ?? "?"}"${dropped ? ` omitted="${dropped} less relevant entries"` : ""}>`,
        ...kept.map((s) => `- ${s.text}`),
        "</session>",
      ].join("\n"),
    );
  }
  if (sources.length === 0) return null;

  const untouched = req.files.filter((f) => !touchedAll.has(f));
  const header = [
    `Files the agent edited in these sessions: ${[...touchedAll].sort().join(", ") || "(none of the changed files)"}`,
    untouched.length ? `Changed files with no edit seen in these sessions (possibly written by a human, another tool, or an earlier session): ${untouched.join(", ")}` : "",
  ].filter(Boolean);
  return { text: [...header, "", ...parts].join("\n"), sources };
}

/** Every test, type-check and lint run in the PR's sessions, oldest first. */
export function sessionTestRuns(req: TestRunsRequest): TestRun[] {
  return [...findTranscripts(req.root, req.branch)].reverse().flatMap(({ file, roots }) => {
    const { runs, started } = readSession(file, roots, req.branch, new Set());
    return runs.map((r) => ({ ...r, session: started ?? "?" }));
  });
}
