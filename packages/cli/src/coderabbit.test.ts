import { describe, expect, test } from "bun:test";
import { collect, fromReviewBody, parseBody } from "./coderabbit";
import type { PullRequest, RawReview, RawThread } from "./gh";

const ANALYSIS = `<details>
<summary>🔎 Supported by static analysis</summary>

🏁 Script executed:

\`\`\`bash
sed -n '40,110p' link.ts
\`\`\`

<details><summary>nested</summary>inner</details>
</details>`;

describe("parseBody", () => {
  test("badges line, bold title, prose; collapsed blocks dropped", () => {
    const md = `<!-- coderabbit-ai-generated:v1 -->

**🔒 Security & Privacy** | **🟡 Minor** | **⚡ Quick win**

${ANALYSIS}

**Persist the pruned log after hydration.**

\`hydrate\` prunes the stored entries.

Write the pruned list back.

<details>
<summary>Proposed fix</summary>

\`\`\`diff
-a
+b
\`\`\`
</details>

<!-- suggestion_start -->`;
    expect(parseBody(md)).toEqual({
      severity: "Minor",
      tags: ["Security & Privacy", "Quick win"],
      title: "Persist the pruned log after hydration",
      body: "`hydrate` prunes the stored entries.\n\nWrite the pruned list back.",
    });
  });

  test("picture badges and the · separator", () => {
    const md = `**<picture><img src="x/amber-16.svg" width="16" alt=""></picture> Minor** · **Functional Correctness** · **Quick win**

**Report the status as stale.**

When \`last\` is \`null\`, \`old\` is \`false\`.`;
    const p = parseBody(md);
    expect(p.severity).toBe("Minor");
    expect(p.tags).toEqual(["Functional Correctness", "Quick win"]);
    expect(p.title).toBe("Report the status as stale");
  });

  test("older italic badges", () => {
    const p = parseBody("_⚠️ Potential issue_ | _🟠 Major_\n\n**Guard the call.**\n\nBody.");
    expect(p.severity).toBe("Major");
    expect(p.tags).toEqual(["Potential issue"]);
    expect(p.title).toBe("Guard the call");
  });

  test("no title: the first sentence stands in", () => {
    const p = parseBody("**🟡 Minor**\n\nThis leaks. Fix it by closing the handle.");
    expect(p.severity).toBe("Minor");
    expect(p.title).toBe("This leaks");
    expect(p.body).toBe("Fix it by closing the handle.");
  });
});

const REVIEW_BODY = `**Actionable comments posted: 1**

> [!CAUTION]
> **⚠️ Outside diff range comments (1)**
>
> <details>
> <summary><strong>🟡 Minor</strong> · Clear the dismissal later. · <code>Reminders.tsx:194-249</code></summary><blockquote>
>
> \`packages/app/Reminders.tsx:194-249\`
> **🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**
>
> **Clear the local dismissal only after the resume succeeds.**
>
> A failed resume leaves the hold cleared.
>
> <details><summary>Suggested fix</summary>
>
> \`\`\`diff
> -x
> \`\`\`
>
> </details>
>
> <!-- cr-comment:v1:0f769f3b -->
>
> </blockquote></details>

---

<details>
<summary>🤖 Prompt to fix review comments</summary>

\`\`\`
Outside diff comments:
\`packages/app/Reminders.tsx:194-249\`
\`\`\`
</details>`;

const review = (over: Partial<RawReview> = {}): RawReview => ({
  id: 1,
  body: REVIEW_BODY,
  commit_id: "head",
  html_url: "https://github.com/o/r/pull/1#pullrequestreview-1",
  submitted_at: "2026-10-06T16:40:42Z",
  user: { login: "coderabbitai[bot]" },
  ...over,
});

describe("fromReviewBody", () => {
  test("cuts out-of-diff comments from the review body", () => {
    const [c, ...rest] = fromReviewBody(review(), "head");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      id: "c0f769f3b",
      file: "packages/app/Reminders.tsx",
      line: 249,
      startLine: 194,
      severity: "Minor",
      title: "Clear the local dismissal only after the resume succeeds",
      body: "A failed resume leaves the hold cleared.",
      outdated: false,
    });
  });

  test("a review of an older commit is outdated", () => {
    expect(fromReviewBody(review(), "newer")[0]!.outdated).toBe(true);
  });
});

const thread = (over: Partial<RawThread> = {}, login = "coderabbitai"): RawThread => ({
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  line: 12,
  startLine: 10,
  originalLine: 12,
  diffSide: "RIGHT",
  subjectType: "LINE",
  comments: {
    totalCount: 2,
    nodes: [{ databaseId: 7, url: "u", createdAt: "2026-10-01T00:00:00Z", body: "**🟠 Major**\n\n**Title.**\n\nBody.", author: { login } }],
  },
  ...over,
});

const pr = { headRefOid: "head" } as PullRequest;

describe("collect", () => {
  test("keeps CodeRabbit's threads, with GitHub state and replies", () => {
    const [c] = collect(pr, [thread({ isResolved: true }), thread({}, "someone")], []);
    expect(c).toMatchObject({ id: "t7", file: "a.ts", side: "new", line: 12, startLine: 10, resolved: true, replies: 1, severity: "Major", title: "Title" });
  });

  test("file-level and left-side threads", () => {
    expect(collect(pr, [thread({ subjectType: "FILE" })], [])[0]).toMatchObject({ line: null, startLine: null });
    expect(collect(pr, [thread({ diffSide: "LEFT" })], [])[0]!.side).toBe("old");
  });

  test("a comment repeated across reviews appears once, from the latest review", () => {
    const later = review({ id: 2, submitted_at: "2026-10-07T00:00:00Z", commit_id: "head" });
    const earlier = review({ id: 1, commit_id: "old" });
    const out = collect(pr, [], [later, earlier, review({ id: 3, user: { login: "someone" } })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.outdated).toBe(false);
  });
});
