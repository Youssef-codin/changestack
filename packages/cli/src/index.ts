#!/usr/bin/env bun
import { annotate } from "./annotate";
import { logFromHook, note } from "./log";
import { serve } from "./serve";

const USAGE = `changestack — review AI-written changes in the order that matters

  changestack log                     PostToolUse hook: record a touched file (reads hook JSON on stdin)
  changestack note [--file p] <text>  record intent / uncertainty while working
  changestack annotate [--base ref]   classify the current diff with Haiku → .changestack/review/latest.json
  changestack serve [--port n]        open the review viewer (default port 4317)`;

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
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`changestack: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
