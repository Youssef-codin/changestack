/** Zod-free constants, so the viewer can import them without bundling zod. */
export const TIERS = ["core", "glue", "tests", "boilerplate", "generated"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_ORDER: readonly Tier[] = TIERS;
