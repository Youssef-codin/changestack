import type { Annotation, Flag, Section, Tier, Verdict, VerdictLevel } from "@changestack/schema";
import { TIER_ORDER, VERDICT_RANGES } from "@changestack/schema";
import type { FileDiff } from "./git";

/**
 * Merge verdict rules. Set once from what the PR changed, never from how far the
 * reviewer got. See docs/design/README.md, "Merge verdict".
 *
 * - The level comes from the most important tier touched:
 *   core with a deviation, risky or untested flag → careful;
 *   core otherwise → core; glue at most → skim;
 *   only tests, docs, comments, boilerplate, generated (or config-rule glue) → merge.
 *   Core is never `merge`.
 * - The level picks a score range; the size of the change picks the spot in it,
 *   on a log scale, so bigger changes score lower.
 */

/** How much one changed line in each tier counts toward size. Generated code is free. */
const WEIGHT: Record<Tier, number> = { core: 1, glue: 1 / 3, tests: 1 / 6, docs: 1 / 8, comments: 0, boilerplate: 1 / 10, generated: 0 };

const SERIOUS: ReadonlySet<Flag["kind"]> = new Set(["deviation", "risky", "untested"]);

/** Added plus deleted lines in one file's diff text. */
export function changedLines(text: string): number {
  let n = 0;
  for (const l of text.split("\n")) {
    if ((l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))) n++;
  }
  return n;
}

/** Each file's tier is its most important section's tier. */
export function fileTiers(sections: Section[]): Map<string, Tier> {
  const rank = (t: Tier) => TIER_ORDER.indexOf(t);
  const m = new Map<string, Tier>();
  for (const s of sections) {
    const cur = m.get(s.file);
    if (!cur || rank(s.tier) < rank(cur)) m.set(s.file, s.tier);
  }
  return m;
}

export function computeVerdict(
  sections: Section[],
  flags: Flag[],
  files: FileDiff[],
  overrides: Annotation["overrides"],
): Verdict {
  const tiers = fileTiers(sections);
  const configOnly = new Set(overrides.filter((o) => o.rule === "config" && o.to === "glue").map((o) => o.file));
  const touched = (t: Tier) => [...tiers.entries()].some(([f, tier]) => tier === t && !(t === "glue" && configOnly.has(f)));

  let level: VerdictLevel;
  if (touched("core")) {
    const coreFiles = new Set([...tiers].filter(([, t]) => t === "core").map(([f]) => f));
    const serious = flags.some((fl) => SERIOUS.has(fl.kind) && (fl.file === null || coreFiles.has(fl.file)));
    level = serious ? "careful" : "core";
  } else {
    level = touched("glue") ? "skim" : "merge";
  }

  let size = 0;
  for (const f of files) size += changedLines(f.text) * WEIGHT[tiers.get(f.file) ?? "glue"];
  const pos = Math.min(1, Math.log10(1 + size) / 3);
  const [lo, hi] = VERDICT_RANGES[level];
  return { level, score: Math.round(hi - pos * (hi - lo)) };
}
