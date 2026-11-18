import type { Draft, DraftSet } from "@changestack/schema";
import type { DiffLine, ParsedFile } from "./diff";

export type Side = Draft["side"];

/** Which side a diff line is commented on, and its number there. Hunk headers can't be commented. */
export function anchorOf(line: DiffLine): { side: Side; line: number } | null {
  if (line.kind === "del" && line.oldNo !== null) return { side: "old", line: line.oldNo };
  if ((line.kind === "add" || line.kind === "ctx") && line.newNo !== null) return { side: "new", line: line.newNo };
  return null;
}

export const anchorKey = (file: string, side: Side, line: number) => `${file}\0${side}\0${line}`;

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function call(method: string, path: string, body?: unknown): Promise<DraftSet> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const fetchDrafts = () => call("GET", "/api/drafts");
export const putDrafts = (drafts: Draft[]) => call("PUT", "/api/drafts", { drafts });
export const removeDraft = (id: string) => call("DELETE", `/api/drafts/${encodeURIComponent(id)}`);

/**
 * When the diff changes, find each draft's line again:
 * 1. Same side and number, same text: unchanged.
 * 2. Otherwise, the nearest line on the same side with the same text: move there.
 *    Very short lines (`}`, blank) match too many places, so they never move.
 * 3. Otherwise mark it `outdated`. It's kept and still shown, never dropped.
 * An outdated draft whose line comes back becomes active again.
 * Returns only the drafts that changed.
 */
export function reanchor(drafts: Draft[], files: ParsedFile[]): Draft[] {
  const byFile = new Map(files.map((f) => [f.file, f]));
  const changed: Draft[] = [];
  for (const d of drafts) {
    const candidates = (byFile.get(d.file)?.lines ?? [])
      .map((l) => ({ l, a: anchorOf(l) }))
      .filter((c): c is { l: DiffLine; a: { side: Side; line: number } } => c.a?.side === d.side);

    const exact = candidates.find((c) => c.a.line === d.line && c.l.text === d.lineText);
    let next: Pick<Draft, "line" | "status">;
    if (exact) {
      next = { line: d.line, status: "active" };
    } else {
      const moved =
        d.lineText.trim().length >= 3
          ? candidates
              .filter((c) => c.l.text === d.lineText)
              .sort((x, y) => Math.abs(x.a.line - d.line) - Math.abs(y.a.line - d.line))[0]
          : undefined;
      next = moved ? { line: moved.a.line, status: "active" } : { line: d.line, status: "outdated" };
    }
    if (next.line !== d.line || next.status !== d.status) changed.push({ ...d, ...next });
  }
  return changed;
}

/** All drafts as one prompt for the coding agent, in review order. */
export function draftsPrompt(drafts: Draft[], fileOrder: string[]): string {
  const rank = (f: string) => {
    const i = fileOrder.indexOf(f);
    return i === -1 ? fileOrder.length : i;
  };
  const sorted = [...drafts].sort(
    (a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const quote = (s: string, pad: string) => s.split("\n").map((l) => `${pad}${l}`).join("\n");

  const items = sorted.map((d, i) => {
    const where = `${d.file}:${d.line}${d.side === "old" ? " (deleted line; old-file line number)" : ""}`;
    const lines = [`${i + 1}. ${where}`, quote(d.lineText, "   > ")];
    if (d.status === "outdated") lines.push("   (This line has changed since the comment was written.)");
    lines.push(quote(d.body.trim(), "   "));
    return lines.join("\n");
  });

  return [
    `Please address these ${sorted.length} review comment${sorted.length === 1 ? "" : "s"} on your changes.`,
    "Paths are relative to the repo root; each quoted line is the code the comment refers to.",
    "",
    items.join("\n\n"),
    "",
  ].join("\n");
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API needs focus and a secure context; fall back to a hidden textarea.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}
