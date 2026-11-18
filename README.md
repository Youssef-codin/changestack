# changestack

Review AI-written pull requests in the order that matters. `changestack` opens a PR, reads the agent's own Claude Code session transcripts for that branch, and has Haiku sort the diff into tiers (core → glue → tests → boilerplate → generated). The viewer shows core logic first, collapses boilerplate, and pins flags at the top. Comments are saved as drafts and posted to GitHub as one review when you click **Submit review**.

## Layout

```
packages/schema   Zod schemas shared by CLI + viewer (annotation format)
packages/cli      Bun CLI, compiled to a single binary
packages/viewer   Solid + Vite viewer, virtualized diff
```

## Develop

```sh
bun install
bun run build                         # viewer → packages/viewer/dist, CLI → packages/cli/dist/changestack

# in the repo you want to review (needs `gh` logged in and `claude` on PATH):
changestack                           # current branch's PR, else pick from open PRs
changestack 42                        # or a PR number / URL
changestack 42 --refresh              # ignore the cached classification

# viewer hot reload: run `changestack --no-open` and `bun run dev` together (vite proxies /api)
```

One command does everything: it fetches the PR diff from GitHub (no checkout), starts the viewer at http://127.0.0.1:4317 and opens it. The diff shows right away; the reading order and flags appear when classification finishes. Classifications are cached in `.git/changestack/reviews/` by a hash of the diff, so reopening an unchanged PR makes no model call.

## Session transcripts

changestack finds Claude Code transcripts (`~/.claude/projects/`) for the repo, its worktrees, and sibling `<repo>-*` dirs, keeping sessions whose branch is the PR's head branch. From them it passes the classifier what the user asked, what the agent said (favouring passages about guessing, workarounds and skipped work), which changed files it edited, test runs that failed or skipped, and edits the user rejected. It's capped at 24,000 characters because it runs on your usage; set `CHANGESTACK_TRANSCRIPT_CHARS` to change that (0 turns it off). With no matching transcript, it classifies from the diff alone.

## Submitting a review

**Submit review** posts every draft as one comment-only review (never approve or request changes) through `gh api`, under your account, pinned to the head commit you were viewing. Drafts whose line has changed go in the review body. Drafts are cleared only after GitHub accepts the review; on failure they stay and the error is shown.

## Wire into Claude Code

`.claude/settings.json` in the target repo:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "changestack log" }] }
    ]
  }
}
```

Add this to the target repo's `CLAUDE.md` so the agent records intent:

```md
When you make a non-obvious decision, guess at behavior, skip a test, or deviate from the plan,
record it: `changestack note --file <path> "<one sentence>"`.
```

## How tiers are decided

1. Haiku classifies each changed file (or symbol) using the diff, the agent's notes and its session transcript.
2. Any file the model skipped is added as `glue`.
3. Deterministic rules in `packages/cli/src/rules.ts` set a minimum tier by path (auth, money, migrations, crypto → `core`; config → `glue`). The model can move a file up but never below these. When a rule fires, the viewer shows it on the file.

Nothing is ever hidden. Boilerplate is only collapsed.
