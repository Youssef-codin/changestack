import { z } from "zod";
import type { Harness, RunJsonRequest, RunJsonResult } from "./index";

const TIMEOUT_MS = 5 * 60_000;

/**
 * Isolation flags, settled by the headless spike (Claude Code 2.1.319):
 * - `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`: don't load the
 *   user's CLAUDE.md, MCP servers, skills or hooks. Without them the call carried ~136K tokens
 *   of context and fired the user's SessionStart/Stop hooks.
 * - `--no-session-persistence`: keep the call out of ~/.claude/projects/, so it never shows up
 *   in the user's history or in changestack's own transcript reads.
 * `--bare` would also isolate, but it requires ANTHROPIC_API_KEY and drops OAuth.
 */
const ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];

/** The subset of `claude -p --output-format json` we rely on. */
const CliResult = z.object({
  is_error: z.boolean(),
  subtype: z.string(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

async function runOnce<T>(req: RunJsonRequest<T>, model: string, jsonSchema: string): Promise<RunJsonResult<T>> {
  const argv = [
    "claude", "-p",
    "--model", model,
    "--tools", "",
    "--output-format", "json",
    "--json-schema", jsonSchema,
    "--system-prompt", req.system,
    ...ISOLATION,
  ];

  let proc: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    // Prompt goes on stdin: no argv length limit, and no 3s "no stdin" wait.
    proc = Bun.spawn(argv, { stdin: new Blob([req.prompt]), stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new FatalHarnessError("`claude` not found on PATH. Install Claude Code: https://claude.com/claude-code");
    }
    throw err;
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (proc.signalCode) throw new Error(`claude -p was killed (${proc.signalCode}) after ${TIMEOUT_MS / 1000}s`);

  let parsed: z.infer<typeof CliResult>;
  try {
    parsed = CliResult.parse(JSON.parse(stdout));
  } catch {
    const detail = (stderr || stdout).trim().slice(0, 500) || "(no output)";
    throw new Error(`claude -p exited ${code} without a JSON result: ${detail}`);
  }

  if (parsed.is_error || parsed.subtype !== "success") {
    throw new Error(`claude -p failed (${parsed.subtype}): ${(parsed.result ?? stderr).trim().slice(0, 500)}`);
  }

  // structured_output is set when --json-schema is honoured; fall back to the text result.
  let raw = parsed.structured_output;
  if (raw === undefined && parsed.result) {
    try {
      raw = JSON.parse(parsed.result);
    } catch {
      throw new Error("claude -p returned text that is not JSON");
    }
  }

  const checked = req.schema.safeParse(raw);
  if (!checked.success) throw new Error(`output failed schema validation: ${z.prettifyError(checked.error)}`);

  const used = Object.keys(parsed.modelUsage ?? {});
  return { data: checked.data, model: used[0] ?? model };
}

/** Errors that a retry can't fix. */
class FatalHarnessError extends Error {}

export const claudeCode: Harness = {
  name: "claude-code",
  defaultModel: "haiku",

  async runJson<T>(req: RunJsonRequest<T>): Promise<RunJsonResult<T>> {
    const model = req.model ?? this.defaultModel;
    // claude rejects zod's draft 2020-12 `$schema` URI ("no schema with key or ref"), so drop it.
    const { $schema: _, ...schema } = z.toJSONSchema(req.schema);
    const jsonSchema = JSON.stringify(schema);
    try {
      return await runOnce(req, model, jsonSchema);
    } catch (first) {
      if (first instanceof FatalHarnessError) throw first;
      try {
        return await runOnce(req, model, jsonSchema);
      } catch (second) {
        const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
        throw new Error(`claude -p failed twice. First: ${msg(first)} Second: ${msg(second)}`);
      }
    }
  },
};
