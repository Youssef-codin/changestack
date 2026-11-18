import type { Annotation, Draft, Flag, ReviewPayload, SubmitResult, Tier } from "@changestack/schema";
import { TIER_ORDER } from "@changestack/schema/tiers";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { type DiffLine, type ParsedFile, parseDiff } from "./diff";
import {
  anchorKey,
  anchorOf,
  copyText,
  draftsPrompt,
  fetchDrafts,
  newId,
  putDrafts,
  reanchor,
  removeDraft,
  type Side,
  submitReview,
} from "./drafts";

interface ReviewFile extends ParsedFile {
  tier: Tier;
  whys: string[];
  flags: Flag[];
  overridden: string | null;
}

type Row =
  | { type: "header"; fileIdx: number }
  | { type: "line"; fileIdx: number; line: DiffLine }
  | { type: "draft"; fileIdx: number; draft: Draft }
  | { type: "composer"; fileIdx: number };

/** The open comment box: a new draft on a line, or an existing draft being edited. */
interface ComposerTarget {
  file: string;
  side: Side;
  line: number;
  lineText: string;
  editingId: string | null;
}

const HEADER_H = 56;
const LINE_H = 20;
const DRAFT_H = 72;
const COMPOSER_H = 128;
const COLLAPSED_BY_DEFAULT: Tier[] = ["boilerplate", "generated"];

async function fetchReview(): Promise<ReviewPayload> {
  const res = await fetch("/api/review");
  if (!res.ok) throw new Error(`GET /api/review → ${res.status}`);
  return res.json();
}

/** Join the raw diff with the annotation: order files for review, attach tiers and flags. */
function buildFiles(payload: ReviewPayload): ReviewFile[] {
  const parsed = parseDiff(payload.diff);
  const ann: Annotation | null = payload.annotation;
  const byFile = new Map(parsed.map((f) => [f.file, f]));
  const rank = (t: Tier) => TIER_ORDER.indexOf(t);

  const order: string[] = [];
  const meta = new Map<string, { tier: Tier; whys: string[] }>();
  for (const s of ann?.sections ?? []) {
    if (!byFile.has(s.file)) continue;
    const m = meta.get(s.file);
    const why = s.symbol ? `${s.symbol}: ${s.why}` : s.why;
    if (!m) {
      order.push(s.file);
      meta.set(s.file, { tier: s.tier, whys: [why] });
    } else {
      if (rank(s.tier) < rank(m.tier)) m.tier = s.tier;
      m.whys.push(why);
    }
  }
  // Files changed since the annotation ran: show them, but make them obvious.
  for (const f of parsed) {
    if (!meta.has(f.file)) {
      order.push(f.file);
      meta.set(f.file, { tier: "glue", whys: [ann ? "Changed after annotation ran." : "No annotation yet."] });
    }
  }

  const files = order.map((name) => {
    const m = meta.get(name)!;
    return {
      ...byFile.get(name)!,
      tier: m.tier,
      whys: m.whys,
      flags: (ann?.flags ?? []).filter((fl) => fl.file === name),
      overridden: ann?.overrides.find((o) => o.file === name)?.rule ?? null,
    };
  });
  // Stable sort by tier keeps the annotator's reading order within each tier.
  return files.sort((a, b) => rank(a.tier) - rank(b.tier));
}

function loadReviewed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** How often the viewer asks whether classification has finished. */
const POLL_MS = 1000;

export function App() {
  const [payload, { refetch }] = createResource(fetchReview);
  const status = () => payload.latest?.status;
  // Poll while the model runs; the diff is already on screen, the order arrives with the annotation.
  createEffect(() => {
    if (status()?.state !== "classifying") return;
    const timer = setTimeout(() => void refetch(), POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  // Each poll returns a new object; only rebuild (and reset expand state) when the diff or annotation changes.
  const review = createMemo(() => payload.latest, undefined, {
    equals: (a, b) => !!a && !!b && a.pr.headRefOid === b.pr.headRefOid && a.annotation?.createdAt === b.annotation?.createdAt,
  });
  const files = createMemo(() => (review() ? buildFiles(review()!) : []));
  const storageKey = () => `changestack:reviewed:pr-${review()?.pr.number ?? 0}:${review()?.pr.headRefOid ?? "none"}`;

  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [reviewed, setReviewed] = createSignal(new Set<string>());

  createEffect(() => {
    setExpanded(new Set(files().filter((f) => !COLLAPSED_BY_DEFAULT.includes(f.tier)).map((f) => f.file)));
    setReviewed(loadReviewed(storageKey()));
  });

  // Drafts live on the server (`.git/changestack/drafts/`), keyed by branch.
  const [draftSet, { mutate: setDraftSet }] = createResource(fetchDrafts);
  const drafts = () => draftSet()?.drafts ?? [];
  const [draftError, setDraftError] = createSignal<string | null>(null);
  const [composer, setComposer] = createSignal<ComposerTarget | null>(null);
  const [composerText, setComposerText] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  const saveDrafts = async (op: () => Promise<Awaited<ReturnType<typeof fetchDrafts>>>) => {
    try {
      setDraftSet(await op());
      setDraftError(null);
      return true;
    } catch (e) {
      setDraftError(String(e));
      return false;
    }
  };

  // The diff may have moved on since a draft was written: find its line again, or mark it outdated.
  createEffect(() => {
    if (!review() || draftSet.state !== "ready") return;
    const changed = reanchor(drafts(), files());
    if (changed.length) void saveDrafts(() => putDrafts(changed));
  });

  const activeByAnchor = createMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of drafts()) {
      if (d.status !== "active") continue;
      const k = anchorKey(d.file, d.side, d.line);
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return m;
  });
  const outdatedByFile = createMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of drafts()) if (d.status === "outdated") m.set(d.file, [...(m.get(d.file) ?? []), d]);
    return m;
  });
  const draftCount = (file: string) => drafts().filter((d) => d.file === file).length;

  const openComposer = (target: ComposerTarget, text = "") => {
    setComposerText(text);
    setComposer(target);
  };
  const commentOn = (file: string, line: DiffLine) => {
    const a = anchorOf(line);
    if (a) openComposer({ file, side: a.side, line: a.line, lineText: line.text, editingId: null });
  };
  const editDraft = (d: Draft) =>
    openComposer({ file: d.file, side: d.side, line: d.line, lineText: d.lineText, editingId: d.id }, d.body);
  const submitComposer = async () => {
    const c = composer();
    const body = composerText().trim();
    if (!c || !body) return;
    const now = new Date().toISOString();
    const existing = c.editingId ? drafts().find((d) => d.id === c.editingId) : undefined;
    const draft: Draft = existing
      ? { ...existing, body, updatedAt: now }
      : { id: newId(), file: c.file, side: c.side, line: c.line, lineText: c.lineText, body, status: "active", createdAt: now, updatedAt: now };
    // Keep the box open with its text if the save fails.
    if (await saveDrafts(() => putDrafts([draft]))) setComposer(null);
  };
  const deleteDraft = (d: Draft) => {
    if (composer()?.editingId === d.id) setComposer(null);
    void saveDrafts(() => removeDraft(d.id));
  };

  const fileOrder = () => files().map((f) => f.file);
  const sortedDrafts = createMemo(() => {
    const order = fileOrder();
    return [...drafts()].sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file) || a.line - b.line);
  });
  const copyPrompt = async () => {
    try {
      await copyText(draftsPrompt(drafts(), fileOrder()));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setDraftError(String(e));
    }
  };

  // Submit review: two steps (button, then confirm) so nothing posts by accident.
  const [confirming, setConfirming] = createSignal(false);
  const [reviewBody, setReviewBody] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitted, setSubmitted] = createSignal<SubmitResult | null>(null);
  const outdatedCount = () => drafts().filter((d) => d.status === "outdated").length;
  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await submitReview(reviewBody().trim() || undefined);
      setSubmitted(result);
      setConfirming(false);
      setReviewBody("");
      setComposer(null);
      setDraftError(null);
      setDraftSet(await fetchDrafts());
    } catch (e) {
      // Drafts are untouched on failure; the server only clears them after GitHub accepts.
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = (set: () => Set<string>, write: (s: Set<string>) => void, file: string) => {
    const next = new Set(set());
    next.has(file) ? next.delete(file) : next.add(file);
    write(next);
  };
  const toggleExpanded = (file: string) => toggle(expanded, setExpanded, file);
  const toggleReviewed = (file: string) => {
    toggle(reviewed, setReviewed, file);
    try {
      localStorage.setItem(storageKey(), JSON.stringify([...reviewed()]));
    } catch {
      // per-viewer convenience only
    }
    // Reviewing a file collapses it, so the next one moves up.
    if (reviewed().has(file) && expanded().has(file)) toggleExpanded(file);
  };

  /**
   * Flat row list: one header per file; for expanded files, outdated drafts first,
   * then each line followed by its drafts and the comment box if it's open there.
   */
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const open = expanded();
    const c = composer();
    const byAnchor = activeByAnchor();
    const pushDraft = (fileIdx: number, draft: Draft) =>
      out.push(c?.editingId === draft.id ? { type: "composer", fileIdx } : { type: "draft", fileIdx, draft });
    files().forEach((f, fileIdx) => {
      out.push({ type: "header", fileIdx });
      if (!open.has(f.file)) return;
      for (const d of outdatedByFile().get(f.file) ?? []) pushDraft(fileIdx, d);
      for (const line of f.lines) {
        out.push({ type: "line", fileIdx, line });
        const a = anchorOf(line);
        if (!a) continue;
        for (const d of byAnchor.get(anchorKey(f.file, a.side, a.line)) ?? []) pushDraft(fileIdx, d);
        if (c && !c.editingId && c.file === f.file && c.side === a.side && c.line === a.line) {
          out.push({ type: "composer", fileIdx });
        }
      }
    });
    return out;
  });
  const headerRowIndex = createMemo(() => {
    const m = new Map<number, number>();
    rows().forEach((r, i) => r.type === "header" && m.set(r.fileIdx, i));
    return m;
  });

  let scroller!: HTMLDivElement;
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scroller,
    estimateSize: (i) => {
      const t = rows()[i]?.type;
      return t === "header" ? HEADER_H : t === "draft" ? DRAFT_H : t === "composer" ? COMPOSER_H : LINE_H;
    },
    overscan: 30,
  });
  // Row indexes shift when files expand/collapse; drop cached sizes.
  createEffect(() => {
    rows();
    virtualizer.measure();
  });

  const [cursor, setCursor] = createSignal(0);
  const jumpTo = (fileIdx: number) => {
    const max = files().length - 1;
    const idx = Math.max(0, Math.min(max, fileIdx));
    setCursor(idx);
    const row = headerRowIndex().get(idx);
    if (row !== undefined) virtualizer.scrollToIndex(row, { align: "start" });
  };

  const jumpToDraft = (d: Draft) => {
    const fileIdx = files().findIndex((f) => f.file === d.file);
    if (fileIdx === -1) return;
    setCursor(fileIdx);
    if (!expanded().has(d.file)) toggleExpanded(d.file);
    const row = rows().findIndex((r) => r.type === "draft" && r.draft.id === d.id);
    if (row !== -1) virtualizer.scrollToIndex(row, { align: "center" });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
    if (e.metaKey || e.ctrlKey) return;
    const current = files()[cursor()];
    if (e.key === "j") jumpTo(cursor() + 1);
    else if (e.key === "k") jumpTo(cursor() - 1);
    else if (e.key === "x" && current) toggleExpanded(current.file);
    else if (e.key === "r" && current) toggleReviewed(current.file);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const generalFlags = () => (review()?.annotation?.flags ?? []).filter((f) => !f.file);
  const elapsed = () => {
    const st = status();
    return st?.state === "classifying" ? Math.max(0, Math.round((now() - Date.parse(st.startedAt)) / 1000)) : 0;
  };

  return (
    <div class="layout">
      <aside class="sidebar">
        <header class="brand">changestack</header>
        <Show when={payload.error}>
          <p class="error">Couldn't load review: {String(payload.error)}</p>
        </Show>
        <Show when={review()?.pr}>
          {(pr) => (
            <div class="pr">
              <a class="pr-title" href={pr().url} target="_blank" rel="noreferrer">
                #{pr().number} {pr().title}
              </a>
              <span class="muted pr-refs">
                {pr().headRefName} → {pr().baseRefName} @ {pr().headRefOid.slice(0, 7)}
              </span>
            </div>
          )}
        </Show>
        <Switch>
          <Match when={status()?.state === "classifying" && status()}>
            {(st) => {
              const c = st() as Extract<NonNullable<ReturnType<typeof status>>, { state: "classifying" }>;
              return (
                <div class="progress" role="status">
                  <span class="spinner" aria-hidden="true" />
                  <div>
                    <div>
                      Classifying {c.files} file{c.files === 1 ? "" : "s"} with {c.model} · {elapsed()}s
                    </div>
                    <div class="muted">{c.detail} Showing the raw diff until it finishes.</div>
                  </div>
                </div>
              );
            }}
          </Match>
          <Match when={status()?.state === "error" && status()}>
            {(st) => (
              <p class="error">
                Classification failed: {(st() as { message: string }).message} Showing the raw diff; rerun with{" "}
                <code>changestack --refresh</code>.
              </p>
            )}
          </Match>
        </Switch>
        <Show when={review()?.annotation}>
          {(ann) => (
            <>
              <p class="summary">{ann().summary}</p>
              <p class="muted meta">
                {ann().model}
                {status()?.state === "ready" && (status() as { cached: boolean }).cached ? " · cached" : ""}
                {ann().transcripts.length
                  ? ` · ${ann().transcripts.length} session transcript${ann().transcripts.length === 1 ? "" : "s"}`
                  : " · diff only, no transcript found"}
              </p>
            </>
          )}
        </Show>

        <Show when={generalFlags().length}>
          <section>
            <h2>Flags</h2>
            <For each={generalFlags()}>
              {(fl) => (
                <div class={`flag flag-${fl.kind}`}>
                  <span class="flag-kind">{fl.kind}</span> {fl.note}
                </div>
              )}
            </For>
          </section>
        </Show>

        <section>
          <h2>
            Drafts <span class="muted">{drafts().length}</span>
          </h2>
          <Show when={draftError()}>
            <p class="error">{draftError()}</p>
          </Show>
          <Show when={submitted()}>
            {(r) => (
              <p class="ok">
                Posted review with {r().posted} comment{r().posted === 1 ? "" : "s"}
                {r().inBody ? ` (+${r().inBody} outdated in the body)` : ""}.{" "}
                <a href={r().url} target="_blank" rel="noreferrer">View on GitHub</a>
              </p>
            )}
          </Show>
          <Show
            when={drafts().length}
            fallback={<p class="muted">Click + next to a line to leave a comment. Drafts stay on this machine until you submit.</p>}
          >
            <div class="draft-actions">
              <button class="copy-prompt" onClick={copyPrompt}>
                {copied() ? "Copied" : "Copy all as prompt"}
              </button>
              <Show when={!confirming()}>
                <button class="primary" onClick={() => { setSubmitted(null); setConfirming(true); }}>
                  Submit review
                </button>
              </Show>
            </div>
            <Show when={confirming()}>
              <div class="confirm">
                <p>
                  Post {drafts().length} draft{drafts().length === 1 ? "" : "s"} to{" "}
                  <b>#{review()?.pr.number}</b> on GitHub as you, as one comment-only review
                  {outdatedCount() ? `; ${outdatedCount()} outdated go in the review body` : ""}.
                </p>
                <textarea
                  rows={3}
                  placeholder="Optional overall comment"
                  value={reviewBody()}
                  onInput={(e) => setReviewBody(e.currentTarget.value)}
                />
                <div class="composer-actions">
                  <button class="link" disabled={submitting()} onClick={() => setConfirming(false)}>cancel</button>
                  <button class="primary" disabled={submitting()} onClick={submit}>
                    {submitting() ? "Posting…" : "Post review"}
                  </button>
                </div>
              </div>
            </Show>
            <For each={sortedDrafts()}>
              {(d) => (
                <button class="draft-link" onClick={() => jumpToDraft(d)}>
                  <span class="draft-where">
                    {d.file.split("/").pop()}:{d.line}
                    <Show when={d.status === "outdated"}>
                      <span class="outdated">outdated</span>
                    </Show>
                  </span>
                  <span class="draft-preview">{d.body}</span>
                </button>
              )}
            </For>
          </Show>
        </section>

        <section>
          <h2>
            Files <span class="muted">{reviewed().size}/{files().length} reviewed</span>
          </h2>
          <For each={files()}>
            {(f, i) => (
              <button
                class="file-link"
                classList={{ active: cursor() === i(), done: reviewed().has(f.file) }}
                onClick={() => jumpTo(i())}
              >
                <span class={`tier tier-${f.tier}`}>{f.tier}</span>
                <span class="file-name">{f.file}</span>
                <Show when={f.flags.length}>
                  <span class="flag-count">{f.flags.length}</span>
                </Show>
                <Show when={draftCount(f.file)}>
                  {(n) => <span class="draft-count" title="Draft comments">{n()}</span>}
                </Show>
              </button>
            )}
          </For>
        </section>
        <p class="muted keys">j/k next/prev · x expand · r reviewed · ⌘/Ctrl+Enter save comment · Esc cancel</p>
      </aside>

      <main class="diff" ref={scroller}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const row = () => rows()[item.index]!;
              const file = () => files()[row().fileIdx]!;
              // Draft and comment rows vary in height: the virtualizer measures every row element
              // (a ResizeObserver keeps it current when a row changes type), fixed rows keep their height.
              const measured = () => row().type === "draft" || row().type === "composer";
              return (
                <div
                  class="row"
                  data-index={item.index}
                  ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                  style={{ transform: `translateY(${item.start}px)`, height: measured() ? undefined : `${row().type === "header" ? HEADER_H : LINE_H}px` }}
                >
                  <Switch>
                    <Match when={row().type === "header"}>
                      <FileHeader
                        file={file()}
                        expanded={expanded().has(file().file)}
                        reviewed={reviewed().has(file().file)}
                        drafts={draftCount(file().file)}
                        onToggle={() => toggleExpanded(file().file)}
                        onReviewed={() => toggleReviewed(file().file)}
                      />
                    </Match>
                    <Match when={row().type === "line" && (row() as Extract<Row, { type: "line" }>)}>
                      {(lr) => <LineRow line={lr().line} onComment={() => commentOn(file().file, lr().line)} />}
                    </Match>
                    <Match when={row().type === "draft" && (row() as Extract<Row, { type: "draft" }>)}>
                      {(dr) => (
                        <DraftRow draft={dr().draft} onEdit={() => editDraft(dr().draft)} onDelete={() => deleteDraft(dr().draft)} />
                      )}
                    </Match>
                    <Match when={row().type === "composer"}>
                      <CommentBox
                        target={composer()!}
                        text={composerText()}
                        onInput={setComposerText}
                        onSubmit={submitComposer}
                        onCancel={() => setComposer(null)}
                      />
                    </Match>
                  </Switch>
                </div>
              );
            }}
          </For>
        </div>
      </main>
    </div>
  );
}

function FileHeader(props: {
  file: ReviewFile;
  expanded: boolean;
  reviewed: boolean;
  drafts: number;
  onToggle: () => void;
  onReviewed: () => void;
}) {
  return (
    <div class="file-header" classList={{ done: props.reviewed }}>
      <div class="file-header-top">
        <button class="chevron" onClick={props.onToggle}>{props.expanded ? "▾" : "▸"}</button>
        <span class={`tier tier-${props.file.tier}`}>{props.file.tier}</span>
        <span class="file-path">{props.file.file}</span>
        <span class="stat add">+{props.file.additions}</span>
        <span class="stat del">−{props.file.deletions}</span>
        <Show when={props.file.overridden}>
          {(rule) => <span class="override" title="Tier forced by rule">rule: {rule()}</span>}
        </Show>
        <Show when={props.drafts}>
          <span class="draft-count" title="Draft comments">{props.drafts} draft{props.drafts === 1 ? "" : "s"}</span>
        </Show>
        <label class="reviewed">
          <input type="checkbox" checked={props.reviewed} onChange={props.onReviewed} /> reviewed
        </label>
      </div>
      <div class="file-header-why">
        <For each={props.file.flags}>
          {(fl) => <span class={`flag-inline flag-${fl.kind}`}>{fl.kind}: {fl.note}</span>}
        </For>
        <span class="why">{props.file.whys.join(" · ")}</span>
      </div>
    </div>
  );
}

function LineRow(props: { line: DiffLine; onComment: () => void }) {
  return (
    <div class={`line line-${props.line.kind}`}>
      <Show when={anchorOf(props.line)} fallback={<span class="add-comment" />}>
        <button class="add-comment" title="Comment on this line" onClick={props.onComment}>
          +
        </button>
      </Show>
      <span class="ln">{props.line.oldNo ?? ""}</span>
      <span class="ln">{props.line.newNo ?? ""}</span>
      <span class="code">{props.line.text}</span>
    </div>
  );
}

function DraftRow(props: { draft: Draft; onEdit: () => void; onDelete: () => void }) {
  return (
    <div class="draft" classList={{ "draft-outdated": props.draft.status === "outdated" }}>
      <div class="draft-meta">
        <span>Draft</span>
        <Show when={props.draft.status === "outdated"}>
          <span class="outdated" title="This line changed since the comment was written">
            outdated · was line {props.draft.line}: <code>{props.draft.lineText.trim()}</code>
          </span>
        </Show>
        <button class="link" onClick={props.onEdit}>edit</button>
        <button class="link danger" onClick={props.onDelete}>delete</button>
      </div>
      <div class="draft-body">{props.draft.body}</div>
    </div>
  );
}

function CommentBox(props: {
  target: ComposerTarget;
  text: string;
  onInput: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      props.onSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    }
  };
  return (
    <div class="draft composer">
      <textarea
        ref={(el) => queueMicrotask(() => el.focus())}
        rows={3}
        placeholder={`Comment on ${props.target.file}:${props.target.line}`}
        value={props.text}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div class="composer-actions">
        <button class="link" onClick={props.onCancel}>cancel</button>
        <button class="primary" disabled={!props.text.trim()} onClick={props.onSubmit}>
          {props.target.editingId ? "Update draft" : "Save draft"}
        </button>
      </div>
    </div>
  );
}
