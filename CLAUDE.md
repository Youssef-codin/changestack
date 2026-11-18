# changestack

## Testing changes end to end

Test against **lustre-clinic** (`/home/joe-arch/projects/work/lustre-clinic`, `lustre-systems/lustre-clinic`), not this repo. It has real agent-built PRs (e.g. #123–#127) with matching Claude Code sessions in `~/.claude/projects/-home-joe-arch-projects-work-lustre-*`, so classification and transcript reading get exercised on a real codebase.

```sh
bun run build
cd /home/joe-arch/projects/work/lustre-clinic
bun /home/joe-arch/projects/web/changestack/packages/cli/src/index.ts 127 --no-open --port 4399
curl -s localhost:4399/api/review   # poll until status.state is "ready"
```

- Use a non-default `--port` and stop the server by port (`fuser -k 4399/tcp`), not `pkill -f`, which can match your own shell.
- Each uncached run is a real model call on the user's usage; rerun the same PR to test the cache, and use `--refresh` only when the prompt or transcript logic changed.
- **Never click Post review / call `POST /api/submit` there.** lustre-clinic is a shared org repo, and submitting posts a real review under the user's account. Test drafts and the confirm panel only, and delete test drafts afterwards.

## Tasks board

Work is tracked on the Notion Tasks board (data source `collection://3b7541c6-b441-8008-98ec-000be7ea078f`, Project = changestack). Anything you do that isn't already a task there (fixes, cleanups, docs, follow-ups you find) gets a task too: create it with Project, Status and Priority set, and mark it Done when finished. Move tasks to In progress when you start and Done when they're pushed.
