import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTestRuns } from "./claude-code-transcripts";

const tmp = mkdtempSync(join(tmpdir(), "changestack-transcripts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A repo dir (not a git repo, so only `root` itself counts) and a session in its project dir. */
function fixture(lines: object[]) {
  const root = join(tmp, "repo");
  mkdirSync(root, { recursive: true });
  const projects = join(tmp, "config", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "s1.jsonl"), lines.map((l) => JSON.stringify({ gitBranch: "feat", timestamp: "2026-11-01T10:00:00Z", ...l })).join("\n"));
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "config");
  return root;
}

const user = (text: string) => ({ type: "user", message: { content: text } });
const bash = (id: string, command: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id: string, is_error: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: "out" }] } });

test("test runs carry the user turn they followed and whether they passed", () => {
  const root = fixture([
    user("build the thing"),
    bash("a", "bun test"),
    result("a", true),
    user("<system-reminder>noise</system-reminder>"),
    user("fix it"),
    bash("b", "cd packages/cli && bun run typecheck"),
    result("b", false),
    bash("c", "git commit -m 'run bun test later'"),
    result("c", false),
    bash("d", "bun test src"),
    result("d", false),
    { ...bash("e", "bun test"), gitBranch: "other" },
  ]);
  const runs = sessionTestRuns({ root, branch: "feat" });
  expect(runs.map(({ command, kind, ok, turn }) => ({ command, kind, ok, turn }))).toEqual([
    { command: "bun test", kind: "test", ok: false, turn: 1 },
    { command: "cd packages/cli && bun run typecheck", kind: "check", ok: true, turn: 2 },
    { command: "bun test src", kind: "test", ok: true, turn: 2 },
  ]);
  expect(runs[0]!.session).toBe("2026-11-01T10:00:00Z");
});

test("sessions from a removed worktree named after the repo's first word still count", () => {
  const root = join(tmp, "acme-app");
  mkdirSync(root, { recursive: true });
  const projects = join(tmp, "config", "projects");
  for (const [dir, branch] of [["acme-day", "feat"], ["acmeother", "feat"], ["acme-night", "other"]] as const) {
    const d = join(projects, join(tmp, dir).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s.jsonl"), [user("go"), bash(dir, "bun test"), result(dir, false)].map((l) => JSON.stringify({ gitBranch: branch, timestamp: `t-${dir}`, ...l })).join("\n"));
  }
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "config");
  expect(sessionTestRuns({ root, branch: "feat" }).map((r) => r.session)).toEqual(["t-acme-day"]);
});
