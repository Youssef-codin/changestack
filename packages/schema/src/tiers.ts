/** Zod-free constants, so the viewer can import them without bundling zod. */
export const TIERS = ["core", "glue", "tests", "docs", "boilerplate", "generated"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_ORDER: readonly Tier[] = TIERS;

/** Merge verdict levels, most to least attention. */
export const VERDICT_LEVELS = ["careful", "core", "skim", "merge"] as const;
export type VerdictLevel = (typeof VERDICT_LEVELS)[number];

/** The score range each level picks; the size of the change picks the spot inside it. */
export const VERDICT_RANGES: Record<VerdictLevel, readonly [lo: number, hi: number]> = {
  careful: [5, 39],
  core: [40, 69],
  skim: [70, 89],
  merge: [90, 100],
};
