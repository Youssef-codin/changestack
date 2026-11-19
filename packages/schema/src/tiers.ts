/** Zod-free constants, so the viewer can import them without bundling zod. */
export const TIERS = ["core", "glue", "tests", "docs", "boilerplate", "generated"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_ORDER: readonly Tier[] = TIERS;

/** Merge verdict levels, most to least attention. */
export const VERDICT_LEVELS = ["careful", "core", "skim", "merge"] as const;
export type VerdictLevel = (typeof VERDICT_LEVELS)[number];
