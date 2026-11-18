import { z } from "zod";
import { TIERS } from "./tiers";

export { TIER_ORDER } from "./tiers";

/** How much reviewer attention a change deserves. Ordered most → least. */
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

export const FlagKind = z.enum([
  "uncertain", // the agent guessed
  "untested", // no test covers this
  "deviation", // differs from the plan / request
  "risky", // touches auth, money, data, security
]);
export type FlagKind = z.infer<typeof FlagKind>;

/** One line the authoring agent writes while working (`changestack note`). */
export const IntentEntry = z.object({
  ts: z.string(),
  kind: z.enum(["edit", "note"]),
  file: z.string().optional(),
  text: z.string().optional(),
});
export type IntentEntry = z.infer<typeof IntentEntry>;

/** A reviewable unit: a whole file, or one symbol inside it. */
export const Section = z.object({
  file: z.string(),
  symbol: z.string().nullable().describe("Function/class/method name, or null for the whole file"),
  tier: Tier,
  why: z.string().describe("One short sentence: what changed and why it matters to a reviewer"),
});
export type Section = z.infer<typeof Section>;

export const Flag = z.object({
  file: z.string().nullable(),
  symbol: z.string().nullable(),
  kind: FlagKind,
  note: z.string(),
});
export type Flag = z.infer<typeof Flag>;

/** What the model returns. Kept separate so the prompt schema stays small. */
export const AnnotationDraft = z.object({
  summary: z.string().describe("One or two sentences describing the whole change"),
  sections: z.array(Section).describe("Every changed file, in the order a reviewer should read them"),
  flags: z.array(Flag),
});
export type AnnotationDraft = z.infer<typeof AnnotationDraft>;

/** What gets written to disk and served to the viewer. */
export const Annotation = AnnotationDraft.extend({
  version: z.literal(1),
  base: z.string().describe("Git ref the diff is taken against"),
  head: z.string().describe("Commit sha, or 'worktree' for uncommitted changes"),
  createdAt: z.string(),
  model: z.string(),
  /** Sections whose tier was forced up by a deterministic rule. */
  overrides: z.array(z.object({ file: z.string(), from: Tier, to: Tier, rule: z.string() })),
});
export type Annotation = z.infer<typeof Annotation>;

/** Payload of GET /api/review. */
export const ReviewPayload = z.object({
  annotation: Annotation.nullable(),
  diff: z.string(),
});
export type ReviewPayload = z.infer<typeof ReviewPayload>;

/**
 * Which set of drafts a review belongs to. Today the CLI uses `branch:<name>`;
 * a PR-based flow will use `pr:<number>` so each PR keeps its own drafts.
 */
export const DraftScope = z.string().regex(/^(branch|pr|detached):[^\0]{1,200}$/);
export type DraftScope = z.infer<typeof DraftScope>;

/**
 * A line comment the reviewer hasn't sent anywhere yet.
 * `side` + `line` say which line it sits on: `new` for added/context lines
 * (new-file numbering), `old` for deleted lines (old-file numbering).
 * `lineText` is the line's content when the draft was written. It lets the
 * viewer find the line again after the diff changes.
 */
export const Draft = z.object({
  id: z.string().min(1).max(64),
  file: z.string().min(1),
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  lineText: z.string(),
  body: z.string().min(1).max(20_000),
  /** `outdated` once the line can't be found in the current diff. The draft is kept, not deleted. */
  status: z.enum(["active", "outdated"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Draft = z.infer<typeof Draft>;

/** On-disk drafts file, one per scope, under `.git/changestack/drafts/`. Also the GET /api/drafts payload. */
export const DraftSet = z.object({
  version: z.literal(1),
  scope: DraftScope,
  drafts: z.array(Draft),
});
export type DraftSet = z.infer<typeof DraftSet>;
