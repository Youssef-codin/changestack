import type { FileDiff } from "./git";

/**
 * The classifier only sorts and labels files, so it gets a glimpse of each one, not the whole
 * diff: the hunk headers (which name the enclosing function), the first few changed lines of
 * each hunk, and counts for the rest. Generated and lock files get their counts only.
 */

/** Changed lines sent per hunk; the rest are counted. */
const HUNK_LINES = 6;
/** Most characters of one file's glimpse. */
const FILE_CHARS = 1_500;
/** Long lines are cut here. */
const LINE_CHARS = 120;
/** Most characters of all glimpses together; files past it get their counts only. */
const TOTAL_CHARS = 40_000;

/** Files whose body says nothing a reviewer needs: lockfiles, codegen output, snapshots, minified bundles. */
const GENERATED =
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(snap|min\.js|min\.css|pb\.go)$|(\.generated\.|_gen\.go$|\/generated\/|\/sqlc\/.*\.go$)/i;

function counts(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of text.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

const cut = (l: string) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l);

/** One file's glimpse: hunk headers and the first changed lines of each hunk. */
export function glimpse(f: FileDiff): string {
  if (GENERATED.test(f.file)) return "(generated or lock file; body omitted)";
  const out: string[] = [];
  let size = 0;
  let shown = 0;
  let skipped = 0;
  let omitted = 0;
  const flushSkipped = () => {
    if (skipped) out.push(`  … ${skipped} more changed line${skipped === 1 ? "" : "s"}`);
    skipped = 0;
  };
  for (const raw of f.text.split("\n")) {
    if (raw.startsWith("@@")) {
      flushSkipped();
      shown = 0;
      if (size > FILE_CHARS) {
        omitted++;
        continue;
      }
      out.push(cut(raw));
      size += raw.length;
      continue;
    }
    const changed = (raw.startsWith("+") && !raw.startsWith("+++")) || (raw.startsWith("-") && !raw.startsWith("---"));
    if (!changed) continue;
    if (size > FILE_CHARS) continue;
    if (shown < HUNK_LINES) {
      const l = cut(raw);
      out.push(l);
      size += l.length;
      shown++;
    } else skipped++;
  }
  flushSkipped();
  if (omitted) out.push(`(${omitted} more hunk${omitted === 1 ? "" : "s"} not shown)`);
  return out.join("\n");
}

/** The `<file>` blocks for the prompt, within the overall budget. */
export function condenseDiff(files: FileDiff[]): string {
  let budget = TOTAL_CHARS;
  return files
    .map((f) => {
      const { add, del } = counts(f.text);
      const body = budget > 0 ? glimpse(f) : "(over the prompt budget; body omitted)";
      budget -= body.length;
      return `<file path="${f.file}" status="${f.status}" added="${add}" removed="${del}">\n${body}\n</file>`;
    })
    .join("\n");
}
