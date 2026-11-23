import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Def, referencesOf, resolve, wordAt } from "./definitions";
import type { DiffLine } from "./diff";
import { anchorOf } from "./drafts";
import { commentPrefix, highlight } from "./highlight";
import type { ReviewFile } from "./model";
import type { Jump, Store } from "./store";

/**
 * Go to definition in the Review diff. Cmd- or Ctrl-click a name: one definition in the PR jumps
 * there; several open a peek to pick from; on a definition itself, the peek lists where the
 * name is used in the PR. Holding the key underlines names that lead somewhere. Each jump is a
 * history entry, so Back (or the mouse's back button) returns to where it started.
 */

interface PeekItem {
  file: string;
  index: number;
  /** "def" marks a definition among references; otherwise the definition's kind. */
  tag?: string;
}
interface Peek {
  x: number;
  y: number;
  name: string;
  title: string;
  note?: string;
  items: PeekItem[];
  from: Jump;
}

const [peek, setPeek] = createSignal<Peek | null>(null);

/** Line index by `side:line`, per file's lines. */
const indexCache = new WeakMap<DiffLine[], Map<string, number>>();
function indexOfLine(f: ReviewFile, side: string, line: string): number | undefined {
  let m = indexCache.get(f.lines);
  if (!m) {
    m = new Map();
    f.lines.forEach((l, i) => {
      const a = anchorOf(l);
      if (a) m!.set(`${a.side}:${a.line}`, i);
    });
    indexCache.set(f.lines, m);
  }
  return m.get(`${side}:${line}`);
}

type Caret = { node: Node; offset: number };
function caretAt(x: number, y: number): Caret | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** A Range over characters [from, to) of an element's text. */
function rangeIn(el: Element, from: number, to: number): Range | null {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let at = 0;
  let started = false;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const len = n.textContent!.length;
    if (!started && from <= at + len) {
      range.setStart(n, from - at);
      started = true;
    }
    if (started && to <= at + len) {
      range.setEnd(n, to - at);
      return range;
    }
    at += len;
  }
  return null;
}

/** The name under the pointer in a diff line: which line, and the word and its range. */
interface Hit {
  index: number;
  line: DiffLine;
  name: string;
  col: number;
  range: Range;
}
function hitAt(f: ReviewFile, e: Pick<MouseEvent, "clientX" | "clientY">): Hit | null {
  const caret = caretAt(e.clientX, e.clientY);
  const code = caret && (caret.node.nodeType === Node.TEXT_NODE ? caret.node.parentElement : (caret.node as Element))?.closest("code");
  const row = code?.parentElement;
  const prefix = `L:${f.file}:`;
  if (!code || !row?.id.startsWith(prefix)) return null;
  const [side, num] = row.id.slice(prefix.length).split(":");
  const index = indexOfLine(f, side!, num!);
  if (index === undefined) return null;
  // The caret's column in the line's text.
  const before = document.createRange();
  before.setStart(code, 0);
  before.setEnd(caret.node, caret.offset);
  const col = before.toString().length;
  const line = f.lines[index]!;
  const w = wordAt(line.text, col);
  if (!w) return null;
  const range = rangeIn(code, w.col, w.col + w.name.length);
  if (!range) return null;
  // The caret snaps to the nearest letter; only count it when the pointer is on the word.
  const box = range.getBoundingClientRect();
  if (e.clientX < box.left - 1 || e.clientX > box.right + 1 || e.clientY < box.top - 2 || e.clientY > box.bottom + 2) return null;
  return { index, line, ...w, range };
}

const sideOf = (l: DiffLine) => (l.kind === "del" ? "old" : "new");
const modifier = (e: Pick<MouseEvent, "metaKey" | "ctrlKey">) => e.metaKey || e.ctrlKey;

function where(s: Store, f: ReviewFile, hit: Hit) {
  return resolve(s.defIndex(), hit.name, f.file, hit.index, hit.col, sideOf(hit.line), s.order().map((x) => x.file));
}

function jumpOf(s: Store, file: string, index: number): Jump | null {
  const l = s.files().find((f) => f.file === file)?.lines[index];
  const a = l && anchorOf(l);
  return a ? { file, side: a.side, line: a.line } : null;
}

/**
 * Jump as a history step: the entry being left remembers where it was, the new one where it
 * went, so Back and Forward replay definition jumps.
 */
function jumpTo(s: Store, from: Jump, to: Jump) {
  history.replaceState({ ...(history.state ?? {}), defAt: from }, "");
  s.go("review", to);
  history.pushState({ defAt: to }, "", "#review");
}

// ---------- hover underline (CSS Custom Highlight, so no markup changes per line) ----------

const HL = "cs-def";
let lastMove: { f: ReviewFile; e: MouseEvent; s: Store } | null = null;
let hoverCode: HTMLElement | null = null;
function clearHover() {
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(HL);
  hoverCode?.classList.remove("cs-def-hover");
  hoverCode = null;
}
type Pointer = Pick<MouseEvent, "clientX" | "clientY" | "metaKey" | "ctrlKey" | "target">;
function showHover(s: Store, f: ReviewFile, e: Pointer) {
  clearHover();
  if (!modifier(e) || !(typeof CSS !== "undefined" && "highlights" in CSS)) return;
  const hit = hitAt(f, e);
  if (!hit) return;
  const r = where(s, f, hit);
  if (r.kind === "none") return;
  CSS.highlights.set(HL, new Highlight(hit.range));
  hoverCode = (e.target as Element).closest("code");
  hoverCode?.classList.add("cs-def-hover");
}

/** Pointer moves over a file's diff: underline the name under it while the key is held. */
export function defHover(s: Store, f: ReviewFile, e: MouseEvent) {
  lastMove = { f, e, s };
  if (modifier(e) || hoverCode) showHover(s, f, e);
}
export function defLeave() {
  lastMove = null;
  clearHover();
}

/** Cmd/Ctrl-click in a file's diff. */
export function defClick(s: Store, f: ReviewFile, e: MouseEvent) {
  if (!modifier(e) || e.button !== 0) return;
  const hit = hitAt(f, e);
  if (!hit) return;
  e.preventDefault();
  clearHover();
  const from: Jump = { file: f.file, ...anchorOf(hit.line)! };
  const r = where(s, f, hit);
  const at = { x: e.clientX, y: e.clientY, name: hit.name, from };
  const refs = () =>
    referencesOf(
      s.order().map((x) => ({ file: x.file, lines: x.lines, comment: commentPrefix(x.file) })),
      hit.name,
    );
  if (r.kind === "defs" && r.defs.length === 1) {
    const to = jumpOf(s, r.defs[0]!.file, r.defs[0]!.index);
    if (to) jumpTo(s, from, to);
    return;
  }
  if (r.kind === "defs") {
    setPeek({ ...at, title: `${r.defs.length} definitions of ${hit.name}`, items: r.defs.map((d) => ({ file: d.file, index: d.index, tag: d.kind })) });
    return;
  }
  const defs = s.defIndex().get(hit.name) ?? [];
  const isDef = (x: { file: string; index: number }) => defs.some((d: Def) => d.file === x.file && d.index === x.index);
  // On a definition: where it's used. Locals only count inside their own function.
  const self = r.kind === "self" ? r.def : null;
  const list = refs().filter((x) => !self?.scope || (x.file === self.file && self.scope[0] <= x.index && x.index <= self.scope[1]));
  const items = list.map((x) => ({ file: x.file, index: x.index, tag: isDef(x) ? "def" : undefined }));
  const uses = items.filter((x) => !x.tag).length;
  if (self) {
    setPeek({ ...at, title: uses ? `${uses} use${uses === 1 ? "" : "s"} of ${hit.name} in this PR` : `${hit.name} isn't used elsewhere in this PR`, items: uses ? items : [] });
  } else {
    setPeek({ ...at, title: `${hit.name} isn't defined in this PR`, note: items.length ? `Where it appears in the diff:` : "It doesn't appear anywhere else in the diff either.", items });
  }
}

/** The peek popover and the Back/Forward handling; render once inside Review. */
export function DefPeek(props: { store: Store }) {
  const s = props.store;
  let card: HTMLDivElement | undefined;
  const close = () => setPeek(null);
  onMount(() => {
    const onPop = (e: PopStateEvent) => {
      const at = (e.state as { defAt?: Jump } | null)?.defAt;
      if (at) s.go("review", at);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && peek()) {
        e.stopImmediatePropagation();
        close();
      }
      if (e.key === "Meta" || e.key === "Control") {
        const m = lastMove;
        if (m) showHover(m.s, m.f, { clientX: m.e.clientX, clientY: m.e.clientY, target: m.e.target, ctrlKey: true, metaKey: false });
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") clearHover();
    };
    const outside = (e: Event) => {
      if (peek() && card && !card.contains(e.target as Node)) close();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clearHover);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, { capture: true, passive: true });
    onCleanup(() => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clearHover);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, { capture: true });
      clearHover();
      close();
    });
  });

  const W = 440;
  const place = (p: Peek) => {
    const left = Math.max(8, Math.min(p.x - 24, innerWidth - W - 8));
    const below = p.y + 18;
    return innerHeight - below < 220 ? { left: `${left}px`, bottom: `${innerHeight - p.y + 10}px` } : { left: `${left}px`, top: `${below}px` };
  };
  const pick = (p: Peek, it: PeekItem) => {
    close();
    const to = jumpOf(s, it.file, it.index);
    if (to) jumpTo(s, p.from, to);
  };

  return (
    <Show when={peek()}>
      {(p) => (
        <div
          ref={(el) => {
            card = el;
            // Focus the first choice so arrows/Enter work straight away.
            queueMicrotask(() => el.querySelector("button")?.focus());
          }}
          role="dialog"
          aria-label={p().title}
          class="appear fixed z-50 flex max-h-[340px] flex-col overflow-hidden rounded-xl bg-sf text-[13px] shadow-[0_8px_30px_rgb(0_0_0/.18),inset_0_0_0_1px_var(--color-ln)]"
          style={{ width: `${W}px`, "max-width": "calc(100vw - 16px)", ...place(p()) }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            const all = [...e.currentTarget.querySelectorAll("button")];
            const i = all.indexOf(document.activeElement as HTMLButtonElement);
            all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
            e.preventDefault();
          }}
        >
          <div class="border-b border-ln px-3 py-2">
            <div class="font-medium text-tx">{p().title}</div>
            <Show when={p().note}>
              <div class="text-xs text-mu">{p().note}</div>
            </Show>
          </div>
          <div class="overflow-y-auto py-1">
            <For each={p().items}>
              {(it) => {
                const f = s.files().find((x) => x.file === it.file);
                const l = f?.lines[it.index];
                const a = l && anchorOf(l);
                const slash = it.file.lastIndexOf("/");
                return (
                  <button class="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left outline-none hover:bg-hov focus-visible:bg-hov" onClick={() => pick(p(), it)}>
                    <span class="flex min-w-0 items-center gap-1.5 text-xs">
                      <span class="truncate text-mu">{slash > 0 ? it.file.slice(0, slash + 1) : ""}</span>
                      <span class="shrink-0 font-medium text-tx">{it.file.slice(slash + 1)}</span>
                      <span class="shrink-0 text-mu">
                        {a?.side === "old" ? "old " : ""}
                        {a?.line}
                      </span>
                      <Show when={it.tag}>
                        <span class="ml-auto shrink-0 rounded-full bg-hov px-1.5 text-[11px] leading-4 text-mu">{it.tag === "def" ? "definition" : it.tag}</span>
                      </Show>
                    </span>
                    <code class="truncate font-mono text-[12px] text-codetx" classList={{ "text-mu": l?.kind === "del" }} innerHTML={highlight((l?.text ?? "").trim(), commentPrefix(it.file))} />
                  </button>
                );
              }}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}
