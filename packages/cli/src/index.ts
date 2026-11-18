#!/usr/bin/env bun
import { annotate } from "./annotate";
import { describePr, parsePrTarget, prDiff, resolvePr } from "./gh";
import { splitDiff } from "./git";
import { logFromHook, note } from "./log";
import { repoRoot } from "./paths";
import { serve } from "./serve";

const USAGE = `changestack — review AI-written changes in the order that matters

  changestack [<number|url>] [--diff]  open a PR for review: the given one, else the current
                                      branch's PR, else pick from open PRs (needs \`gh\`; no checkout)
  changestack log                     PostToolUse hook: record a touched file (reads hook JSON on stdin)
  changestack note [--file p] <text>  record intent / uncertainty while working
  changestack annotate [--base ref]   classify the current diff with Haiku → .changestack/review/latest.json
  changestack serve [--port n]        open the review viewer (default port 4317)`;

/** Select a PR and fetch its diff from GitHub. `--diff` prints the raw diff to stdout. */
function openPr(args: string[]): void {
  const printDiff = args.includes("--diff");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) throw new Error(`expected at most one PR, got: ${positional.join(" ")}`);

  const root = repoRoot();
  const pr = resolvePr(root, positional[0]);
  const diff = prDiff(root, pr);
  if (printDiff) {
    process.stdout.write(diff);
    return;
  }
  const files = splitDiff(diff);
  console.error(`changestack: ${describePr(pr)}`);
  console.error(`changestack: ${pr.url} @ ${pr.headRefOid.slice(0, 7)}, ${files.length} file(s) changed`);
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "log":
      await logFromHook();
      break;
    case "note":
      note(args);
      break;
    case "annotate":
      await annotate(args);
      break;
    case "serve":
      serve(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      if (cmd === undefined || cmd.startsWith("--") || parsePrTarget(cmd)) {
        openPr(cmd === undefined ? args : [cmd, ...args]);
        break;
      }
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(`changestack: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
