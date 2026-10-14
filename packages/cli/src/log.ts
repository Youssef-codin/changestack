import { appendFileSync } from "node:fs";
import type { IntentEntry } from "@changestack/schema";
import { intentLogPath, repoRoot } from "./paths";

function append(entry: IntentEntry, cwd?: string) {
  appendFileSync(intentLogPath(repoRoot(cwd)), JSON.stringify(entry) + "\n");
}

/**
 * PostToolUse hook: reads the hook payload from stdin and records the file the
 * agent touched. Never fails loudly — a broken hook must not block the agent.
 */
export async function logFromHook(): Promise<void> {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as {
      cwd?: string;
      tool_input?: { file_path?: string; notebook_path?: string };
    };
    const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
    if (!file) return;
    const root = repoRoot(payload.cwd);
    const rel = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;
    append({ ts: new Date().toISOString(), kind: "edit", file: rel }, payload.cwd);
  } catch {
    // swallow: logging is best-effort
  }
}

/** `changestack note [--file path] <text>` — called by the agent to record intent. */
export function note(args: string[]): void {
  let file: string | undefined;
  const i = args.indexOf("--file");
  if (i !== -1) {
    file = args[i + 1];
    args.splice(i, 2);
  }
  const text = args.join(" ").trim();
  if (!text) throw new Error("usage: changestack note [--file <path>] <text>");
  append({ ts: new Date().toISOString(), kind: "note", file, text });
}
