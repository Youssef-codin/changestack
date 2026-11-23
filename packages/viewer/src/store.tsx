import type { Draft, ReviewPayload, SubmitResult } from "@changestack/schema";
import { batch, createContext, createEffect, createMemo, createResource, createSelector, createSignal, onCleanup, useContext } from "solid-js";
import type { Region } from "./folds";
import { syntaxFor } from "./syntaxFolds";
import { type Def, indexDefs } from "./definitions";
import { anchorKey, copyText, draftsPrompt, fetchDrafts, newId, putDrafts, reanchor, removeDraft, type Side, submitReview } from "./drafts";
import {
  buildModel,
  COLLAPSED_BY_DEFAULT,
  type FlagItem,
  loadJson,
  type Model,
  readingOrder,
  type ReviewFile,
  resumeTarget,
  rowIndex,
  saveJson,
} from "./model";

/** The open comment box: a new draft on a line, or an existing draft being edited. */
export interface Composer {
  file: string;
  side: Side;
  line: number;
  lineText: string;
  editingId: string | null;
  /** Flag this comment replies to; saving resolves it. */
  replyTo: string | null;
}

export type Screen = "briefing" | "review";
export type GroupBy = "tier" | "feature";

/** Where to scroll once the Review screen is showing. */
export type Jump = { file: string; side?: Side; line?: number | null };

/** How many lines of a file render before "Show more". */
export const LINE_CAP = 400;
const POLL_MS = 1000;

async function fetchReview(): Promise<ReviewPayload> {
  const res = await fetch("/api/review");
  if (!res.ok) throw new Error(`GET /api/review → ${res.status}`);
  return res.json();
}

const screenFromHash = (): Screen => (location.hash === "#review" ? "review" : "briefing");

export function createStore() {
  // ---------- review payload, polled while the model runs ----------
  const [payload, { refetch }] = createResource(fetchReview);
  const status = () => payload.latest?.status;
  createEffect(() => {
    if (status()?.state !== "classifying") return;
    const timer = setTimeout(() => void refetch(), POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  // Each poll returns a new object; rebuild only when the diff or annotation changes.
  const review = createMemo(() => payload.latest, undefined, {
    equals: (a, b) => !!a && !!b && a.pr.headRefOid === b.pr.headRefOid && a.annotation?.createdAt === b.annotation?.createdAt,
  });
  const empty: Model = { files: [], flags: [], features: [] };
  const model = createMemo(() => (review() ? buildModel(review()!) : empty));
  const pr = () => review()?.pr;
  const keyBase = () => `changestack:pr-${pr()?.number ?? 0}:${pr()?.headRefOid ?? "none"}`;
  // The pre-redesign key, so reviewed marks already made survive.
  const reviewedKey = () => `changestack:reviewed:pr-${pr()?.number ?? 0}:${pr()?.headRefOid ?? "none"}`;

  // ---------- per-viewer state ----------
  const [groupBy, setGroupByRaw] = createSignal<GroupBy>(loadJson("changestack:groupBy", "tier"));
  const setGroupBy = (g: GroupBy) => {
    setGroupByRaw(g);
    saveJson("changestack:groupBy", g);
  };
  const [railOpen, setRailOpenRaw] = createSignal<boolean>(loadJson("changestack:railOpen", true));
  const setRailOpen = (v: boolean) => {
    setRailOpenRaw(v);
    saveJson("changestack:railOpen", v);
  };
  const [notesOpen, setNotesOpenRaw] = createSignal<boolean>(loadJson("changestack:notesOpen", true));
  const setNotesOpen = (v: boolean) => {
    setNotesOpenRaw(v);
    saveJson("changestack:notesOpen", v);
  };

  const [reviewed, setReviewed] = createSignal(new Set<string>());
  const [resolved, setResolved] = createSignal(new Set<string>());
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const [uncapped, setUncapped] = createSignal(new Set<string>());
  createEffect(() => {
    const files = model().files;
    const rev = new Set(loadJson<string[]>(reviewedKey(), []));
    setReviewed(rev);
    setResolved(new Set(loadJson<string[]>(`${keyBase()}:resolved`, [])));
    setCollapsed(new Set(files.filter((f) => COLLAPSED_BY_DEFAULT.includes(f.tier) || rev.has(f.file)).map((f) => f.file)));
  });

  // The same set back when nothing changes, so a no-op (every jump unfolds its target) doesn't
  // notify every file that reads the set.
  const toggled = (s: Set<string>, k: string, on?: boolean) => {
    const want = on ?? !s.has(k);
    if (want === s.has(k)) return s;
    const next = new Set(s);
    want ? next.add(k) : next.delete(k);
    return next;
  };
  const toggleReviewed = (file: string) => {
    const next = toggled(reviewed(), file);
    setReviewed(next);
    saveJson(reviewedKey(), [...next]);
    // Reviewing a file folds it, so the next one moves up.
    if (next.has(file)) setCollapsed(toggled(collapsed(), file, true));
  };
  const setFlagResolved = (id: string, on?: boolean) => {
    const next = toggled(resolved(), id, on);
    setResolved(next);
    saveJson(`${keyBase()}:resolved`, [...next]);
  };
  const toggleCollapsed = (file: string, on?: boolean) => setCollapsed(toggled(collapsed(), file, on));

  // Foldable blocks per file, from a real parse (syntaxFolds.ts). Grammars load on demand,
  // so this fills in a moment after the diff shows; until then files have no fold arrows.
  // The same parse finds each file's definitions, for go to definition (definitions.ts).
  const [regions, setRegions] = createSignal(new Map<string, Region[]>());
  const regionsOf = (file: string) => regions().get(file) ?? [];
  const [defs, setDefs] = createSignal(new Map<string, Def[]>());
  createEffect(() => {
    const files = model().files;
    let stale = false;
    onCleanup(() => (stale = true));
    void Promise.all(files.map(async (f) => [f.file, await syntaxFor(f.file, f.lines)] as const)).then((list) => {
      if (stale) return;
      batch(() => {
        setRegions(new Map(list.map(([file, x]) => [file, x.regions])));
        setDefs(new Map(list.map(([file, x]) => [file, x.defs])));
      });
    });
  });
  /** Every definition in the PR's diff, by name. */
  const defIndex = createMemo(() => indexDefs(defs()));

  // Folded blocks inside files, keyed `file\0startIndex`. Not saved: a fold is a moment's tidying.
  const [folds, setFolds] = createSignal(new Set<string>());
  const foldKey = (file: string, start: number) => `${file}\0${start}`;
  const isFolded = (file: string, start: number) => folds().has(foldKey(file, start));
  const toggleFold = (file: string, start: number, on?: boolean) => setFolds(toggled(folds(), foldKey(file, start), on));
  const foldMany = (file: string, starts: number[], on: boolean) => {
    const next = new Set(folds());
    for (const st of starts) on ? next.add(foldKey(file, st)) : next.delete(foldKey(file, st));
    setFolds(next);
  };
  /** Unfold every block hiding line `index` of `file`, so a jump can land on it. */
  const reveal = (file: ReviewFile, index: number) => {
    const hiding = regionsOf(file.file).filter((r) => r.start < index && index < r.end && isFolded(file.file, r.start));
    if (hiding.length) foldMany(file.file, hiding.map((r) => r.start), false);
  };
  const uncap = (file: string) => setUncapped(toggled(uncapped(), file, true));

  const order = createMemo(() => readingOrder(model(), groupBy()));
  const openFlags = () => model().flags.filter((f) => !resolved().has(f.id));

  // ---------- drafts, saved on the server under .git/changestack/drafts/ ----------
  const [draftSet, { mutate: setDraftSet }] = createResource(fetchDrafts);
  const drafts = () => draftSet()?.drafts ?? [];
  const [error, setError] = createSignal<string | null>(null);
  const [composer, setComposer] = createSignal<Composer | null>(null);
  const [composerText, setComposerText] = createSignal("");

  const saveDrafts = async (op: () => ReturnType<typeof fetchDrafts>) => {
    try {
      setDraftSet(await op());
      setError(null);
      return true;
    } catch (e) {
      setError(`Couldn't save drafts: ${e instanceof Error ? e.message : String(e)}. Is changestack still running?`);
      return false;
    }
  };

  // The diff may have moved on since a draft was written: find its line again, or mark it outdated.
  createEffect(() => {
    if (!review() || draftSet.state !== "ready") return;
    const changed = reanchor(drafts(), model().files);
    if (changed.length) void saveDrafts(() => putDrafts(changed));
  });

  const draftsByFile = createMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of drafts()) m.set(d.file, [...(m.get(d.file) ?? []), d]);
    for (const list of m.values()) list.sort((a, b) => a.line - b.line);
    return m;
  });
  const sortedDrafts = createMemo(() => {
    const files = order().map((f) => f.file);
    return [...drafts()].sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file) || a.line - b.line);
  });

  const openComposer = (c: Composer, text = "") => {
    batch(() => {
      setComposerText(text);
      setComposer(c);
      if (!notesOpen()) setNotesOpen(true);
      toggleCollapsed(c.file, false);
    });
  };
  const replyToFlag = (flag: FlagItem) => {
    const file = model().files.find((f) => f.file === flag.file);
    if (!file) return;
    // A whole-file flag replies on the file's first line that can take a comment.
    const line =
      (flag.placed && file.lines.find((l) => l.newNo === flag.line && l.kind !== "del")) ||
      file.lines.find((l) => l.kind === "add" || l.kind === "ctx") ||
      file.lines.find((l) => l.kind === "del");
    if (!line) return;
    const side: Side = line.kind === "del" ? "old" : "new";
    openComposer({ file: file.file, side, line: (side === "old" ? line.oldNo : line.newNo)!, lineText: line.text, editingId: null, replyTo: flag.id }, `${flag.note} `);
  };
  const editDraft = (d: Draft) =>
    openComposer({ file: d.file, side: d.side, line: d.line, lineText: d.lineText, editingId: d.id, replyTo: null }, d.body);
  const saveComposer = async () => {
    const c = composer();
    const body = composerText().trim();
    if (!c || !body) return;
    const at = new Date().toISOString();
    const existing = c.editingId ? drafts().find((d) => d.id === c.editingId) : undefined;
    const draft: Draft = existing
      ? { ...existing, body, updatedAt: at }
      : { id: newId(), file: c.file, side: c.side, line: c.line, lineText: c.lineText, body, status: "active", createdAt: at, updatedAt: at };
    // Keep the box open with its text if the save fails.
    if (await saveDrafts(() => putDrafts([draft]))) {
      if (c.replyTo) setFlagResolved(c.replyTo, true);
      setComposer(null);
    }
  };
  const deleteDraft = (d: Draft) => {
    if (composer()?.editingId === d.id) setComposer(null);
    void saveDrafts(() => removeDraft(d.id));
  };

  // ---------- screens and jumping ----------
  const [screen, setScreenSignal] = createSignal<Screen>(screenFromHash());
  // Swap screens inside a view transition where the browser has one and motion is welcome.
  const setScreenRaw = (next: Screen) => {
    if (next === screen()) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || still) return void setScreenSignal(next);
    document.startViewTransition(() => setScreenSignal(next));
  };
  const onHash = () => setScreenRaw(screenFromHash());
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  const [jump, setJump] = createSignal<Jump | null>(null);
  const go = (s: Screen, target?: Jump) => {
    if (target) {
      // Make sure the target is rendered: unfolded, and within the line cap.
      toggleCollapsed(target.file, false);
      const file = model().files.find((f) => f.file === target.file);
      if (file && target.line != null) {
        const row = rowIndex(file.lines).get(`${target.side ?? "new"}:${target.line}`);
        if (row !== undefined && row >= LINE_CAP) uncap(file.file);
        if (row !== undefined) reveal(file, row);
      }
      setJump(target);
    }
    if (screen() !== s) history.pushState(null, "", s === "review" ? "#review" : "#");
    setScreenRaw(s);
  };
  const goFlag = (f: FlagItem) => {
    if (!f.file) return go("review");
    go("review", { file: f.file, side: "new", line: f.placed ? f.line : null });
  };
  const goDraft = (d: Draft) => go("review", { file: d.file, side: d.side, line: d.status === "active" ? d.line : null });
  const resume = () => resumeTarget(order(), reviewed(), resolved());

  /** The file at the top of the diff, tracked from scroll. */
  const [current, setCurrent] = createSignal<string | null>(null);
  const isCurrent = createSelector(current);

  /** The line a hovered note points at, lit in the diff. */
  /** The diff line under the pointer; only it renders a + comment button. */
  const [hoverLine, setHoverLine] = createSignal<string | null>(null);
  const isHoverLine = createSelector(hoverLine);
  const [lit, setLit] = createSignal<string | null>(null);
  const isLit = createSelector(lit);
  const litKey = (file: string, side: Side, line: number) => anchorKey(file, side, line);

  // ---------- submit ----------
  const [drawer, setDrawer] = createSignal(false);
  const [reviewBody, setReviewBody] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [posted, setPosted] = createSignal<{ result: SubmitResult; prompt: string } | null>(null);
  const prompt = () => draftsPrompt(drafts(), order().map((f) => f.file));
  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    // The server clears drafts once GitHub accepts, so keep the prompt for Posted.
    const text = prompt();
    try {
      const result = await submitReview(reviewBody().trim() || undefined);
      batch(() => {
        setPosted({ result, prompt: text });
        setReviewBody("");
        setComposer(null);
      });
      setDraftSet(await fetchDrafts());
    } catch (e) {
      // Drafts are untouched on failure; the server only clears them after GitHub accepts.
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await copyText(text);
      return true;
    } catch (e) {
      setError(`Copy failed: ${String(e)}`);
      return false;
    }
  };

  return {
    payload,
    status,
    now,
    review,
    pr,
    model,
    order,
    files: () => model().files,
    fileByName: (name: string): ReviewFile | undefined => model().files.find((f) => f.file === name),
    groupBy,
    setGroupBy,
    notesOpen,
    setNotesOpen,
    railOpen,
    setRailOpen,
    reviewed,
    toggleReviewed,
    resolved,
    setFlagResolved,
    openFlags,
    collapsed,
    toggleCollapsed,
    folds,
    regionsOf,
    defIndex,
    isFolded,
    toggleFold,
    foldMany,
    uncapped,
    uncap,
    drafts,
    draftsByFile,
    sortedDrafts,
    error,
    setError,
    composer,
    setComposer,
    composerText,
    setComposerText,
    openComposer,
    replyToFlag,
    editDraft,
    saveComposer,
    deleteDraft,
    screen,
    go,
    goFlag,
    goDraft,
    jump,
    setJump,
    resume,
    current,
    setCurrent,
    isCurrent,
    setHoverLine,
    isHoverLine,
    lit,
    setLit,
    isLit,
    litKey,
    drawer,
    setDrawer,
    reviewBody,
    setReviewBody,
    submitting,
    submitError,
    posted,
    setPosted,
    prompt,
    submit,
    copy,
  };
}

export type Store = ReturnType<typeof createStore>;
const Ctx = createContext<Store>();
export const StoreProvider = Ctx.Provider;
export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
