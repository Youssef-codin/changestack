import type { ClassifyStatus, Verdict } from "@changestack/schema";
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Icon } from "./icons";
import { ago, type FlagItem, OTHER, featureGroups, TIER_ICON, tierColor, tierStats, VERDICT, verdictLine } from "./model";
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
    <div class="flex min-h-dvh flex-col">
      <TopBar
        middle={
          <Show when={s.pr()}>
            {(pr) => <span class="font-mono text-[13px] text-mu max-md:hidden">{pr().headRefName}</span>}
          </Show>
        }
        right={<ModelChip />}
      />
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

/** Count up to `to` once, unless motion is reduced. */
function useCountUp(to: () => number) {
  const [n, setN] = createSignal(0);
  onMount(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setN(to());
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setN(Math.round(to() * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });
  return n;
}

function Band() {
  const s = useStore();
  const verdict = () => s.review()?.annotation?.verdict ?? null;
  return (
    <section class="bg-pk text-ink">
      <div class="rise px-4 pt-9 pb-7 sm:px-9">
        <Switch>
          <Match when={verdict()}>{(v) => <VerdictBand verdict={v()} />}</Match>
          <Match when={s.status()?.state === "classifying" && (s.status() as Extract<ClassifyStatus, { state: "classifying" }>)}>
            {(st) => <WorkingBand status={st()} />}
          </Match>
          <Match when={s.status()?.state === "error" && (s.status() as Extract<ClassifyStatus, { state: "error" }>)}>
            {(st) => <FailedBand message={st().message} />}
          </Match>
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

function VerdictBand(props: { verdict: Verdict }) {
  const s = useStore();
  const score = useCountUp(() => props.verdict.score);
  const [fill, setFill] = createSignal(0);
  onMount(() => requestAnimationFrame(() => requestAnimationFrame(() => setFill(props.verdict.score))));
  const v = () => VERDICT[props.verdict.level];
  return (
    <div class="grid items-end gap-x-12 gap-y-4 md:grid-cols-[auto_minmax(0,1fr)]">
      <div>
        <div class="text-[13px] font-semibold opacity-75">Merge score</div>
        <div class="text-[88px] leading-[.9] font-semibold tracking-[-.06em] tabular-nums sm:text-[112px]" aria-label={`${props.verdict.score} out of 100`}>
          {score()}
          <small class="ml-1 text-[22px] tracking-normal opacity-55">/100</small>
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
        <div class="h-2.5 overflow-hidden rounded-full bg-ink/15">
          <i class="block h-full rounded-full bg-ink transition-[width] duration-1000 ease-[cubic-bezier(.2,.7,.2,1)]" style={{ width: `${fill()}%` }} />
        </div>
        <div class="mt-1.5 flex justify-between text-xs opacity-70">
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
      <Show
        when={s.model().flags.length}
        fallback={
          <p class="m-0 border-b border-ln py-3.5 text-mu">
            {s.review()?.annotation ? "No flags. Nothing in the session or the diff asked for a closer look." : "Flags show here once classification finishes."}
          </p>
        }
      >
        <For each={s.model().flags}>{(f, i) => <FlagRow flag={f} index={i()} />}</For>
      </Show>
    </>
  );
}

function FlagRow(props: { flag: FlagItem; index: number }) {
  const s = useStore();
  const where = () => (props.flag.file ? props.flag.file + (props.flag.placed ? `:${props.flag.line}` : "") : "whole PR");
  const done = () => s.resolved().has(props.flag.id);
  return (
    <button
      class="rise group grid w-full grid-cols-[40px_1fr_auto] items-center gap-x-3.5 gap-y-0.5 border-b border-ln py-3.5 text-left"
      style={{ "--i": props.index + 3 }}
      onClick={() => s.goFlag(props.flag)}
    >
      <FlagIcon kind={props.flag.kind} resolved={done()} class="row-span-2 size-10 text-[18px]" />
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="font-semibold capitalize" classList={{ "text-mu line-through": done() }}>
          {props.flag.kind}
        </span>
        <span class="font-mono text-[13px] break-all text-mu">{where()}</span>
      </div>
      <Icon name="chevron_right" class="col-start-3 row-span-2 row-start-1 text-[18px] text-mu transition-[translate] group-hover:translate-x-1" />
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
      class="rise group flex w-full items-center justify-between gap-4 rounded-3xl bg-tx py-4 pr-[18px] pl-6 text-left text-lg font-semibold text-bg disabled:opacity-60"
      style={{ "--i": 2 }}
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
      <span class="grid size-10 place-items-center rounded-full bg-pk text-[20px] text-ink transition-[translate] duration-200 group-hover:translate-x-1">
        <Icon name={target() ? "arrow_forward" : "check"} />
      </span>
    </button>
  );
}

function Features() {
  const s = useStore();
  return (
    <For each={featureGroups(s.model())} fallback={<p class="py-3 text-sm text-mu">Features show here once classification finishes.</p>}>
      {(g, i) => (
        <button
          class="rise grid w-full grid-cols-[24px_1fr] gap-x-2.5 border-b border-ln py-3 text-left hover:[&_b]:text-pkink"
          style={{ "--i": i() + 4 }}
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
