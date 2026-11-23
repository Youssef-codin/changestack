# changestack

Review the PRs your coding agent writes, with the code that matters most shown first.

Agent PRs are big, and a flat diff gives every line the same weight: core logic sits between lockfiles and renames, and nothing tells you which parts the agent guessed at. changestack opens a PR in your browser with flags pinned at the top, core logic first and boilerplate collapsed. Nothing is ever hidden.

It runs on the agent subscription you already have. No API keys, no hooks, no setup.

## Use

```sh
changestack            # the current branch's PR, or pick from the open PRs
changestack 123        # a PR number
changestack https://github.com/owner/repo/pull/123
```

The review opens in your browser. Then:

1. Read top to bottom. `j`/`k` move between files, `x` expands or collapses, `r` marks a file reviewed.
2. Click **+** next to any line to comment. Comments are saved as drafts on this machine.
3. Click **Submit review** to post every draft as one GitHub review under your account, or **Copy all as prompt** to paste them back into your agent.

Nothing is posted until you click Submit and confirm. Reviews only comment; they never approve or request changes.

Options: `--port <n>` (default 4317), `--no-open`, `--refresh` (classify again even if cached), `--diff` (print the PR's diff and exit).

## Requirements

- [`gh`](https://cli.github.com), logged in (`gh auth login`)
- [Claude Code](https://claude.com/claude-code), logged in. Classification runs through `claude -p` on your existing plan.

## How it works

1. **The PR.** The diff comes from `gh pr diff`; nothing is checked out.
2. **Cache.** Classifications are stored in `.git/changestack/` by a hash of the diff. Reopening an unchanged PR costs nothing. Usage is only spent when a PR's diff changes.
3. **Transcripts.** changestack reads your Claude Code sessions for the repo (and its worktrees) on the PR's head branch, and passes the classifier what you asked for, what the agent said, which files it edited, test runs that failed or skipped, and edits you rejected. If this machine has no transcript for the PR, you still get tiers and ordering, just without transcript-based flags.
4. **Classify.** Haiku sorts every changed file, or symbol within it, into a tier and raises flags. It gets a condensed diff (each file's hunk headers and first few changed lines, with counts for the rest; lockfiles and generated files by counts only), since sorting doesn't need every line. It doesn't review the code for bugs; leave that to a code review tool. The diff shows in the browser right away; the order arrives when the model finishes. The tokens the call used are saved with the classification.
5. **Rules.** Deterministic path rules set minimum tiers, and the viewer shows when one fired.

### Tiers

Most to least important: **core** → **glue** → **tests** → **boilerplate** → **generated**.

The model can move a file up but never below its rule minimum: auth, money, migrations and crypto are always at least core, config at least glue. The rules live in `packages/cli/src/rules.ts`.

### Flags

What to check first:

- `uncertain`: the agent guessed or said it wasn't sure
- `untested`: core logic with no test change, or tests that failed or were skipped
- `deviation`: the agent diverged from what you asked or abandoned an approach
- `risky`: touches auth, money, persistence or security. It names the area only, never a bug

`uncertain` and `deviation` come from the session transcript only.

### CodeRabbit

If [CodeRabbit](https://coderabbit.ai) has reviewed the PR, its comments show in the Context margin beside their lines, with their own icon and color. Comments on a whole file, outdated ones, and the "outside diff range" ones from its review bodies sit at the top of the file; ones on files outside the diff open on GitHub. They're read once with `gh api` when changestack starts. Threads resolved on GitHub show as resolved. **Resolve** and **Reply as draft** work as they do for flags, and change nothing on GitHub until you submit.

### Configuration

| Variable | Default | |
|---|---|---|
| `CHANGESTACK_MODEL` | `haiku` | Pin an exact model ID |
| `CHANGESTACK_TRANSCRIPT_CHARS` | `24000` | Most transcript sent to the model; `0` turns transcripts off |

### Storage

Everything lives in `.git/changestack/`: cached classifications and draft comments, per repo and per PR. It's never committed and needs no `.gitignore` entry.

## Develop

```text
packages/schema   Zod schemas shared by the CLI and viewer
packages/cli      Bun CLI, compiled to a single binary
packages/viewer   Solid + Vite + Tailwind viewer: Briefing, Review, Submit
```

```sh
bun install
bun run build       # viewer → packages/viewer/dist, CLI → packages/cli/dist/changestack
bun run typecheck

# viewer hot reload: run `changestack --no-open` in a repo and `bun run dev` here (Vite proxies /api)
```

The harness lives behind one interface in `packages/cli/src/harness/`: run a prompt and get schema-checked JSON back, and read session transcripts. Claude Code is the only harness so far. Its transcript format isn't a stable API, so all knowledge of it stays in `claude-code-transcripts.ts`.
