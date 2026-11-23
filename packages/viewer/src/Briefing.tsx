import type { BriefingFacts, ClassifyStatus, ReviewPayload, TestRun, Verdict } from "@changestack/schema";
import { VERDICT_LEVELS, VERDICT_RANGES } from "@changestack/schema/tiers";
import { createEffect, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Icon, type IconName } from "./icons";
import { ago, flagColor, type FlagItem, OTHER, featureGroups, TIER_ICON, tierColor, tierStats, VERDICT, verdictLine } from "./model";
import { useStore } from "./store";
import { FlagIcon, Heading, plural, Spinner, TopBar } from "./ui";

/**
 * Briefing, "Open" layout (docs/design/briefing-layouts.html#open): a full-width pink
 * verdict band, then the page with no cards: Check first on the left, a rule, then
 * Resume review and What it builds on the right.
 */
export function Briefing() {
  const s = useStore();

  return (
    <div class="flex min-h-dvh flex-col px-2 sm:px-6">
      <TopBar middle={<Show when={s.pr()}>{(pr) => <span class="font-mono text-[13px] text-mu max-md:hidden">{pr().headRefName}</span>}</Show>} right={<ModelChip />} />
      <div class="flex flex-1 flex-col">
        <Band />
        <div class="grid w-full flex-1 gap-x-10 px-4 pt-7 pb-6 sm:px-9 lg:grid-cols-[minmax(0,1fr)_1px_340px]">
          <section class="order-2 lg:order-1">
            <CheckFirst />
          </section>
          <span class="order-2 bg-ln max-lg:hidden" />
          <section class="contents lg:order-3 lg:block">
            <div class="order-1 mb-7">
              <ResumeButton />
            </div>
            <div class="order-3 max-lg:mt-8">
              <Heading icon="category">What it builds</Heading>
              <Features />
            </div>
          </section>
        </div>
        <Footer />
      </div>
    </div>
  );
}

function ModelChip() {
  const s = useStore();
  const model = () => s.review()?.annotation?.model ?? (s.status()?.state === "classifying" ? (s.status() as { model: string }).model : null);
  return (
    <Show when={model()}>
      <span
        class="inline-flex items-center gap-1.5 rounded-full border border-ln px-3 py-[5px] text-[13px] text-mu max-md:hidden"
        title="The model that classified this PR. Set CHANGESTACK_MODEL to pin another."
      >
        <Icon name="neurology" class="text-[16px]" />
        <span class="font-medium text-tx">{model()}</span>
      </span>
    </Show>
  );
}

function Band() {
  const s = useStore();
  const verdict = () => s.review()?.annotation?.verdict ?? null;
  return (
    <section class="mx-2 mt-2 rounded-3xl bg-pk text-ink sm:mx-4 sm:mt-4">
      {/* Inset from the page edges; the inner padding keeps its text lined up with the page below. */}
      <div class="px-2 pt-9 pb-7 sm:px-5">
        <Switch>
          <Match when={verdict()}>{(v) => <VerdictBand verdict={v()} />}</Match>
          <Match when={s.status()?.state === "classifying" && (s.status() as Extract<ClassifyStatus, { state: "classifying" }>)}>{(st) => <WorkingBand status={st()} />}</Match>
          <Match when={s.status()?.state === "error" && (s.status() as Extract<ClassifyStatus, { state: "error" }>)}>{(st) => <FailedBand message={st().message} />}</Match>
          <Match when={s.payload.error}>
            <FailedBand message={`Couldn't reach changestack: ${String(s.payload.error)}`} />
          </Match>
          <Match when={true}>
            <div class="flex items-center gap-3 text-lg font-semibold">
              <Spinner /> Loading the review…
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

/**
 * Count down from `from` to `to`, easing in and out so it leaves and lands softly. It waits for
 * the page to go idle first (the rest of the Briefing renders right after this), so a long task
 * doesn't make the count skip, then pauses `delay` so the range reads before the count starts.
 * Jumps straight to `to` when motion is reduced.
 */
function useCountdown(from: number, to: number, delay = 250, duration = 1200) {
  const [n, setN] = createSignal(from);
  const [done, setDone] = createSignal(false);
  onMount(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
      setN(to);
      return setDone(true);
    }
    let raf = 0;
    let timer = 0;
    let idle = 0;
    const run = () => {
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, Math.max(0, (t - t0) / duration));
        const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
        setN(from + (to - from) * e);
        if (k < 1) raf = requestAnimationFrame(tick);
        else setDone(true);
      };
      raf = requestAnimationFrame(tick);
    };
    const later = () => (timer = window.setTimeout(run, delay));
    if ("requestIdleCallback" in window) idle = requestIdleCallback(later, { timeout: 1000 });
    else later();
    onCleanup(() => {
      if (idle) cancelIdleCallback(idle);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    });
  });
  return [n, done] as const;
}

function VerdictBand(props: { verdict: Verdict }) {
  const s = useStore();
  const v = () => VERDICT[props.verdict.level];
  const [lo, hi] = VERDICT_RANGES[props.verdict.level];
  // The score tells how it was reached: the level picks a range, which shows first, then the
  // score counts down from the top of that range (farther for a bigger change), the fill with it.
  const [n, settled] = useCountdown(hi, props.verdict.score);
  return (
    <div class="grid items-end gap-x-12 gap-y-4 md:grid-cols-[auto_minmax(0,1fr)]">
      <div>
        <div class="text-[13px] font-semibold opacity-75">Merge score</div>
        {/* An invisible copy of the starting count holds the column's width, so the verdict beside it doesn't shift as digits drop. */}
        <div class="grid text-[88px] leading-[.9] font-semibold tracking-[-.06em] tabular-nums sm:text-[112px]" aria-label={`${props.verdict.score} out of 100`}>
          <span class="invisible col-start-1 row-start-1" aria-hidden="true">
            {hi}
            <small class="ml-1 text-[22px] tracking-normal">/100</small>
          </span>
          <span class="col-start-1 row-start-1">
            {Math.round(n())}
            <small class="ml-1 text-[22px] tracking-normal opacity-55">/100</small>
          </span>
        </div>
      </div>
      <div>
        <div class="flex items-center gap-3 text-[40px] leading-none font-semibold tracking-[-.04em] sm:text-[52px]">
          <Icon name={v().icon} class="text-[38px] sm:text-[46px]" />
          {v().name}
        </div>
        <p class="mt-3 mb-4 text-lg opacity-85">{verdictLine(props.verdict.level, s.model())}</p>
        <Tags />
      </div>
      <div class="md:col-span-2">
        <div class="relative h-2.5 overflow-hidden rounded-full bg-ink/15">
          <i class="range-lit absolute inset-y-0 bg-ink/25" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
          <i class="relative block h-full rounded-full bg-ink" style={{ width: `${n()}%` }} />
        </div>
        {/* Once the count settles, every level's range is bracketed and named under the bar, this PR's in full. */}
        <div class="relative mt-1 h-5" aria-hidden="true">
          <Show when={settled()}>
            <For each={VERDICT_LEVELS}>
              {(level) => {
                const [a, b] = VERDICT_RANGES[level];
                const mine = level === props.verdict.level;
                return (
                  <div class="fade-in absolute inset-y-0 px-px" classList={{ "opacity-60": !mine }} style={{ left: `${a}%`, width: `${b - a}%` }}>
                    <div
                      class="h-1.5 border-x border-b"
                      classList={{
                        "border-ink/60": mine,
                        "border-ink/40": !mine,
                      }}
                    />
                    <div class="mt-0.5 truncate text-center text-xs" classList={{ "font-semibold": mine }}>
                      {VERDICT[level].name}
                      <span class="ml-1 tabular-nums opacity-70 max-sm:hidden">
                        {a}–{b}
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
        <div class="mt-1 flex justify-between text-xs opacity-70">
          <span class="inline-flex items-center gap-1">
            <Icon name="north" class="text-[14px]" /> higher is safer
          </span>
          <span>0 to 100</span>
        </div>
      </div>
    </div>
  );
}

/** What changed per tier, plus the flag count. Each chip jumps to what it counts. */
function Tags() {
  const s = useStore();
  const stats = () => tierStats(s.files());
  return (
    <div class="flex flex-wrap gap-1.5">
      <For each={stats()}>
        {(t) => (
          <button
            class="inline-flex items-center gap-1.5 rounded-full bg-white/90 py-[5px] pr-3 pl-1.5 text-[13px] font-medium text-ink hover:bg-white"
            title={`Review the ${t.tier} files`}
            onClick={() => {
              const f = s.order().find((x) => x.tier === t.tier);
              if (f) s.go("review", { file: f.file });
            }}
          >
            <span class="grid size-[18px] place-items-center rounded-full text-[12px]" style={{ background: tierColor(t.tier) }}>
              <Icon name={TIER_ICON[t.tier]} />
            </span>
            {t.files} {t.tier}
            <b class="font-mono text-xs font-medium opacity-60">{t.lines}</b>
          </button>
        )}
      </For>
      <Show when={s.model().flags.length}>
        <a href="#check-first" class="inline-flex items-center gap-1.5 rounded-full bg-ink py-[5px] pr-3 pl-1.5 text-[13px] font-medium text-white">
          <span class="grid size-[18px] place-items-center rounded-full bg-pk text-[12px] text-ink">
            <Icon name="flag-fill" />
          </span>
          {plural(s.model().flags.length, "flag")}
        </a>
      </Show>
    </div>
  );
}

function WorkingBand(props: { status: Extract<ClassifyStatus, { state: "classifying" }> }) {
  const s = useStore();
  const elapsed = () => Math.max(0, Math.round((s.now() - Date.parse(props.status.startedAt)) / 1000));
  return (
    <div class="grid gap-3" role="status">
      <div class="text-[13px] font-semibold opacity-75">Merge score</div>
      <div class="flex items-center gap-3 text-[40px] leading-none font-semibold tracking-[-.04em] sm:text-[52px]">
        <Spinner class="text-[40px]" />
        Working it out…
      </div>
      <p class="m-0 text-lg opacity-85">
        Classifying {plural(props.status.files, "file")} with {props.status.model}, {elapsed()}s. {props.status.detail}
      </p>
      <p class="m-0 text-sm opacity-70">The diff is already readable in Review; files reorder once this finishes.</p>
    </div>
  );
}

function FailedBand(props: { message: string }) {
  return (
    <div class="grid gap-3" role="alert">
      <div class="flex items-center gap-3 text-[40px] leading-none font-semibold tracking-[-.04em]">
        <Icon name="error" class="text-[40px]" />
        Couldn't classify
      </div>
      <p class="m-0 text-lg opacity-85">{props.message}</p>
      <p class="m-0 text-sm opacity-70">
        The raw diff is still in Review. Run <code class="rounded bg-ink/10 px-1.5 font-mono">changestack --refresh</code> to try again.
      </p>
    </div>
  );
}

function CheckFirst() {
  const s = useStore();
  return (
    <>
      <Heading icon="flag" id="check-first">
        Check first
      </Heading>
      <Facts />
      <Show
        when={s.model().flags.length}
        fallback={
          <p class="m-0 border-b border-ln py-3.5 text-mu">
            {s.review()?.annotation ? "No flags. Nothing in the session or the diff asked for a closer look." : "Flags show here once classification finishes."}
          </p>
        }
      >
        <For each={s.model().flags}>{(f) => <FlagRow flag={f} />}</For>
      </Show>
    </>
  );
}

/**
 * The store polls only while classifying, but facts land a second after startup and CI
 * may still be running, so this asks again on its own until both have settled.
 */
function useFacts() {
  const s = useStore();
  const [fresh, setFresh] = createSignal<BriefingFacts | null | undefined>(undefined, { equals: false });
  const facts = () => (fresh() === undefined ? (s.payload.latest?.facts ?? null) : fresh()!);
  createEffect(() => {
    if (!s.payload.latest) return;
    const f = facts();
    if (f && f.ci?.state !== "pending") return;
    const timer = setTimeout(
      () =>
        void fetch("/api/review")
          .then((r) => (r.ok ? (r.json() as Promise<ReviewPayload>) : null))
          .then((p) => setFresh(p ? p.facts : facts()))
          .catch(() => setFresh(facts())),
      f ? 15_000 : 1_500,
    );
    onCleanup(() => clearTimeout(timer));
  });
  return facts;
}

interface Fact {
  icon: IconName;
  tone: "good" | "bad" | "muted";
  title: string;
  detail: string;
  spin?: boolean;
  href?: string;
  onClick?: () => void;
}

const sessionLabel = (runs: TestRun[], r: TestRun) => {
  const sessions = [...new Set(runs.map((x) => x.session))];
  return sessions.length > 1 ? `session ${sessions.indexOf(r.session) + 1}, turn ${r.turn}` : `turn ${r.turn}`;
};

function ciFact(f: BriefingFacts, prUrl: string): Fact | null {
  const ci = f.ci;
  if (!ci) return null;
  const checks = `${prUrl}/checks`;
  const n = (b: string) => ci.checks.filter((c) => c.bucket === b);
  switch (ci.state) {
    case "passing":
      return { icon: "check_circle", tone: "good", title: "CI passing", detail: plural(n("pass").length, "check"), href: checks };
    case "failing": {
      const bad = [...n("fail"), ...n("cancel")];
      return { icon: "error", tone: "bad", title: "CI failing", detail: bad.map((c) => c.name).join(", "), href: bad.find((c) => c.url)?.url || checks };
    }
    case "pending":
      return { icon: "progress_activity", tone: "muted", spin: true, title: "CI running", detail: `${ci.checks.length - n("pending").length} of ${plural(ci.checks.length, "check")} done`, href: checks };
    case "none":
      return { icon: "help", tone: "muted", title: "No CI", detail: "no checks reported on this head" };
  }
}

/** What the session's own test runs say: the last one's outcome, and the first failure if it recovered. */
function testRunFact(f: BriefingFacts, hasSession: boolean): Fact | null {
  const runs = f.testRuns;
  const tests = runs.filter((r) => r.kind === "test");
  if (tests.length === 0) {
    if (!hasSession) return null;
    const lastCheck = runs.at(-1);
    return {
      icon: "science_off",
      tone: "bad",
      title: "No test run in the session",
      detail: lastCheck ? `last ${lastCheck.command.split(" ").slice(0, 3).join(" ")} ${lastCheck.ok ? "passed" : "failed"}` : "nor a type-check or lint",
    };
  }
  const last = tests.at(-1)!;
  const firstFail = tests.find((r) => !r.ok);
  if (!last.ok) return { icon: "error", tone: "bad", title: `Test run failed at ${sessionLabel(runs, last)}`, detail: `${last.command}, the last one the agent ran` };
  if (firstFail) return { icon: "science", tone: "muted", title: `Test run failed at ${sessionLabel(runs, firstFail)}`, detail: `passed again by ${sessionLabel(runs, last)}` };
  return { icon: "science", tone: "good", title: "Tests passed in the session", detail: `${plural(tests.length, "run")}, last at ${sessionLabel(runs, last)}` };
}

function testFilesFact(f: BriefingFacts, open: (file: string) => void): Fact {
  const added = f.testFiles.filter((t) => t.status === "added").length;
  const changed = f.testFiles.length - added;
  if (f.testFiles.length === 0) return { icon: "science_off", tone: "bad", title: "No tests added", detail: "no test file in this PR" };
  const first = f.testFiles[0]!.file;
  return {
    icon: "science",
    tone: "good",
    title: added ? `${plural(added, "test file")} added` : `${plural(changed, "test file")} changed`,
    detail: added && changed ? `and ${changed} changed` : first,
    onClick: () => open(first),
  };
}

/** One row of plain facts above the flags: CI on the head, the session's test runs, tests in the diff. */
function Facts() {
  const s = useStore();
  const facts = useFacts();
  const items = (): Fact[] => {
    const f = facts();
    const pr = s.pr();
    if (!f || !pr) return [];
    const hasSession = (s.review()?.annotation?.transcripts.length ?? f.testRuns.length) > 0;
    return [ciFact(f, pr.url), testRunFact(f, hasSession), testFilesFact(f, (file) => s.go("review", { file }))].filter((x): x is Fact => !!x);
  };
  const toneColor = { good: "var(--color-addt)", bad: "var(--color-delt)", muted: "var(--color-mu)" };
  return (
    <Show when={facts()} fallback={<p class="m-0 flex items-center gap-2 border-b border-ln py-3.5 text-sm text-mu"><Spinner /> Checking CI and the session's test runs…</p>}>
      <div class="grid gap-px border-b border-ln sm:grid-cols-3">
        <For each={items()}>
          {(fact) => {
            const body = (): JSX.Element => (
              <>
                <span class="row-span-2 mt-0.5 text-[18px]" style={{ color: toneColor[fact.tone] }}>
                  <Icon name={fact.icon} class={fact.spin ? "animate-spin" : ""} />
                </span>
                <b class="text-sm font-semibold">{fact.title}</b>
                <span class="truncate font-mono text-xs text-mu" title={fact.detail}>
                  {fact.detail}
                </span>
              </>
            );
            const cls = "grid grid-cols-[22px_minmax(0,1fr)] gap-x-2 py-3.5 pr-3 text-left";
            return (
              <Switch fallback={<div class={cls}>{body()}</div>}>
                <Match when={fact.href}>
                  <a class={`${cls} hover:bg-hov`} href={fact.href} target="_blank" rel="noreferrer">
                    {body()}
                  </a>
                </Match>
                <Match when={fact.onClick}>
                  <button class={`${cls} hover:bg-hov`} onClick={fact.onClick}>
                    {body()}
                  </button>
                </Match>
              </Switch>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

function FlagRow(props: { flag: FlagItem }) {
  const s = useStore();
  const where = () => (props.flag.file ? props.flag.file + (props.flag.placed ? `:${props.flag.line}` : "") : "whole PR");
  const done = () => s.resolved().has(props.flag.id);
  return (
    <button
      class="gutter-mark group grid w-full grid-cols-[40px_1fr_auto] items-center gap-x-3.5 gap-y-0.5 border-b border-ln py-3.5 pl-3 text-left hover:bg-hov"
      style={{
        "--mark": done() ? "var(--color-mu)" : flagColor(props.flag.kind),
      }}
      onClick={() => s.goFlag(props.flag)}
    >
      <FlagIcon kind={props.flag.kind} resolved={done()} class="row-span-2 size-10 text-[18px]" />
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="font-semibold capitalize" classList={{ "strike text-mu": done() }}>
          {props.flag.kind}
        </span>
        <span class="font-mono text-[13px] break-all text-mu">{where()}</span>
      </div>
      <Icon name="chevron_right" class="col-start-3 row-span-2 row-start-1 text-[18px] text-mu group-hover:text-tx" />
      <div class="text-mu">{props.flag.note}</div>
    </button>
  );
}

function ResumeButton() {
  const s = useStore();
  const target = () => s.resume();
  const started = () => s.reviewed().size > 0;
  return (
    <button
      class="group flex w-full items-center justify-between gap-4 rounded-3xl bg-tx py-4 pr-[18px] pl-6 text-left text-lg font-semibold text-bg hover:bg-tx/90 disabled:opacity-60"
      disabled={s.files().length === 0}
      onClick={() => {
        const t = target();
        s.go("review", t ? { file: t.file.file, side: "new", line: t.line } : undefined);
      }}
    >
      <span>
        {target() ? (started() ? "Resume review" : "Start review") : "All files reviewed"}
        <small class="block font-mono text-[13px] font-normal opacity-65">
          {target() ? `at ${target()!.file.name}${target()!.line ? `:${target()!.line}` : ""}` : s.files().length ? "open the diff" : "no files changed"}
        </small>
      </span>
      <span class="grid size-10 place-items-center rounded-full bg-pk text-[20px] text-ink">
        <Icon name={target() ? "arrow_forward" : "check"} />
      </span>
    </button>
  );
}

function Features() {
  const s = useStore();
  return (
    <For each={featureGroups(s.model())} fallback={<p class="py-3 text-sm text-mu">Features show here once classification finishes.</p>}>
      {(g) => (
        <button
          class="grid w-full grid-cols-[24px_1fr] gap-x-2.5 border-b border-ln py-3 text-left hover:[&_b]:text-pkink"
          onClick={() => {
            s.setGroupBy("feature");
            const f = g.files[0];
            if (f) s.go("review", { file: f.file });
          }}
        >
          <Icon name={g.name === OTHER ? "folder_open" : "category"} class="row-span-2 mt-0.5 text-[18px] text-mu" />
          <b class="text-sm font-semibold">
            {g.name} <span class="font-mono text-xs font-normal text-mu">{plural(g.files.length, "file")}</span>
          </b>
          <Show when={g.why}>
            <p class="m-0 text-[13px] text-mu">{g.why}</p>
          </Show>
        </button>
      )}
    </For>
  );
}

function Footer() {
  const s = useStore();
  const ann = () => s.review()?.annotation ?? null;
  const cached = () => {
    const st = s.status();
    return st?.state === "ready" && st.cached;
  };
  return (
    <Show when={ann()}>
      {(a) => (
        <div class="flex w-full flex-wrap gap-x-[18px] gap-y-1 px-4 pb-6 text-[13px] text-mu sm:px-9">
          <span class="inline-flex items-center gap-1.5">
            <Icon name="forum" class="text-[16px]" />
            {a().transcripts.length ? plural(a().transcripts.length, "agent session") : "No agent session found for this PR; flags come from the diff only"}
          </span>
          <span class="inline-flex items-center gap-1.5">
            <Icon name="history" class="text-[16px]" />
            Classified {ago(a().createdAt, s.now())} with {a().model}
            {cached() ? ", cached" : ""}
          </span>
        </div>
      )}
    </Show>
  );
}
