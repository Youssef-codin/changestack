# changestack

Review AI-written changes in the order that matters. While the agent works, changestack records what it touched and what it was unsure about. When it stops, Haiku sorts the diff into tiers (core → glue → tests → boilerplate → generated). The viewer shows core logic first, collapses boilerplate, and pins flags at the top.

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

# in the repo you want to review:
changestack annotate                  # needs ANTHROPIC_API_KEY
changestack serve                     # http://127.0.0.1:4317

# viewer hot reload: run `changestack serve` and `bun run dev` together (vite proxies /api)
```

## Wire into Claude Code

`.claude/settings.json` in the target repo:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "changestack log" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "changestack annotate --quiet" }] }
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

1. Haiku classifies each changed file (or symbol) using the diff plus the agent's notes.
2. Any file the model skipped is added as `glue`.
3. Deterministic rules in `packages/cli/src/rules.ts` set a minimum tier by path (auth, money, migrations, crypto → `core`; config → `glue`). The model can move a file up but never below these. When a rule fires, the viewer shows it on the file.

Nothing is ever hidden. Boilerplate is only collapsed.
