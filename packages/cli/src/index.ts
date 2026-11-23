#!/usr/bin/env bun
import { classify, diffHash, loadCached } from "./classify";
import { coderabbitComments } from "./coderabbit";
import { describePr, parsePrTarget, prDiff, resolvePr } from "./gh";
import { splitDiff } from "./git";
import { configuredModel, getHarness } from "./harness";
import { repoRoot } from "./paths";
import { openBrowser, type ReviewState, startServer } from "./serve";

const USAGE = `changestack — review AI-written changes in the order that matters

  changestack [<number|url>] [options]  open a PR for review: the given one, else the current
                                        branch's PR, else pick from open PRs (needs \`gh\`; no checkout).
                                        Classifies the diff (cached by diff hash), starts the viewer
                                        and opens it in the browser.
      --port <n>     viewer port (default 4317; falls back to a free one)
      --no-open      don't open the browser
      --refresh      ignore the cached classification and run the model again
      --diff         print the PR's raw diff to stdout and exit

Environment: CHANGESTACK_MODEL pins the model; CHANGESTACK_TRANSCRIPT_CHARS caps how much
session transcript goes into the prompt (default 24000, 0 = off).`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

/** The one command: pick the PR, serve it straight away, classify in the background unless cached. */
async function openPr(args: string[]): Promise<void> {
  args = [...args];
  const portArg = flagValue(args, "--port");
  const port = portArg === undefined ? 4317 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${portArg}`);
  const known = new Set(["--diff", "--no-open", "--refresh"]);
  const unknown = args.filter((a) => a.startsWith("--") && !known.has(a));
  if (unknown.length) throw new Error(`unknown option ${unknown[0]}; see \`changestack help\``);
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) throw new Error(`expected at most one PR, got: ${positional.join(" ")}`);

  const root = repoRoot();
  const pr = resolvePr(root, positional[0]);
  // Started first so it runs while the diff downloads. Read-only and best effort: a review
  // without CodeRabbit's comments is still a review.
  const coderabbit = args.includes("--diff")
    ? Promise.resolve([])
    : coderabbitComments(root, pr).catch((err) => {
        console.error(`changestack: couldn't read CodeRabbit's comments: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      });
  const diff = prDiff(root, pr);
  if (args.includes("--diff")) {
    process.stdout.write(diff);
    return;
  }
  const files = splitDiff(diff);
  console.error(`changestack: ${describePr(pr)}`);
  console.error(`changestack: ${pr.url} @ ${pr.headRefOid.slice(0, 7)}, ${files.length} file(s) changed`);

  const hash = diffHash(diff);
  const cached = args.includes("--refresh") ? null : loadCached(root, pr.number, hash);
  const harness = getHarness();
  const state: ReviewState = {
    root,
    pr,
    diff,
    annotation: cached,
    coderabbit: await coderabbit,
    status: cached
      ? { state: "ready", cached: true }
      : files.length === 0
        ? { state: "error", message: "This PR has no file changes to classify." }
        : { state: "classifying", startedAt: new Date().toISOString(), files: files.length, model: configuredModel(harness), detail: "Starting…" },
  };

  const server = startServer(state, port);
  const url = `http://${server.hostname}:${server.port}`;
  if (state.coderabbit.length) console.error(`changestack: ${state.coderabbit.length} CodeRabbit comment(s)`);
  console.error(`changestack: ${cached ? "using cached classification" : files.length ? "classifying in the background" : "nothing to classify"}`);
  console.error(`changestack: open ${url}  (Ctrl+C to stop)`);
  if (!args.includes("--no-open")) openBrowser(url);

  if (state.status.state !== "classifying") return;
  const started = state.status;
  try {
    state.annotation = await classify({
      root,
      pr,
      files,
      hash,
      onProgress: (detail) => {
        if (state.status.state === "classifying") state.status = { ...started, detail };
      },
    });
    state.status = { state: "ready", cached: false };
    const a = state.annotation;
    console.error(`changestack: classified ${a.sections.length} section(s), ${a.flags.length} flag(s) with ${a.model}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = { state: "error", message };
    console.error(`changestack: classification failed: ${message}`);
  }
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "annotate":
    case "serve":
    case "log":
    case "note":
      throw new Error(`\`${cmd}\` was removed: run \`changestack [<pr>]\`, which reads the agent's session transcripts instead, and delete any changestack hooks from .claude/settings.json`);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      if (cmd === undefined || cmd.startsWith("--") || parsePrTarget(cmd)) {
        await openPr(cmd === undefined ? args : [cmd, ...args]);
        break;
      }
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(`changestack: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
