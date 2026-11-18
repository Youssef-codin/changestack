import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Annotation,
  AnnotationDraft,
  IntentEntry,
  type Section,
} from "@changestack/schema";
import { type FileDiff, headSha, splitDiff, workingDiff } from "./git";
import { configuredModel, getHarness } from "./harness";
import { intentLogPath, repoRoot, reviewPath } from "./paths";
import { applyRules } from "./rules";

/** Per-file cap on diff text sent to the model. Trimmed files are labelled as such in the prompt. */
const MAX_FILE_CHARS = 12_000;
/** Overall cap, well under Haiku's context window. */
const MAX_TOTAL_CHARS = 400_000;

const SYSTEM = `You help a human review code changes written by an AI coding agent.
Your job is to order and classify the changed code so the reviewer spends attention where it matters.

Tiers, most to least important:
- core: business logic, state changes, algorithms, security- or data-sensitive code. Anything where a bug would matter.
- glue: wiring, types, plumbing between core pieces, config.
- tests: test code.
- boilerplate: imports, re-exports, routing tables, trivial getters, formatting, renames with no behavior change.
- generated: lockfiles, codegen output, snapshots.

Rules:
- Include every changed file at least once. Split a file into multiple sections (by symbol) only when its parts deserve different tiers.
- Order sections the way a reviewer should read them: core first, and within core, read callees' contracts before callers where that helps.
- When unsure between two tiers, pick the more important one. Never call code boilerplate just because it looks routine; it must have no behavioral effect.
- Flags: "uncertain" where the agent's notes show it guessed, "untested" for core logic with no accompanying test change, "deviation" where the notes say it diverged from the plan, "risky" for anything touching auth, money, persistence, or security.
- Keep "why" and flag notes to one short sentence. Be concrete.`;

function readIntent(root: string): IntentEntry[] {
  const path = intentLogPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = IntentEntry.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
}

function renderPrompt(files: FileDiff[], intent: IntentEntry[]): string {
  const notes = intent.filter((e) => e.kind === "note");
  const edited = [...new Set(intent.filter((e) => e.kind === "edit").map((e) => e.file))];

  let budget = MAX_TOTAL_CHARS;
  const diffBlocks = files.map((f) => {
    let text = f.text;
    let trimmed = false;
    const cap = Math.min(MAX_FILE_CHARS, Math.max(budget, 0));
    if (text.length > cap) {
      text = text.slice(0, cap);
      trimmed = true;
    }
    budget -= text.length;
    const label = trimmed ? ` (TRIMMED: showing ${text.length} of ${f.text.length} chars)` : "";
    return `<file path="${f.file}" status="${f.status}"${label}>\n${text}\n</file>`;
  });

  return [
    "<agent_notes>",
    notes.length
      ? notes.map((n) => `- ${n.file ? `[${n.file}] ` : ""}${n.text}`).join("\n")
      : "(the agent left no notes)",
    "</agent_notes>",
    "",
    `<files_edited_by_agent>${edited.join(", ") || "(none recorded)"}</files_edited_by_agent>`,
    "",
    "<diff>",
    diffBlocks.join("\n"),
    "</diff>",
  ].join("\n");
}

/** Make sure every changed file is covered, then apply deterministic tier overrides. */
function finalize(sections: Section[], files: FileDiff[]) {
  const covered = new Set(sections.map((s) => s.file));
  const missing: Section[] = files
    .filter((f) => !covered.has(f.file))
    .map((f) => ({ file: f.file, symbol: null, tier: "glue", why: "Not classified by the annotator." }));
  const known = new Set(files.map((f) => f.file));

  const overrides: Annotation["overrides"] = [];
  const out = [...sections.filter((s) => known.has(s.file)), ...missing].map((s) => {
    const { tier, rule } = applyRules(s.file, s.tier);
    if (rule) overrides.push({ file: s.file, from: s.tier, to: tier, rule });
    return { ...s, tier };
  });
  return { sections: out, overrides };
}

export async function annotate(args: string[]): Promise<void> {
  const quiet = args.includes("--quiet");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1]! : "HEAD";
  const log = (msg: string) => !quiet && console.error(msg);

  const root = repoRoot();
  const diff = workingDiff(root, base);
  const files = splitDiff(diff);
  if (files.length === 0) {
    log("changestack: no changes to annotate");
    return;
  }

  const intent = readIntent(root);
  const harness = getHarness();
  const requested = configuredModel(harness);
  log(`changestack: annotating ${files.length} file(s) with ${harness.name} (${requested})…`);

  const { data: draft, model } = await harness.runJson({
    system: SYSTEM,
    prompt: renderPrompt(files, intent),
    schema: AnnotationDraft,
    model: requested,
  });

  const { sections, overrides } = finalize(draft.sections, files);
  const head = headSha(root) ?? "unborn";
  const annotation: Annotation = {
    version: 1,
    base,
    head: "worktree",
    createdAt: new Date().toISOString(),
    model,
    summary: draft.summary,
    sections,
    flags: draft.flags,
    overrides,
  };

  const json = JSON.stringify(annotation, null, 2);
  writeFileSync(reviewPath(root, "latest"), json);
  writeFileSync(reviewPath(root, `${head}-worktree`), json);
  log(`changestack: wrote .changestack/review/latest.json (${sections.length} sections, ${draft.flags.length} flags)`);
}
