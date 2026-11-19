import type { Flag, FlagDraft } from "@changestack/schema";
import type { FileDiff } from "./git";

/**
 * New-file line numbers of every added or unchanged line in one file's diff,
 * keyed by the line's trimmed text.
 */
function newLines(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let n = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("-") || raw.startsWith("\\")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      const key = raw.slice(1).trim();
      if (key) out.set(key, [...(out.get(key) ?? []), n]);
      n++;
    }
  }
  return out;
}

/**
 * Turn the model's quoted line into a line number. The quote must match one
 * line exactly (ignoring surrounding whitespace); a quote that matches nothing,
 * or several lines, leaves the flag on the whole file rather than guess.
 */
export function resolveFlagLines(flags: FlagDraft[], files: FileDiff[]): Flag[] {
  const byFile = new Map(files.map((f) => [f.file, f]));
  const cache = new Map<string, Map<string, number[]>>();
  return flags.map(({ quote, ...flag }) => {
    let line: number | null = null;
    const file = flag.file ? byFile.get(flag.file) : undefined;
    const q = quote?.trim();
    if (file && q) {
      let lines = cache.get(file.file);
      if (!lines) cache.set(file.file, (lines = newLines(file.text)));
      const hits = lines.get(q);
      if (hits?.length === 1) line = hits[0]!;
    }
    return { ...flag, line };
  });
}
