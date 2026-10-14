import type { Annotation, Flag, ReviewPayload, Tier } from "@changestack/schema";
import { TIER_ORDER } from "@changestack/schema/tiers";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { type DiffLine, type ParsedFile, parseDiff } from "./diff";

interface ReviewFile extends ParsedFile {
  tier: Tier;
  whys: string[];
  flags: Flag[];
  overridden: string | null;
}

type Row =
  | { type: "header"; fileIdx: number }
  | { type: "line"; fileIdx: number; line: DiffLine };

const HEADER_H = 56;
const LINE_H = 20;
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

export function App() {
  const [payload] = createResource(fetchReview);
  const files = createMemo(() => (payload() ? buildFiles(payload()!) : []));
  const storageKey = () => `changestack:reviewed:${payload()?.annotation?.createdAt ?? "none"}`;

  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [reviewed, setReviewed] = createSignal(new Set<string>());

  createEffect(() => {
    setExpanded(new Set(files().filter((f) => !COLLAPSED_BY_DEFAULT.includes(f.tier)).map((f) => f.file)));
    setReviewed(loadReviewed(storageKey()));
  });

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

  /** Flat row list: one header per file, lines only for expanded files. */
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const open = expanded();
    files().forEach((f, fileIdx) => {
      out.push({ type: "header", fileIdx });
      if (open.has(f.file)) for (const line of f.lines) out.push({ type: "line", fileIdx, line });
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
    estimateSize: (i) => (rows()[i]?.type === "header" ? HEADER_H : LINE_H),
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

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    const current = files()[cursor()];
    if (e.key === "j") jumpTo(cursor() + 1);
    else if (e.key === "k") jumpTo(cursor() - 1);
    else if (e.key === "x" && current) toggleExpanded(current.file);
    else if (e.key === "r" && current) toggleReviewed(current.file);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const generalFlags = () => (payload()?.annotation?.flags ?? []).filter((f) => !f.file);

  return (
    <div class="layout">
      <aside class="sidebar">
        <header class="brand">changestack</header>
        <Show when={payload.error}>
          <p class="error">Couldn't load review: {String(payload.error)}</p>
        </Show>
        <Show when={payload() && !payload()!.annotation}>
          <p class="muted">No annotation yet — run <code>changestack annotate</code>. Showing raw diff.</p>
        </Show>
        <Show when={payload()?.annotation}>
          {(ann) => <p class="summary">{ann().summary}</p>}
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
              </button>
            )}
          </For>
        </section>
        <p class="muted keys">j/k next/prev · x expand · r reviewed</p>
      </aside>

      <main class="diff" ref={scroller}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const row = () => rows()[item.index]!;
              const file = () => files()[row().fileIdx]!;
              return (
                <div
                  class="row"
                  style={{ transform: `translateY(${item.start}px)`, height: `${item.size}px` }}
                >
                  <Show
                    when={row().type === "header"}
                    fallback={<LineRow line={(row() as Extract<Row, { type: "line" }>).line} />}
                  >
                    <FileHeader
                      file={file()}
                      expanded={expanded().has(file().file)}
                      reviewed={reviewed().has(file().file)}
                      onToggle={() => toggleExpanded(file().file)}
                      onReviewed={() => toggleReviewed(file().file)}
                    />
                  </Show>
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

function LineRow(props: { line: DiffLine }) {
  return (
    <div class={`line line-${props.line.kind}`}>
      <span class="ln">{props.line.oldNo ?? ""}</span>
      <span class="ln">{props.line.newNo ?? ""}</span>
      <span class="code">{props.line.text}</span>
    </div>
  );
}
