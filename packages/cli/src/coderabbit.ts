/**
 * CodeRabbit's comments on a PR, cleaned for the Context margin. Line comments come from
 * the PR's review threads (which carry GitHub's resolved and outdated state). Comments
 * CodeRabbit couldn't post inline ("outside diff range") live in its review bodies and
 * are cut out of them here. Every collapsed block (analysis chains, suggested diffs,
 * agent prompts) is dropped: the note links to GitHub for those.
 */
import type { CodeRabbitComment } from "@changestack/schema";
import { type PullRequest, type RawReview, type RawThread, reviewThreadsAndReviews } from "./gh";

/** GraphQL names the bot `coderabbitai`; REST adds `[bot]`. */
export const isCodeRabbit = (login: string | null | undefined) => !!login && login.replace(/\[bot\]$/, "") === "coderabbitai";

const SEVERITY = /^(critical|major|minor|trivial|info|nitpick)$/i;
/** Badges CodeRabbit has used on a line of their own, before it switched to `a | b | c`. */
const LONE_BADGE = /^(potential issue|refactor suggestion|nitpick|critical|major|minor|trivial|info|verification agent)\b/i;

/** Remove HTML comments and every `<details>` block, nested ones included. */
export function stripCollapsed(md: string): string {
  md = md.replace(/<!--[\s\S]*?-->/g, "");
  let out = "";
  let depth = 0;
  let from = 0;
  for (const m of md.matchAll(/<details\b[^>]*>|<\/details\s*>/gi)) {
    if (depth === 0) out += md.slice(from, m.index);
    depth = m[0][1] === "/" ? Math.max(0, depth - 1) : depth + 1;
    from = m.index + m[0].length;
  }
  if (depth === 0) out += md.slice(from);
  return out;
}

/** Inline HTML to text: badge images go, line breaks stay, other tags are unwrapped. */
function stripTags(s: string): string {
  return s
    .replace(/<picture\b[\s\S]*?<\/picture>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Text of a badge: markers and leading emoji off. */
const badgeText = (piece: string) => piece.replace(/^(\*\*|__|\*|_)(.*)\1$/, "$2").replace(/^[^\p{L}\p{N}]+/u, "").trim();

/** The `**🎯 Correctness** | **🟡 Minor** | **⚡ Quick win**` line, split; null when `line` isn't one. */
function badges(line: string): string[] | null {
  const pieces = line.split(/\s+[|·]\s+/);
  if (!pieces.every((p) => /^(\*\*|_)[^]+\1$/.test(p))) return null;
  const text = pieces.map(badgeText).filter(Boolean);
  if (text.length === 0) return null;
  // A single bold line is the title, unless it's a badge we know.
  if (text.length === 1 && !LONE_BADGE.test(text[0]!)) return null;
  return text;
}

export interface ParsedBody {
  severity: string | null;
  tags: string[];
  title: string;
  body: string;
}

/** One CodeRabbit comment's markdown → badges, title and prose. */
export function parseBody(md: string): ParsedBody {
  const lines = stripTags(stripCollapsed(md)).split("\n").map((l) => l.trimEnd());
  let i = 0;
  const nextText = () => {
    while (i < lines.length && !lines[i]!.trim()) i++;
    return lines[i]?.trim();
  };

  let severity: string | null = null;
  const tags: string[] = [];
  const first = nextText();
  const found = first ? badges(first) : null;
  if (found) {
    i++;
    for (const b of found) {
      if (!severity && SEVERITY.test(b)) severity = b[0]!.toUpperCase() + b.slice(1).toLowerCase();
      else tags.push(b);
    }
  }

  let title = "";
  const t = nextText()?.match(/^\*\*(.+)\*\*$/);
  if (t) {
    title = t[1]!.trim();
    i++;
  }
  let body = lines
    .slice(i)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n\s*---\s*)+$/, "")
    .trim();
  if (!title) {
    // No bold title: the first sentence stands in for one.
    const sentence = body.match(/^[^\n]*?[.!?](?=\s|$)/)?.[0] ?? body.split("\n")[0] ?? "";
    title = sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence || "CodeRabbit comment";
    if (sentence && body.startsWith(sentence)) body = body.slice(sentence.length).trim();
  }
  return { severity, tags, title: title.replace(/\.$/, ""), body };
}

/** A line comment thread started by CodeRabbit; null for threads someone else started. */
export function fromThread(t: RawThread): CodeRabbitComment | null {
  const root = t.comments.nodes[0];
  if (!root || !isCodeRabbit(root.author?.login)) return null;
  const line = t.subjectType === "FILE" ? null : t.line;
  return {
    id: `t${root.databaseId}`,
    file: t.path,
    side: t.diffSide === "LEFT" ? "old" : "new",
    line,
    startLine: line !== null && t.startLine !== null && t.startLine < line ? t.startLine : null,
    ...parseBody(root.body),
    url: root.url,
    createdAt: root.createdAt,
    resolved: t.isResolved,
    outdated: t.isOutdated,
    replies: Math.max(0, t.comments.totalCount - 1),
  };
}

/** A comment's place in a review body: `` `path/to/file.ts:12-18` `` on a line of its own. */
const LOCATION = /^`([^`\n]+?):(\d+)(?:-(\d+))?`[ \t]*$/gm;

/**
 * The comments CodeRabbit put in a review body instead of on a line. Each sits in a
 * `<details>` that opens with its location; it ends where that `<details>` closes.
 */
export function fromReviewBody(review: RawReview, head: string): CodeRabbitComment[] {
  // Quoted under a [!CAUTION] callout: unquote first.
  const md = review.body.replace(/^>[ \t]?/gm, "");
  const out: CodeRabbitComment[] = [];
  // The agent prompt quotes locations inside a fenced block; those aren't comments.
  const fences = [...md.matchAll(/^```[^]*?^```/gm)].map((f) => [f.index, f.index + f[0].length] as const);
  for (const m of md.matchAll(LOCATION)) {
    if (fences.some(([a, b]) => a <= m.index && m.index < b)) continue;
    const rest = md.slice(m.index + m[0].length);
    let depth = 0;
    let end = rest.length;
    for (const d of rest.matchAll(/<details\b[^>]*>|<\/details\s*>|^`[^`\n]+?:\d+(?:-\d+)?`[ \t]*$/gim)) {
      if (d[0].startsWith("`")) {
        if (depth === 0) {
          end = d.index;
          break;
        }
      } else if (d[0][1] !== "/") depth++;
      else if (depth === 0) {
        end = d.index;
        break;
      } else depth--;
    }
    const chunk = rest.slice(0, end);
    const a = Number(m[2]);
    const b = m[3] === undefined ? a : Number(m[3]);
    // CodeRabbit tags each comment with a stable hash; reviews repeat comments, so it dedupes them.
    const key = chunk.match(/<!--\s*cr-comment:v1:([\w-]+)\s*-->/)?.[1];
    out.push({
      id: key ? `c${key}` : `r${review.id}-${out.length}`,
      file: m[1]!,
      side: "new",
      line: Math.max(a, b),
      startLine: a < b ? a : null,
      ...parseBody(chunk),
      url: review.html_url,
      createdAt: review.submitted_at,
      resolved: false,
      outdated: review.commit_id !== head,
      replies: 0,
    });
  }
  return out;
}

/** Every CodeRabbit comment on `pr`, by file and line; later reviews replace repeats of a comment. */
export function collect(pr: PullRequest, threads: RawThread[], reviews: RawReview[]): CodeRabbitComment[] {
  const byId = new Map<string, CodeRabbitComment>();
  for (const t of threads) {
    const c = fromThread(t);
    if (c) byId.set(c.id, c);
  }
  const ordered = reviews.filter((r) => isCodeRabbit(r.user?.login) && r.body).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  for (const r of ordered) {
    for (const c of fromReviewBody(r, pr.headRefOid)) {
      // Without CodeRabbit's hash, the same file, line and title count as one comment.
      const sig = `${c.file}\0${c.line}\0${c.title}`;
      for (const [id, old] of byId) if (id.startsWith("r") && `${old.file}\0${old.line}\0${old.title}` === sig) byId.delete(id);
      byId.set(c.id, c);
    }
  }
  return [...byId.values()].sort(
    (a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.createdAt.localeCompare(b.createdAt),
  );
}

/** Fetch and clean CodeRabbit's comments on `pr`. */
export async function coderabbitComments(root: string, pr: PullRequest): Promise<CodeRabbitComment[]> {
  const { threads, reviews } = await reviewThreadsAndReviews(root, pr);
  return collect(pr, threads, reviews);
}
