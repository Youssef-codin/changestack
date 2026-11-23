import { z } from "zod";
import { TIERS, VERDICT_LEVELS } from "./tiers";

export { TIER_ORDER, VERDICT_LEVELS, VERDICT_RANGES, type VerdictLevel } from "./tiers";

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

/** Something the change builds, as the user would name it. Files are grouped by these in the viewer. */
export const Feature = z.object({
  name: z.string().describe("2 to 4 words, e.g. \"Reminder scheduling\""),
  why: z.string().describe("One short sentence: what it does, in product terms"),
});
export type Feature = z.infer<typeof Feature>;

/** A reviewable unit: a whole file, or one symbol inside it. */
export const Section = z.object({
  file: z.string(),
  symbol: z.string().nullable().describe("Function/class/method name, or null for the whole file"),
  tier: Tier,
  why: z.string().describe("One short sentence: what changed and why it matters to a reviewer"),
  feature: z.string().nullable().describe("Name of the feature (from `features`) this section builds, or null for setup and plumbing that serves none"),
});
export type Section = z.infer<typeof Section>;

/** A flag as the model writes it: it quotes the line instead of numbering it, since diffs carry no line numbers per line. */
export const FlagDraft = z.object({
  file: z.string().nullable(),
  symbol: z.string().nullable(),
  kind: FlagKind,
  note: z.string(),
  quote: z
    .string()
    .nullable()
    .describe("The one added or unchanged line the flag is about, copied exactly from the diff without its leading + or space; null when it's about the whole file"),
});
export type FlagDraft = z.infer<typeof FlagDraft>;

/** A flag as cached and served: the quote resolved to a new-file line number (null when it's about the whole file or couldn't be found). */
export const Flag = FlagDraft.omit({ quote: true }).extend({ line: z.number().int().positive().nullable() });
export type Flag = z.infer<typeof Flag>;

/** Set once from what the PR changed; never moves during the review. See packages/cli/src/verdict.ts. */
export const Verdict = z.object({
  level: z.enum(VERDICT_LEVELS),
  score: z.number().int().min(0).max(100),
});
export type Verdict = z.infer<typeof Verdict>;

/** What the model returns. Kept separate so the prompt schema stays small. */
export const AnnotationDraft = z.object({
  summary: z.string().describe("One or two sentences describing the whole change"),
  features: z.array(Feature).describe("What the change builds, 1 to 5 items, most important first"),
  sections: z.array(Section).describe("Every changed file, in the order a reviewer should read them"),
  flags: z.array(FlagDraft),
});
export type AnnotationDraft = z.infer<typeof AnnotationDraft>;

/** What gets cached under `.git/changestack/reviews/` and served to the viewer. */
export const Annotation = AnnotationDraft.omit({ flags: true }).extend({
  version: z.literal(3),
  flags: z.array(Flag),
  verdict: Verdict,
  pr: z.number().int().positive().describe("Pull request number the annotation was made for"),
  base: z.string().describe("Full sha of the PR's base commit when the diff was fetched"),
  head: z.string().describe("Full sha of the PR's head commit when the diff was fetched"),
  /** sha256 of the diff text plus prompt version and model; the cache key. */
  diffHash: z.string(),
  createdAt: z.string(),
  model: z.string(),
  /** Tokens the classifier call used, as the harness reported them. */
  usage: z
    .object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), costUsd: z.number().nullable() })
    .optional(),
  /** Session transcripts that fed the classifier, if any were found. */
  transcripts: z.array(z.string()),
  /** Sections whose tier was forced up by a deterministic rule. */
  overrides: z.array(z.object({ file: z.string(), from: Tier, to: Tier, rule: z.string() })),
});
export type Annotation = z.infer<typeof Annotation>;

/** The PR being reviewed, as the viewer needs it. */
export const PrInfo = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
});
export type PrInfo = z.infer<typeof PrInfo>;

/** Where classification stands. The viewer polls while it is `classifying`. */
export const ClassifyStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("classifying"), startedAt: z.string(), files: z.number(), model: z.string(), detail: z.string() }),
  z.object({ state: z.literal("ready"), cached: z.boolean() }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type ClassifyStatus = z.infer<typeof ClassifyStatus>;

/**
 * A CodeRabbit review comment, cleaned for the Context margin: its badges, title and prose,
 * without the collapsed analysis, suggestion and agent-prompt blocks (those stay on GitHub).
 * `line` is the new-file line (old-file for `side: "old"`), or null for a whole-file or
 * whole-PR comment. Comments CodeRabbit had to put in a review body ("outside diff range")
 * carry a line that usually isn't in the diff; the viewer puts those at the top of the file.
 */
export const CodeRabbitComment = z.object({
  id: z.string(),
  file: z.string().nullable(),
  side: z.enum(["old", "new"]),
  line: z.number().int().positive().nullable(),
  startLine: z.number().int().positive().nullable(),
  /** "Critical", "Major", "Minor", "Trivial", "Info", or null when CodeRabbit gave none. */
  severity: z.string().nullable(),
  /** The other badges, e.g. "Functional Correctness", "Quick win". */
  tags: z.array(z.string()),
  title: z.string(),
  /** Markdown prose: paragraphs, lists, `code` and fenced blocks. */
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  /** The thread is resolved on GitHub. */
  resolved: z.boolean(),
  /** Written against an earlier commit, and the code has moved on. */
  outdated: z.boolean(),
  /** Replies in the thread after CodeRabbit's comment. */
  replies: z.number().int().nonnegative(),
});
export type CodeRabbitComment = z.infer<typeof CodeRabbitComment>;

/** Payload of GET /api/review. */
export const ReviewPayload = z.object({
  pr: PrInfo,
  status: ClassifyStatus,
  annotation: Annotation.nullable(),
  diff: z.string(),
  /** CodeRabbit's comments on the PR, fetched at startup; empty when it hasn't reviewed (or gh failed). */
  coderabbit: z.array(CodeRabbitComment),
});
export type ReviewPayload = z.infer<typeof ReviewPayload>;

/** Body of POST /api/submit's success response. */
export const SubmitResult = z.object({ url: z.string(), posted: z.number(), inBody: z.number() });
export type SubmitResult = z.infer<typeof SubmitResult>;

/**
 * Which set of drafts a review belongs to. PR reviews use `pr:<number>`, so each PR
 * keeps its own drafts; `branch:` and `detached:` remain valid for older files.
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
