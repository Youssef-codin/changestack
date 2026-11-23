import type { Draft } from "@changestack/schema";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { type DiffLine } from "./diff";
import { type DisplayRow, displayRows, outermost } from "./folds";
import { anchorOf } from "./drafts";
import { commentPrefix, highlight } from "./highlight";
import { Icon } from "./icons";
import { FLAG_ICON, type FlagItem, featureGroups, flagColor, type Group, LINE_H, OTHER, type ReviewFile, tierGroups } from "./model";
import { LINE_CAP, useStore } from "./store";
import { FileName, FlagIcon, GroupSwitch, plural, TierBadge, TierTag, TopBar, VerdictChip } from "./ui";

/** Height of the sticky tool row over the diff. */
const TOOLS_H = 54;
const NOTES_W = 320;
const RAIL_W = 300;
const MARKERS_W = 56;

/**
 * Review, "Margin" layout (docs/design/review-layouts.html#margin): files, flags and drafts
 * on the left; the diff on paper; notes in a margin beside the code, lined up with their
 * line, so the code is never split.
 */
export function Review() {
  const s = useStore();
  let scroller!: HTMLElement;

  // What the diff column lists: files in reading order, and By feature, a heading before each feature's files.
  const entries = createMemo<(ReviewFile | Group)[]>(() => {
    if (s.groupBy() === "tier") return s.order();
    const out: (ReviewFile | Group)[] = [];
    const seen = new Set<string>();
    for (const g of featureGroups(s.model())) {
      const fresh = g.files.filter((f) => !seen.has(f.file));
      if (!fresh.length) continue;
      out.push(g, ...fresh);
      for (const f of fresh) seen.add(f.file);
    }
    return out;
  });

  // Track the file at the top of the diff: whichever file crosses a thin band just under the
  // tool row. An observer instead of measuring on every scroll frame, which forced layout.
  const atTop = new Set<string>();
  let io: IntersectionObserver | undefined;
  const pickCurrent = () => {
    if (s.jump()) return;
    const first = s.order().find((f) => atTop.has(f.file));
    if (first) s.setCurrent(first.file);
  };
  const observeAll = () => {
    if (!io) return;
    io.disconnect();
    atTop.clear();
    for (const el of scroller.querySelectorAll<HTMLElement>("section[data-file]")) io.observe(el);
  };
  onMount(() => {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const file = (e.target as HTMLElement).dataset.file!;
          e.isIntersecting ? atTop.add(file) : atTop.delete(file);
        }
        pickCurrent();
      },
      { root: scroller, rootMargin: `-${TOOLS_H + 1}px 0px -80% 0px` },
    );
    observeAll();
    if (!s.jump()) s.setCurrent(s.order()[0]?.file ?? null);
  });
  onCleanup(() => io?.disconnect());
  createEffect(on(entries, () => queueMicrotask(observeAll), { defer: true }));

  // Scroll to a pending jump once it's rendered, gliding there. Off-screen files skip layout
  // (content-visibility), so their height is a guess until they render: after each glide, measure
  // again and glide the rest of the way (a few passes at most). Reduced motion jumps instantly.
  createEffect(
    on(s.jump, (j) => {
      if (!j) return;
      const target = () => {
        const lineEl = j.line != null ? document.getElementById(`L:${j.file}:${j.side ?? "new"}:${j.line}`) : null;
        const el = lineEl ?? document.getElementById(`F:${j.file}`);
        if (!el) return null;
        const want = lineEl ? offsetIn(lineEl, scroller) - scroller.clientHeight / 2 + LINE_H / 2 : offsetIn(el, scroller) - TOOLS_H;
        return Math.max(0, Math.min(want, scroller.scrollHeight - scroller.clientHeight));
      };
      const finish = () => {
        s.setJump(null);
        s.setCurrent(j.file);
        if (j.line != null) flash(s.litKey(j.file, j.side ?? "new", j.line));
      };
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches || !("onscrollend" in window);
      let passes = 0;
      // Set when a glide stalls (no scrollend): the rest of the way is an instant jump.
      let instant = still;
      const step = () => {
        const want = target();
        if (want === null) return ++passes < 12 ? requestAnimationFrame(step) : finish();
        if (Math.abs(scroller.scrollTop - want) <= 2 || passes >= 12) return finish();
        passes++;
        if (instant || passes > 3) {
          scroller.scrollTop = want;
          requestAnimationFrame(step);
        } else {
          // Next pass when the glide ends; if the browser never says so, carry on anyway.
          let done = false;
          const next = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            requestAnimationFrame(step);
          };
          const timer = setTimeout(() => {
            instant = true;
            next();
          }, 1200);
          scroller.addEventListener("scrollend", next, { once: true });
          scroller.scrollTo({ top: want, behavior: "smooth" });
        }
      };
      requestAnimationFrame(step);
    }),
  );
  const flash = (key: string) => {
    s.setLit(key);
    setTimeout(() => s.lit() === key && s.setLit(null), 1200);
  };

  // ---------- keyboard ----------
  const step = (d: number) => {
    const files = s.order();
    const i = files.findIndex((f) => f.file === (s.jump()?.file ?? s.current()));
    const next = files[Math.max(0, Math.min(files.length - 1, i + d))];
    if (next) s.go("review", { file: next.file });
  };
  const nextFlag = (d: number) => {
    const order = s.order().map((f) => f.file);
    const flags = s.openFlags().filter((f) => f.file).sort((a, b) => order.indexOf(a.file!) - order.indexOf(b.file!) || (a.line ?? 0) - (b.line ?? 0));
    if (!flags.length) return;
    const cur = order.indexOf(s.current() ?? "");
    const after = d > 0 ? flags.find((f) => order.indexOf(f.file!) > cur) ?? flags[0] : [...flags].reverse().find((f) => order.indexOf(f.file!) < cur) ?? flags.at(-1);
    if (after) s.goFlag(after);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (s.drawer()) s.setDrawer(false);
      else if (s.composer()) s.setComposer(null);
      return;
    }
    if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey || s.drawer()) return;
    const cur = s.current();
    if (e.key === "j") step(1);
    else if (e.key === "k") step(-1);
    else if (e.key === "n") nextFlag(1);
    else if (e.key === "N") nextFlag(-1);
    else if (e.key === "r" && cur) s.toggleReviewed(cur);
    else if (e.key === "x" && cur) s.toggleCollapsed(cur);
    else if (e.key === "[") s.setRailOpen(!s.railOpen());
    else if (e.key === "]") s.setNotesOpen(!s.notesOpen());
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="flex h-dvh flex-col">
      <TopBar
        right={
          <>
            <VerdictChip />
            <ProgressRing />
          </>
        }
      />
      <div
        class="relative grid min-h-0 flex-1 transition-[grid-template-columns] duration-300 ease-[cubic-bezier(.2,.7,.2,1)] lg:grid-cols-[var(--rw)_minmax(0,1fr)]"
        style={{ "--rw": s.railOpen() ? `${RAIL_W}px` : "0px" }}
      >
        <PanelHandle
          side="left"
          open={s.railOpen()}
          onToggle={() => s.setRailOpen(!s.railOpen())}
          class="max-lg:hidden"
          style={{ top: `${TOOLS_H / 2 - 13}px`, left: s.railOpen() ? `${RAIL_W - 13}px` : "14px" }}
        />
        <Rail />
        <main
          ref={scroller}
          // Solid background: a striped one stays still under moving code, which forced Chrome to blend
          // a transparent code layer every frame. The stripe lives on the content wrapper below instead.
          class="relative min-w-0 overflow-x-hidden overflow-y-auto bg-code"
          style={{ "--nw": s.notesOpen() ? `${NOTES_W}px` : "0px", transition: "--nw .3s cubic-bezier(.2,.7,.2,1)" }}
        >
          <Tools />
          <div class="paper" style={{ "min-height": `calc(100% - ${TOOLS_H}px)` }}>
          <Show when={s.status()?.state === "classifying"}>
            <div class="flex items-center gap-2 border-b border-ln px-8 py-2 text-[13px] text-mu" role="status">
              <Icon name="progress_activity" class="spin text-[16px]" />
              Classifying with {(s.status() as { model: string }).model}. Showing the diff in GitHub order until it finishes.
            </div>
          </Show>
          <For each={entries()} fallback={<EmptyDiff />}>
            {(e) => ("file" in e ? <FileBlock file={e} /> : <FeatureHead group={e} />)}
          </For>
          <Show when={s.order().length}>
            <EndOfDiff />
          </Show>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Round handle on a side column's edge that collapses or opens it. Left: the file column.
 * Right: the notes margin (folds to markers). Shows a count badge while the notes are folded.
 */
function PanelHandle(props: {
  side: "left" | "right";
  open: boolean;
  onToggle: () => void;
  count?: number;
  /** Position follows an animating variable already, so don't also transition it. */
  follow?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
}) {
  const what = () => (props.side === "left" ? "files" : "notes");
  const label = () => `${props.open ? "Collapse" : "Show"} ${what()} (${props.side === "left" ? "[" : "]"})`;
  const icon = () =>
    props.side === "left" ? (props.open ? "left_panel_close" : "left_panel_open") : props.open ? "right_panel_close" : "right_panel_open";
  return (
    <button
      class={`absolute z-20 grid size-[26px] place-items-center rounded-full bg-code text-[16px] text-mu shadow-[inset_0_0_0_1px_var(--color-ln),0_1px_3px_rgb(0_0_0/.08)] duration-300 ease-[cubic-bezier(.2,.7,.2,1)] hover:text-tx hover:shadow-[inset_0_0_0_1px_var(--color-mu)] ${props.follow ? "transition-[color,box-shadow]" : "transition-[left,right,color,box-shadow]"} ${props.class ?? ""}`}
      style={props.style}
      title={label()}
      aria-label={label()}
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <Icon name={icon()} />
      <Show when={!props.open && props.count}>
        <span class="pop absolute -top-[5px] -right-1.5 h-[15px] min-w-[15px] rounded-full bg-pk px-[3px] text-center font-mono text-[10px] leading-[15px] font-semibold text-ink">
          {props.count}
        </span>
      </Show>
    </button>
  );
}

/** By feature: what this run of files builds, before its first file. */
function FeatureHead(props: { group: Group }) {
  const s = useStore();
  const flags = () => props.group.files.reduce((n, f) => n + f.flags.filter((fl) => !s.resolved().has(fl.id)).length, 0);
  return (
    <div class="rise flex items-center gap-3 border-t border-ln pt-7 pr-7 pb-1 pl-4 first-of-type:border-t-0 sm:pl-8" style={{ "margin-right": "var(--nw)" }}>
      <span class="grid size-10 shrink-0 place-items-center rounded-full bg-pkbg text-[20px] text-pkink">
        <Icon name={props.group.name === OTHER ? "folder_open" : "category"} />
      </span>
      <div class="min-w-0">
        <b class="text-[17px] font-semibold">{props.group.name}</b>
        <p class="m-0 text-sm text-mu">
          {props.group.why ? `${props.group.why} ` : ""}
          {plural(props.group.files.length, "file")}
          {flags() ? `, ${plural(flags(), "open flag")}` : ""}.
        </p>
      </div>
    </div>
  );
}

/** Top offset of `el` inside the scroll container. */
function offsetIn(el: HTMLElement, container: HTMLElement): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function ProgressRing() {
  const s = useStore();
  const total = () => s.files().length;
  const done = () => s.files().filter((f) => s.reviewed().has(f.file)).length;
  const c = 2 * Math.PI * 9;
  return (
    <span class="inline-flex items-center gap-[7px] text-[13px] whitespace-nowrap text-mu max-sm:hidden">
      <Show
        when={total() > 0 && done() === total()}
        fallback={
          <svg viewBox="0 0 24 24" class="size-[22px] -rotate-90" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke-width="3.5" class="stroke-ln" />
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke-width="3.5"
              stroke-linecap="round"
              class="stroke-pk transition-[stroke-dasharray] duration-500"
              stroke-dasharray={`${total() ? (c * done()) / total() : 0} ${c}`}
            />
          </svg>
        }
      >
        <span class="grid size-[22px] place-items-center rounded-full bg-pk text-[15px] text-ink" title="Every file reviewed">
          <Icon name="check" />
        </span>
      </Show>
      <span>
        <b class="font-semibold text-tx">{done()}</b> of {total()} reviewed
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- left column

function Rail() {
  const s = useStore();
  const total = () => s.files().length;
  const done = () => s.files().filter((f) => s.reviewed().has(f.file)).length;
  const count = (files: ReviewFile[]) => `${files.filter((f) => s.reviewed().has(f.file)).length}/${files.length}`;
  return (
    <aside
      class="flex min-h-0 flex-col overflow-hidden bg-(--side) max-lg:hidden [&>*]:w-[300px] [&>*]:shrink-0"
      // Full-height edge: the handle sits on this line, as in the design.
      classList={{ "border-r border-ln": s.railOpen() }}
      aria-hidden={!s.railOpen()}
      inert={!s.railOpen()}
    >
      <nav class="scroll-quiet min-h-0 flex-1 overflow-auto pt-1.5 pr-3.5 pb-2.5 pl-[18px]" aria-label="Files">
        <Show
          when={s.groupBy() === "feature"}
          fallback={
            <For each={tierGroups(s.files())}>
              {(g, i) => (
                <Fold index={i()} summary={<GroupHead icon={<TierBadge tier={g.tier} size="lg" />} label={g.tier} count={count(g.files)} />}>
                  <div class="kids">
                    <For each={g.files}>{(f) => <FileRow file={f} />}</For>
                  </div>
                </Fold>
              )}
            </For>
          }
        >
          <For each={featureGroups(s.model())}>
            {(g, i) => (
              <Fold index={i()} summary={<GroupHead icon={<Icon name={g.name === OTHER ? "folder_open" : "category"} class="text-[16px]" />} label={g.name} count={count(g.files)} title={g.why} />}>
                <div class="kids">
                  <For each={tierGroups(g.files)}>
                    {(t) => (
                      <details class="fold" open>
                        <summary class="flex cursor-pointer items-center gap-1.5 rounded-full py-1 pr-1 pl-0.5 text-xs font-semibold capitalize hover:bg-hov">
                          <Icon name="keyboard_arrow_down" class="chev -mr-[5px] -ml-1 text-[18px] text-mu" />
                          <TierBadge tier={t.tier} size="sm" />
                          {t.tier}
                          <em class="ml-auto font-mono text-[11px] font-medium text-mu not-italic">{count(t.files)}</em>
                        </summary>
                        <div class="kids">
                          <For each={t.files}>{(f) => <FileRow file={f} />}</For>
                        </div>
                      </details>
                    )}
                  </For>
                </div>
              </Fold>
            )}
          </For>
        </Show>
      </nav>

      <Show when={s.model().flags.length}>
        <div class="scroll-quiet max-h-[30vh] overflow-auto border-t border-ln pt-1 pr-3.5 pb-2.5 pl-[18px]">
          <Fold summary={<GroupHead icon={<Icon name="flag" class="text-[16px] text-tx" />} label="Flags" count={`${s.openFlags().length} open`} />}>
            <For each={s.model().flags}>{(f) => <FlagJump flag={f} />}</For>
          </Fold>
        </div>
      </Show>
      <Show when={s.drafts().length}>
        <div class="scroll-quiet fade-in max-h-[30vh] overflow-auto border-t border-ln pt-1 pr-3.5 pb-2.5 pl-[18px]">
          <Fold summary={<GroupHead icon={<Icon name="edit_note" class="text-[16px]" />} label="Your drafts" count={String(s.drafts().length)} />}>
            <For each={s.sortedDrafts()}>{(d) => <DraftJump draft={d} />}</For>
          </Fold>
        </div>
      </Show>

      <div class="flex flex-col gap-2.5 border-t border-ln pt-3 pr-3.5 pb-3.5 pl-[18px]">
        <div class="flex justify-between text-xs text-mu">
          <span>
            <b class="font-semibold text-tx">{done()}</b> of {plural(total(), "file")} reviewed
          </span>
          <span>{total() ? Math.round((done() / total()) * 100) : 0}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-[3px] bg-hov">
          <i class="block h-full bg-pk transition-[width] duration-500" style={{ width: `${total() ? (done() / total()) * 100 : 0}%` }} />
        </div>
        <GroupSwitch />
      </div>
    </aside>
  );
}

/** A collapsible group in the file column. With `index`, it rises in after the groups above it (on load and on By tier / By feature). */
function Fold(props: { summary: JSX.Element; children: JSX.Element; index?: number }) {
  return (
    <details class="fold" classList={{ rise: props.index !== undefined }} style={props.index !== undefined ? { "--i": props.index } : undefined} open>
      {props.summary}
      {props.children}
    </details>
  );
}

function GroupHead(props: { icon: JSX.Element; label: string; count: string; title?: string }) {
  return (
    <summary
      class="mt-4 mb-1 flex cursor-pointer items-center gap-2 text-xs font-semibold tracking-[.07em] text-mu uppercase hover:text-tx"
      title={props.title}
    >
      <Icon name="keyboard_arrow_down" class="chev -mr-[5px] -ml-1 text-[18px]" />
      {props.icon}
      <span class="min-w-0 truncate">{props.label}</span>
      <em class="ml-auto font-mono text-xs font-medium tracking-normal normal-case not-italic">{props.count}</em>
    </summary>
  );
}

function FileRow(props: { file: ReviewFile }) {
  const s = useStore();
  const f = props.file;
  const done = () => s.reviewed().has(f.file);
  const drafts = () => s.draftsByFile().get(f.file)?.length ?? 0;
  const kinds = () => {
    const seen = new Map<string, boolean>();
    for (const fl of f.flags) seen.set(fl.kind, (seen.get(fl.kind) ?? true) && s.resolved().has(fl.id));
    return [...seen];
  };
  return (
    <div
      class="twig my-0.5 flex items-center gap-2 rounded-full py-1 pr-2 pl-1 transition-colors duration-200"
      classList={{ "bg-pkbg": s.isCurrent(f.file), "hover:bg-hov": !s.isCurrent(f.file) }}
    >
      <button
        class="grid size-4 shrink-0 place-items-center rounded-full text-[12px]"
        classList={{ "bg-tx text-bg": done(), "shadow-[inset_0_0_0_1.5px_var(--color-ln)] hover:shadow-[inset_0_0_0_1.5px_var(--color-mu)]": !done() }}
        title={done() ? "Reviewed. Click to unmark." : "Mark reviewed"}
        aria-pressed={done()}
        onClick={() => s.toggleReviewed(f.file)}
      >
        <Show when={done()}>
          <Icon name="check" class="pop" />
        </Show>
      </button>
      <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={f.file} onClick={() => s.go("review", { file: f.file })}>
        <FileName
          name={f.label}
          class={`font-mono text-[13px] font-medium ${s.isCurrent(f.file) ? "text-pkink" : done() ? "text-mu" : ""}`}
        />
        <Show when={f.unclassified}>
          <span class="size-1.5 shrink-0 rounded-full bg-mu" title={f.unclassified!} />
        </Show>
      </button>
      <span class="flex shrink-0 items-center gap-[5px]">
        <Show when={drafts()}>
          <span class="inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold text-mu" title={plural(drafts(), "draft")}>
            <Icon name="edit_note" class="text-[14px]" />
            {drafts()}
          </span>
        </Show>
        <For each={kinds()}>{([k, res]) => <FlagIcon kind={k as FlagItem["kind"]} resolved={res} />}</For>
      </span>
    </div>
  );
}

function FlagJump(props: { flag: FlagItem }) {
  const s = useStore();
  const done = () => s.resolved().has(props.flag.id);
  const where = () => {
    const f = props.flag;
    if (!f.file) return "whole PR";
    return `${s.fileByName(f.file)?.label ?? f.file}${f.placed ? `:${f.line}` : ""}`;
  };
  return (
    <div class="group my-0.5 flex min-w-0 items-center gap-[9px] rounded-full py-1 pr-2 pl-1 hover:bg-hov" classList={{ "bg-pkbg": !!props.flag.file && s.isCurrent(props.flag.file) }}>
      <button class="flex min-w-0 flex-1 items-center gap-[9px] text-left" title={props.flag.note} onClick={() => s.goFlag(props.flag)}>
        <FlagIcon kind={props.flag.kind} resolved={done()} class="size-[22px] text-[14px]" />
        <span class="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <b class="text-[13px] font-semibold capitalize" classList={{ "text-mu line-through": done() }}>
            {props.flag.kind}
          </b>
          <small class="truncate font-mono text-xs text-mu">{where()}</small>
        </span>
      </button>
      <button
        class="grid size-6 shrink-0 place-items-center rounded-full text-[16px] text-mu group-hover:opacity-100 hover:bg-sf hover:text-tx focus-visible:opacity-100"
        classList={{ "opacity-0": !done() }}
        title={done() ? "Reopen" : "Resolve"}
        onClick={() => s.setFlagResolved(props.flag.id)}
      >
        <Icon name={done() ? "undo" : "check"} />
      </button>
    </div>
  );
}

function DraftJump(props: { draft: Draft }) {
  const s = useStore();
  const d = props.draft;
  return (
    <button class="my-0.5 flex w-full min-w-0 items-center gap-[9px] rounded-full py-1 pr-2 pl-1 text-left hover:bg-hov" onClick={() => s.goDraft(d)}>
      <span class="grid size-[22px] shrink-0 place-items-center rounded-full bg-tx text-[14px] text-bg">
        <Icon name="edit_note" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col leading-[1.3]">
        <b class="font-mono text-xs font-medium">
          {s.fileByName(d.file)?.label ?? d.file}:{d.line}
          <Show when={d.status === "outdated"}>
            <span class="ml-1.5 font-sans text-[11px] text-mu">outdated</span>
          </Show>
        </b>
        <small class="truncate text-xs text-mu">{d.body}</small>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- diff column

function Tools() {
  const s = useStore();
  const files = () => s.order();
  const idx = () => files().findIndex((f) => f.file === s.current());
  const cur = () => files()[idx()];
  const count = () => s.openFlags().filter((f) => f.file).length + s.drafts().length;
  const nav = (d: number) => {
    // Count from where a pending jump is headed, so quick repeated clicks keep moving.
    const from = files().findIndex((f) => f.file === (s.jump()?.file ?? s.current()));
    const next = files()[Math.max(0, Math.min(files().length - 1, from + d))];
    if (next) s.go("review", { file: next.file });
  };
  return (
    <div
      class="paper-solid sticky top-0 z-10 flex items-center gap-2.5 overflow-hidden border-b border-ln pl-4 text-[13px] text-mu transition-[padding-left] duration-300 sm:pl-8"
      classList={{ "lg:pl-14": !s.railOpen() }}
      // Content stops before the notes margin (and the handle), which slides with --nw.
      style={{ height: `${TOOLS_H}px`, "padding-right": "max(56px, calc(var(--nw) + 28px))" }}
    >
      <button class="grid size-[30px] place-items-center rounded-full text-[20px] text-tx shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov" title="Previous file (k)" onClick={() => nav(-1)}>
        <Icon name="keyboard_arrow_up" />
      </button>
      <button class="grid size-[30px] place-items-center rounded-full text-[20px] text-tx shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov" title="Next file (j)" onClick={() => nav(1)}>
        <Icon name="keyboard_arrow_down" />
      </button>
      <Show when={cur()}>
        {(f) => (
          <>
            <span class="shrink-0 whitespace-nowrap max-md:hidden">
              {idx() + 1} of {files().length}
            </span>
            <TierBadge tier={f().tier} />
            <button class="min-w-0 truncate text-left font-mono text-tx" title={`${f().file}: back to the top of this file`} onClick={() => s.go("review", { file: f().file })}>
              <span class="text-mu max-xl:hidden">{f().dir}</span>
              <b class="font-medium">{f().name}</b>
            </button>
            <button
              class="inline-flex shrink-0 items-center gap-1.5 rounded-full py-1 pr-3 pl-1.5 text-xs font-semibold"
              classList={{ "bg-pkbg text-pkink": s.reviewed().has(f().file), "text-tx shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-pkbg": !s.reviewed().has(f().file) }}
              title="Mark reviewed (r)"
              aria-pressed={s.reviewed().has(f().file)}
              onClick={() => s.toggleReviewed(f().file)}
            >
              <Icon name={s.reviewed().has(f().file) ? "check_circle-fill" : "radio_button_unchecked"} class="text-[16px] text-pkink" />
              {s.reviewed().has(f().file) ? "Reviewed" : "Mark reviewed"}
            </button>
          </>
        )}
      </Show>
      <span class="flex-1" />
      {/* Pinned to the notes separator (--nw animates), so the label slides in and out with the margin. */}
      <span
        class="pointer-events-none absolute inset-y-0 flex items-center gap-1.5 text-xs font-semibold tracking-[.07em] whitespace-nowrap text-mu uppercase max-md:hidden"
        style={{ left: "calc(100% - var(--nw) + 26px)" }}
        aria-hidden={!s.notesOpen()}
      >
        <Icon name="sticky_note_2" class="text-[16px]" />
        Notes
        <em class="font-mono text-xs font-medium tracking-normal not-italic">{count()}</em>
      </span>
      <PanelHandle
        side="right"
        open={s.notesOpen()}
        onToggle={() => s.setNotesOpen(!s.notesOpen())}
        count={count()}
        follow
        class="top-1/2 -translate-y-1/2"
        style={{ right: "max(16px, calc(var(--nw) - 13px))" }}
      />
    </div>
  );
}

function FileBlock(props: { file: ReviewFile }) {
  const s = useStore();
  const f = props.file;
  const open = () => !s.collapsed().has(f.file);
  const done = () => s.reviewed().has(f.file);
  const shownCount = () => (s.uncapped().has(f.file) ? f.lines.length : Math.min(f.lines.length, LINE_CAP));
  // This file's folded block starts, as a string so other files' folds don't rebuild this one.
  const regions = () => s.regionsOf(f.file);
  const foldedHere = createMemo(() => regions().filter((r) => s.isFolded(f.file, r.start)).map((r) => r.start).join(","));
  const display = createMemo(() => {
    const folded = new Set(foldedHere().split(",").filter(Boolean).map(Number));
    return displayRows(f.lines, shownCount(), regions(), (st) => folded.has(st));
  });
  const runs = createMemo(() => {
    const out: { kind: DiffLine["kind"] | "fold"; rows: DisplayRow[] }[] = [];
    for (const r of display()) {
      const last = out.at(-1);
      // A folded row stays inside the block it interrupts, so the tint doesn't break around it.
      if (r.kind === "fold") {
        if (last && last.kind !== "hunk") last.rows.push(r);
        else out.push({ kind: "fold", rows: [r] });
        continue;
      }
      const kind = r.line.kind;
      if (last && last.kind === kind && kind !== "hunk") last.rows.push(r);
      else out.push({ kind, rows: [r] });
    }
    return out;
  });
  // Where each line is drawn, in rows of LINE_H. Lines inside a folded block map to its "folded" row.
  const rows = createMemo(() => {
    const m = new Map<string, number>();
    display().forEach((r, row) => {
      const mark = (l: DiffLine) => {
        const a = anchorOf(l);
        if (a) m.set(`${a.side}:${a.line}`, row);
      };
      if (r.kind === "line") mark(r.line);
      else for (let i = r.region.start + 1; i < r.region.end; i++) if (f.lines[i]) mark(f.lines[i]!);
    });
    return m;
  });
  const starts = createMemo(() => new Set(regions().map((r) => r.start)));
  const tops = createMemo(() => outermost(regions()).map((r) => r.start));
  const allFolded = () => tops().length > 0 && tops().every((st) => s.isFolded(f.file, st));
  const comment = commentPrefix(f.file);
  // Placed flags by new-file line, for the line tint and number pill.
  const flagAt = new Map(f.flags.filter((fl) => fl.placed).map((fl) => [fl.line!, fl]));
  // Line-number column wide enough for this file's longest number, plus the flag pill's icon and padding.
  const maxNo = f.lines.reduce((m, l) => Math.max(m, l.newNo ?? 0, l.oldNo ?? 0), 0);
  // Plus room on the left for the fold arrow when the file has blocks to fold.
  const gutter = () => Math.max(48, String(maxNo).length * 8 + (f.flags.some((fl) => fl.placed) ? 30 : 12)) + (regions().length ? 14 : 0);
  // A guess at the rendered height, used while the file is off screen (see .file-section).
  const estimate = () => 90 + f.whys.length * 26 + (open() ? display().length * LINE_H + 24 : 30);

  return (
    <section
      id={`F:${f.file}`}
      data-file={f.file}
      class="file-section border-t border-ln pt-3 pb-2 pl-4 first-of-type:border-t-0 sm:pl-8 [&+&]:mt-[22px]"
      style={{ "--est": `${estimate()}px` }}
    >
      {/* Not sticky: one sticky header per file cost real frames while scrolling. The tool row shows the current file instead. */}
      <div class="flex flex-wrap items-center gap-2.5 py-2.5 pr-5" style={{ "margin-right": "var(--nw)" }}>
        <button
          class="-ml-1 grid size-6 place-items-center rounded-full text-[20px] text-mu hover:bg-hov hover:text-tx"
          title={open() ? "Fold this file (x)" : "Show this file (x)"}
          aria-expanded={open()}
          onClick={() => s.toggleCollapsed(f.file)}
        >
          <Icon name="keyboard_arrow_down" class={`transition-[rotate] ${open() ? "" : "-rotate-90"}`} />
        </button>
        <TierTag tier={f.tier} />
        <span class="min-w-0 font-mono text-[15px] font-semibold break-all">
          <small class="font-normal text-mu">{f.dir}</small>
          {f.name}
        </span>
        <span class="font-mono text-[13px] font-medium">
          <span class="text-addt">+{f.additions}</span> <span class="text-delt">−{f.deletions}</span>
        </span>
        <Show when={f.status !== "modified"}>
          <span class="rounded-full px-2.5 py-0.5 text-xs text-mu shadow-[inset_0_0_0_1px_var(--color-ln)]">{f.status}</span>
        </Show>
        <Show when={f.unclassified}>
          <span class="rounded-full px-2.5 py-0.5 text-xs text-mu shadow-[inset_0_0_0_1px_var(--color-ln)]">{f.unclassified}</span>
        </Show>
        <Show when={f.overridden}>
          <span class="rounded-full px-2.5 py-0.5 text-xs text-mu shadow-[inset_0_0_0_1px_var(--color-ln)]" title="The tier was forced up by a rule">
            rule: {f.overridden}
          </span>
        </Show>
        <For each={f.flags}>{(fl) => <FlagPointer flag={fl} />}</For>
        <Show when={open() && tops().length > 0}>
          <button
            class="grid size-7 place-items-center rounded-full text-[17px] text-mu shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov hover:text-tx"
            classList={{ "text-pkink": allFolded() }}
            title={allFolded() ? "Unfold every block in this file" : "Fold every top-level block (functions, types) in this file"}
            aria-label={allFolded() ? "Unfold all" : "Fold all"}
            onClick={() => s.foldMany(f.file, allFolded() ? regions().map((r) => r.start) : tops(), !allFolded())}
          >
            <Icon name={allFolded() ? "unfold_more" : "unfold_less"} />
          </button>
        </Show>
        <Show when={!open() && (s.draftsByFile().get(f.file)?.length ?? 0) > 0}>
          <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] text-mu shadow-[inset_0_0_0_1px_var(--color-ln)]">
            <Icon name="edit_note" class="text-[16px]" />
            {plural(s.draftsByFile().get(f.file)!.length, "draft")}
          </span>
        </Show>
        <button
          class="ml-auto inline-flex items-center gap-1.5 rounded-full py-1.5 pr-3.5 pl-2 text-[13px] font-semibold"
          classList={{ "bg-pkbg text-pkink": done(), "text-tx shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-pkbg": !done() }}
          title="Mark reviewed (r)"
          aria-pressed={done()}
          onClick={() => s.toggleReviewed(f.file)}
        >
          <Show when={done()} fallback={<Icon name="radio_button_unchecked" class="text-[18px] text-pkink" />}>
            <Icon name="check_circle-fill" class="pop text-[18px] text-pkink" />
          </Show>
          {done() ? "Reviewed" : "Mark reviewed"}
        </button>
      </div>

      <Show when={f.whys.length}>
        <div class="mt-2 mb-3.5 flex flex-col gap-1 pr-5" style={{ "margin-right": "var(--nw)" }}>
          <For each={f.whys}>
            {(w) => (
              <div class="flex items-baseline gap-2 text-mu">
                <Icon name="function" class="relative top-[3px] text-[18px] text-tx" />
                <span>
                  <Show when={w.symbol}>
                    <b class="font-mono text-sm font-medium text-tx">{w.symbol}</b>{" "}
                  </Show>
                  {w.why}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={open()}
        fallback={
          <button class="mt-2 mb-1 ml-1 flex items-center gap-1.5 text-xs text-mu hover:text-tx" onClick={() => s.toggleCollapsed(f.file, false)}>
            <Icon name="unfold_more" class="text-[16px]" />
            {plural(f.additions + f.deletions, "changed line")} folded
          </button>
        }
      >
        <div
          class="fade-in mt-2 grid transition-[grid-template-columns] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]"
          style={{ "grid-template-columns": `minmax(0,1fr) ${s.notesOpen() ? NOTES_W : MARKERS_W}px` }}
        >
          <div class="min-w-0">
            <div class="overflow-x-auto" classList={{ "mr-5": s.notesOpen() }}>
              <div class="w-max min-w-full font-mono text-[13px] leading-6 text-codetx" onMouseLeave={() => s.setHoverLine(null)}>
                {/* One tinted block per run of added or removed lines, not one per line: thousands of
                    separately painted line backgrounds were the biggest scroll cost. */}
                <For each={runs()}>
                  {(run) => (
                    <div class="rounded-lg" classList={{ "bg-add": run.kind === "add", "bg-del": run.kind === "del" }}>
                      <For each={run.rows}>
                        {(r) =>
                          r.kind === "fold" ? (
                            <FoldedRow hidden={r.hidden} gutter={gutter()} onOpen={() => s.toggleFold(f.file, r.region.start, false)} />
                          ) : (
                            <Line
                              file={f}
                              line={r.line}
                              flag={r.line.kind !== "del" && r.line.newNo !== null ? flagAt.get(r.line.newNo) : undefined}
                              comment={comment}
                              gutter={gutter()}
                              fold={starts().has(r.index) ? { folded: s.isFolded(f.file, r.index), toggle: () => s.toggleFold(f.file, r.index) } : undefined}
                            />
                          )
                        }
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <Show when={shownCount() < f.lines.length}>
              <button class="flex items-center gap-1.5 pt-1.5 pl-[66px] text-xs text-mu hover:text-tx" onClick={() => s.uncap(f.file)}>
                <Icon name="unfold_more" class="text-[16px]" />
                {plural(f.lines.length - shownCount(), "more line")}
              </button>
            </Show>
            <Show when={f.lines.length === 0}>
              <p class="m-0 py-1 pl-[66px] text-[13px] text-mu">No text changes (binary file, or a rename only).</p>
            </Show>
          </div>
          <Notes file={f} rows={rows()} shown={display().length} />
        </div>
      </Show>
    </section>
  );
}

/** "deviation, line 14 →" in the file header: jumps to the flagged line. */
function FlagPointer(props: { flag: FlagItem }) {
  const s = useStore();
  const done = () => s.resolved().has(props.flag.id);
  return (
    <button
      class="inline-flex items-center gap-[5px] rounded-full py-1 pr-[11px] pl-2 text-[13px] font-medium"
      classList={{ "bg-hov text-mu": done(), "text-onfl": !done() }}
      style={done() ? undefined : { background: flagColor(props.flag.kind) }}
      title={props.flag.note}
      onClick={() => s.goFlag(props.flag)}
    >
      <Icon name={done() ? "check" : FLAG_ICON[props.flag.kind]} class="text-[16px]" />
      {props.flag.kind}
      {props.flag.placed ? `, line ${props.flag.line}` : ""}
      {done() ? ", resolved" : ""}
      <Show when={props.flag.placed}>
        <Icon name="east" class="text-[16px]" />
      </Show>
    </button>
  );
}

/** Stands in for a folded block: click to unfold. */
function FoldedRow(props: { hidden: number; gutter: number; onOpen: () => void }) {
  return (
    <div class="flex h-6 items-center" style={{ "padding-left": `${props.gutter + 18}px` }}>
      <button
        class="fade-in inline-flex items-center gap-1.5 rounded-full bg-hov px-2.5 text-xs leading-5 text-mu hover:bg-pkbg hover:text-pkink"
        title="Unfold"
        onClick={props.onOpen}
      >
        <Icon name="unfold_more" class="text-[14px]" />⋯ {plural(props.hidden, "line")} folded
      </button>
    </div>
  );
}

function Line(props: {
  file: ReviewFile;
  line: DiffLine;
  flag: FlagItem | undefined;
  comment: string;
  gutter: number;
  /** Set on a line that opens a foldable block. */
  fold?: { folded: boolean; toggle: () => void };
}) {
  const s = useStore();
  const l = props.line;
  if (l.kind === "hunk") {
    return (
      <div class="flex h-6 items-center gap-1.5 pl-1 text-mu">
        <Icon name="unfold_more" class="text-[16px]" />
        <span class="truncate rounded-full bg-hov px-3 text-xs leading-5">{l.text}</span>
      </div>
    );
  }
  const a = anchorOf(l)!;
  const key = s.litKey(props.file.file, a.side, a.line);
  const flag = props.flag;
  const resolved = () => !!flag && s.resolved().has(flag.id);
  const color = () => (!flag ? undefined : resolved() ? "var(--color-mu)" : flagColor(flag.kind));
  return (
    <div
      id={`L:${props.file.file}:${a.side}:${a.line}`}
      class="relative flex h-6"
      classList={{ "rounded-lg": !!flag || s.isLit(key) }}
      onMouseEnter={() => s.setHoverLine(key)}
      style={{
        background: flag ? `color-mix(in srgb, ${color()} ${resolved() ? 8 : 13}%, var(--color-code))` : undefined,
        "box-shadow": s.isLit(key) ? `inset 0 0 0 1.5px ${color() ?? "var(--color-tx)"}` : undefined,
      }}
    >
      {/* Faded with a text color, never opacity: opacity on thousands of elements makes each one its own blend. */}
      <span class="relative shrink-0 pr-2 text-right whitespace-nowrap select-none" style={{ width: `${props.gutter}px` }} classList={{ "text-mu/50": l.kind === "del", "text-mu/80": l.kind !== "del" }} title={l.kind === "del" ? "old line" : "line"}>
        {/* Fold arrow: on hover for a line that opens a block, always while it's folded. */}
        <Show when={props.fold && (props.fold.folded || s.isHoverLine(key))}>
          <button
            class="absolute top-0.5 left-0 grid size-5 place-items-center rounded-full text-[16px] text-mu hover:bg-hov hover:text-tx"
            classList={{ "text-pkink": props.fold!.folded }}
            title={props.fold!.folded ? "Unfold this block" : "Fold this block"}
            aria-label={props.fold!.folded ? "Unfold this block" : "Fold this block"}
            aria-expanded={!props.fold!.folded}
            onClick={() => props.fold!.toggle()}
          >
            <Icon name="keyboard_arrow_down" class={`transition-[rotate] ${props.fold!.folded ? "-rotate-90" : ""}`} />
          </button>
        </Show>
        <Show when={flag} fallback={a.line}>
          <b class="inline-flex items-center gap-0.5 rounded-full pr-1.5 pl-1 leading-[18px] font-semibold" style={{ background: color(), color: resolved() ? "var(--color-code)" : "var(--color-onfl)" }}>
            <Icon name={resolved() ? "check" : FLAG_ICON[flag!.kind]} class="text-[12px]" />
            {a.line}
          </b>
        </Show>
      </span>
      <span class="w-[18px] shrink-0 text-center select-none" classList={{ "text-addt": l.kind === "add", "text-delt": l.kind === "del" }}>
        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
      </span>
      <code class="selectable pr-10 whitespace-pre" innerHTML={highlight(l.text, props.comment)} />
      {/* Only the hovered line gets a button: thousands of sticky buttons made scrolling stutter. */}
      <Show when={s.isHoverLine(key)}>
        <button
          class="pop sticky right-2 my-0.5 ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-pk text-[15px] text-ink shadow-[0_1px_3px_rgb(0_0_0/.18)]"
          title="Comment on this line"
          aria-label={`Comment on line ${a.line}`}
          onClick={() => s.openComposer({ file: props.file.file, side: a.side, line: a.line, lineText: l.text, editingId: null, replyTo: null })}
        >
          <Icon name="add" />
        </button>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------- notes margin

type NoteItem =
  | { id: string; row: number; side: "old" | "new"; line: number | null; kind: "flag"; flag: FlagItem }
  | { id: string; row: number; side: "old" | "new"; line: number | null; kind: "draft"; draft: Draft }
  | { id: string; row: number; side: "old" | "new"; line: number; kind: "composer" };

const KIND_ORDER = { flag: 0, draft: 1, composer: 2 } as const;

/**
 * The margin beside one file's diff. Each note starts level with its line and pushes
 * later notes down when they'd overlap; whole-file notes sit at the top. Folded, each
 * note is a small marker at its line.
 */
function Notes(props: { file: ReviewFile; rows: Map<string, number>; shown: number }) {
  const s = useStore();
  const f = props.file;
  let col!: HTMLDivElement;
  let prevItems = new Map<string, NoteItem>();
  const signature = (it: NoteItem) =>
    `${it.row}:${it.side}:${it.line}:${it.kind === "draft" ? `${it.draft.updatedAt}:${it.draft.status}:${it.draft.line}` : ""}`;

  const items = createMemo<NoteItem[]>(() => {
    const out: NoteItem[] = [];
    const at = (side: "old" | "new", line: number | null) => {
      if (line === null) return -1;
      const r = props.rows.get(`${side}:${line}`);
      return r === undefined ? -1 : Math.min(r, props.shown);
    };
    for (const fl of f.flags) {
      out.push({ id: `f${fl.id}`, row: fl.placed ? at("new", fl.line) : -1, side: "new", line: fl.placed ? fl.line : null, kind: "flag", flag: fl });
    }
    const c = s.composer();
    for (const d of s.draftsByFile().get(f.file) ?? []) {
      if (c?.editingId === d.id) continue;
      const active = d.status === "active";
      out.push({ id: `d${d.id}`, row: active ? at(d.side, d.line) : -1, side: d.side, line: active ? d.line : null, kind: "draft", draft: d });
    }
    if (c && c.file === f.file) out.push({ id: "composer", row: at(c.side, c.line), side: c.side, line: c.line, kind: "composer" });
    out.sort((a, b) => a.row - b.row || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    // Reuse unchanged items so <For> keeps their elements (and doesn't replay their entrance).
    const next = new Map<string, NoteItem>();
    const stable = out.map((it) => {
      const old = prevItems.get(it.id);
      const keep = old && signature(old) === signature(it) ? old : it;
      next.set(it.id, keep);
      return keep;
    });
    prevItems = next;
    return stable;
  });

  const layout = () => {
    if (!col) return;
    const openNotes = s.notesOpen();
    let y = 0;
    for (const el of Array.from(col.children) as HTMLElement[]) {
      const row = Number(el.dataset.row);
      const want = row < 0 ? 0 : row * LINE_H - (openNotes ? 0 : 1);
      const top = Math.max(want, y);
      el.style.top = `${top}px`;
      y = top + el.offsetHeight + (openNotes ? 12 : 4);
      // Place first without motion; after that, moves glide.
      if (!el.classList.contains("note-placed")) requestAnimationFrame(() => el.classList.add("note-placed"));
    }
    col.style.minHeight = `${y}px`;
  };
  const ro = new ResizeObserver(() => layout());
  onCleanup(() => ro.disconnect());
  createEffect(() => {
    items();
    s.notesOpen();
    queueMicrotask(layout);
  });
  const watch = (el: HTMLElement) => {
    ro.observe(el);
    onCleanup(() => ro.unobserve(el));
  };

  const hover = (it: NoteItem, on: boolean) => {
    if (it.line === null) return;
    const key = s.litKey(f.file, it.side, it.line);
    if (on) s.setLit(key);
    else if (s.lit() === key) s.setLit(null);
  };

  return (
    <div ref={col} class="relative overflow-x-clip">
      <For each={items()}>
        {(it) => (
          <div
            ref={watch}
            data-row={it.row}
            class="slide-in absolute"
            // Full width from the start: the opening margin reveals the note instead of squeezing it.
            style={s.notesOpen() ? { width: `${NOTES_W - 24}px` } : undefined}
            classList={{ "left-0 pl-[18px]": s.notesOpen(), "left-3.5": !s.notesOpen() }}
            onMouseEnter={() => hover(it, true)}
            onMouseLeave={() => hover(it, false)}
          >
            <Show when={s.notesOpen()} fallback={<Marker item={it} />}>
              {it.kind === "flag" ? <FlagNote flag={it.flag} /> : it.kind === "draft" ? <DraftNote draft={it.draft} /> : <ComposerNote />}
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** Note header: round icon with a tick out to the separator, title, and where it points. */
function NoteHead(props: { color: string; on: string; icon: JSX.Element; title: JSX.Element; where: string; extra?: JSX.Element }) {
  return (
    <div class="relative flex h-6 items-center gap-2">
      <span class="absolute top-[11px] -left-[18px] h-0.5 w-3 rounded-sm" style={{ background: props.color }} />
      <span class="grid size-6 shrink-0 place-items-center rounded-full text-[15px]" style={{ background: props.color, color: props.on }}>
        {props.icon}
      </span>
      <b class="min-w-0 truncate font-semibold">{props.title}</b>
      <span class="ml-auto shrink-0 font-mono text-xs text-mu">{props.where}</span>
      {props.extra}
    </div>
  );
}

const noteBtn = "inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-xs text-mu hover:bg-hov hover:text-tx";

function FlagNote(props: { flag: FlagItem }) {
  const s = useStore();
  const fl = props.flag;
  const done = () => s.resolved().has(fl.id);
  const where = fl.placed ? `line ${fl.line}` : "whole file";
  return (
    <Show
      when={!done()}
      fallback={
        <NoteHead
          color="var(--color-mu)"
          on="var(--color-code)"
          icon={<Icon name="check" />}
          title={<span class="text-mu capitalize line-through decoration-1">{fl.kind}</span>}
          where="resolved"
          extra={
            <button class="rounded-full px-[9px] py-px text-xs text-tx shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov" onClick={() => s.setFlagResolved(fl.id, false)}>
              Undo
            </button>
          }
        />
      }
    >
      <div class="text-sm">
        <NoteHead color={flagColor(fl.kind)} on="var(--color-onfl)" icon={<Icon name={FLAG_ICON[fl.kind]} />} title={<span class="capitalize">{fl.kind}</span>} where={where} />
        <p class="selectable mt-1 mb-0 ml-8">{fl.note}</p>
        <div class="mt-1.5 ml-8 flex flex-wrap gap-1">
          <button class={`${noteBtn} text-tx shadow-[inset_0_0_0_1px_var(--color-ln)]`} onClick={() => s.setFlagResolved(fl.id, true)}>
            <Icon name="check_circle" class="text-[14px] text-addt" />
            Resolve
          </button>
          <button class={noteBtn} title="Write a review comment from this flag; saving it resolves the flag" onClick={() => s.replyToFlag(fl)}>
            <Icon name="add_comment" class="text-[14px]" />
            Reply as draft
          </button>
        </div>
      </div>
    </Show>
  );
}

function DraftNote(props: { draft: Draft }) {
  const s = useStore();
  const d = props.draft;
  const outdated = d.status === "outdated";
  return (
    <div class="text-sm">
      <NoteHead
        color="var(--color-tx)"
        on="var(--color-bg)"
        icon={<Icon name="edit_note" class="text-[17px]" />}
        title="Your draft"
        where={outdated ? `outdated, was line ${d.line}` : `line ${d.line}`}
      />
      <Show when={outdated}>
        <code class="mt-1 ml-8 block truncate rounded-md bg-hov px-2 font-mono text-xs leading-5 text-mu" title="The line this was written on; it's no longer in the diff">
          {d.lineText.trim() || "(blank line)"}
        </code>
      </Show>
      <p class="selectable mt-1 mb-0 ml-8 whitespace-pre-wrap text-mu">{d.body}</p>
      <div class="mt-1.5 ml-8 flex gap-1">
        <button class={noteBtn} onClick={() => s.editDraft(d)}>
          <Icon name="edit" class="text-[14px]" />
          Edit
        </button>
        <button class={noteBtn} onClick={() => s.deleteDraft(d)}>
          <Icon name="delete" class="text-[14px]" />
          Delete
        </button>
      </div>
    </div>
  );
}

function ComposerNote() {
  const s = useStore();
  const c = () => s.composer()!;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void s.saveComposer();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      s.setComposer(null);
    }
  };
  return (
    <div class="text-sm">
      <NoteHead
        color="var(--color-pk)"
        on="var(--color-ink)"
        icon={<Icon name={c().editingId ? "edit" : "add_comment"} class="text-[15px]" />}
        title={c().editingId ? "Edit draft" : c().replyTo ? "Reply as draft" : "New comment"}
        where={`line ${c().line}`}
      />
      <div class="mt-1.5 ml-8">
        <textarea
          // Don't let focus scroll: the note is placed beside its line a moment later.
          ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
          rows={4}
          class="block w-full resize-y rounded-xl border border-ln bg-code px-3 py-2 text-sm text-tx outline-none placeholder:text-mu focus:border-pk"
          placeholder="What should change here?"
          value={s.composerText()}
          onInput={(e) => s.setComposerText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div class="mt-1.5 flex items-center gap-1.5">
          <span class="mr-auto text-[11px] text-mu">Ctrl+Enter saves</span>
          <button class={noteBtn} onClick={() => s.setComposer(null)}>
            Cancel
          </button>
          <button
            class="rounded-full bg-pk px-3 py-1 text-xs font-semibold text-ink disabled:opacity-50"
            disabled={!s.composerText().trim()}
            onClick={() => void s.saveComposer()}
          >
            {c().editingId ? "Update draft" : "Save draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Marker(props: { item: NoteItem }) {
  const s = useStore();
  const it = props.item;
  const resolved = () => it.kind === "flag" && s.resolved().has(it.flag.id);
  const color = () => (it.kind === "flag" ? (resolved() ? "var(--color-mu)" : flagColor(it.flag.kind)) : it.kind === "composer" ? "var(--color-pk)" : "var(--color-tx)");
  const on = () => (it.kind === "flag" ? (resolved() ? "var(--color-code)" : "var(--color-onfl)") : it.kind === "composer" ? "var(--color-ink)" : "var(--color-bg)");
  const label = () => {
    const where = it.line === null ? "whole file" : `line ${it.line}`;
    return it.kind === "flag" ? `${it.flag.kind}, ${where}` : it.kind === "draft" ? `Your draft, ${where}` : `New comment, ${where}`;
  };
  return (
    <button
      class="relative grid size-[26px] place-items-center rounded-full text-[15px]"
      style={{ background: color(), color: on() }}
      title={label()}
      aria-label={`${label()}. Show notes.`}
      onClick={() => s.setNotesOpen(true)}
    >
      <span class="absolute top-3 -left-3.5 h-0.5 w-2.5 rounded-sm" style={{ background: color() }} />
      <Icon name={it.kind === "flag" ? (resolved() ? "check" : FLAG_ICON[it.flag.kind]) : it.kind === "draft" ? "edit_note" : "add_comment"} />
    </button>
  );
}

function EmptyDiff() {
  const s = useStore();
  return (
    <div class="grid place-items-center px-8 py-24 text-center text-mu">
      <Show when={s.review()} fallback={<p>Loading the diff…</p>}>
        <p class="m-0 text-lg font-semibold text-tx">Nothing to review</p>
        <p class="m-0">This PR has no file changes.</p>
      </Show>
    </div>
  );
}

function EndOfDiff() {
  const s = useStore();
  const left = () => s.files().filter((f) => !s.reviewed().has(f.file)).length;
  return (
    <div class="flex flex-col items-center gap-3 border-t border-ln px-8 pt-10 pb-24 text-center text-sm text-mu">
      <span>End of the diff. {left() ? `${plural(left(), "file")} not marked reviewed yet.` : "Every file is marked reviewed."}</span>
      <span class="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs">
        <span><Kbd>j</Kbd> <Kbd>k</Kbd> file</span>
        <span><Kbd>n</Kbd> next flag</span>
        <span><Kbd>r</Kbd> reviewed</span>
        <span><Kbd>x</Kbd> fold file</span>
      </span>
    </div>
  );
}

function Kbd(props: { children: string }) {
  return <kbd class="rounded-md bg-hov px-1.5 py-px font-mono text-[11px] font-medium text-tx">{props.children}</kbd>;
}
