import type { Tier } from "@changestack/schema";
import { TIER_ORDER } from "@changestack/schema";

/**
 * Deterministic overrides: anything matching is at least `minTier`, no matter
 * what the model said. The model can promote, never demote past these.
 */
export interface Rule {
  name: string;
  pattern: RegExp;
  minTier: Tier;
}

export const DEFAULT_RULES: Rule[] = [
  { name: "auth", pattern: /(auth|session|login|password|token|oauth|jwt|permission|rbac|acl)/i, minTier: "core" },
  { name: "money", pattern: /(payment|billing|invoice|checkout|stripe|price|refund|wallet)/i, minTier: "core" },
  { name: "data", pattern: /(migration|migrations\/|schema\.(sql|prisma)|\.sql$)/i, minTier: "core" },
  { name: "crypto", pattern: /(crypto|encrypt|decrypt|secret|signing|hmac)/i, minTier: "core" },
  { name: "config", pattern: /(\.env|config\/|settings\.|dockerfile|\.github\/workflows\/|wrangler\.toml)/i, minTier: "glue" },
];

const rank = (t: Tier) => TIER_ORDER.indexOf(t);

/** Returns the tier after applying rules, plus the rule that fired (if any). */
export function applyRules(file: string, tier: Tier, rules = DEFAULT_RULES): { tier: Tier; rule?: string } {
  let best: { tier: Tier; rule?: string } = { tier };
  for (const r of rules) {
    if (r.pattern.test(file) && rank(r.minTier) < rank(best.tier)) best = { tier: r.minTier, rule: r.name };
  }
  return best;
}
