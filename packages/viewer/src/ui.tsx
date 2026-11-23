import type { Flag, Tier } from "@changestack/schema";
import { type JSX, Show } from "solid-js";
import { Icon } from "./icons";
import { FLAG_ICON, flagColor, TIER_ICON, tierColor, VERDICT } from "./model";
import { useStore } from "./store";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Tier as an icon in a tier-colored circle; never color alone. */
export function TierBadge(props: { tier: Tier; size?: "sm" | "md" | "lg" }) {
  const size = () => ({ sm: "size-4 text-[11px]", md: "size-5 text-[14px]", lg: "size-[22px] text-[15px]" })[props.size ?? "md"];
  return (
    <span class={`inline-grid shrink-0 place-items-center rounded-full text-ink ${size()}`} style={{ background: tierColor(props.tier) }} title={props.tier}>
      <Icon name={TIER_ICON[props.tier]} />
    </span>
  );
}

/** Filled tier pill: icon and name. */
export function TierTag(props: { tier: Tier }) {
  return (
    <span class="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-[7px] text-xs font-semibold text-ink capitalize" style={{ background: tierColor(props.tier) }}>
      <Icon name={TIER_ICON[props.tier]} class="text-[15px]" />
      {props.tier}
    </span>
  );
}

/** A flag kind's round icon; gray with a check once resolved. */
export function FlagIcon(props: { kind: Flag["kind"]; resolved?: boolean; class?: string }) {
  return (
    <span
      class={`inline-grid shrink-0 place-items-center rounded-full ${props.resolved ? "bg-hov text-mu" : "text-onfl"} ${props.class ?? "size-5 text-[13px]"}`}
      style={props.resolved ? undefined : { background: flagColor(props.kind) }}
      title={`${props.kind}${props.resolved ? ", resolved" : ""}`}
    >
      <Icon name={props.resolved ? "check" : FLAG_ICON[props.kind]} />
    </span>
  );
}

export function Spinner(props: { class?: string }) {
  return <Icon name="progress_activity" class={`spin ${props.class ?? ""}`} />;
}

/** The top bar both screens share; `middle` and `right` hold what differs. */
export function TopBar(props: { middle?: JSX.Element; right?: JSX.Element }) {
  const s = useStore();
  return (
    <header class="relative z-20 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 border-b border-ln px-4 py-3 sm:px-7">
      <Show when={s.screen() === "review"}>
        <button
          class="-mr-1 grid size-8 shrink-0 place-items-center rounded-full text-[18px] text-mu shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov hover:text-tx"
          title="Back to the briefing"
          aria-label="Back to the briefing"
          onClick={() => s.go("briefing")}
        >
          <Icon name="arrow_back" />
        </button>
      </Show>
      <button class="flex items-center gap-2 font-semibold" onClick={() => s.go("briefing")} title="Briefing">
        <span class="grid size-7 place-items-center rounded-[9px] bg-tx text-[18px] text-bg">
          <Icon name="stacks" />
        </span>
        <span class="max-sm:hidden">changestack</span>
      </button>
      <Show when={s.pr()}>
        {(pr) => (
          <>
            <a
              href={pr().url}
              target="_blank"
              rel="noreferrer"
              class="inline-flex shrink-0 items-center gap-1 rounded-full bg-gh py-[3px] pr-2.5 pl-[7px] font-mono text-[13px] font-semibold text-white"
              title="Open on GitHub"
            >
              <Icon name="merge" class="text-[16px]" />#{pr().number}
            </a>
            <span class="min-w-0 truncate font-semibold" title={pr().title}>
              {pr().title}
            </span>
          </>
        )}
      </Show>
      {props.middle}
      <span class="flex-1" />
      {props.right}
      <SubmitButton />
    </header>
  );
}

export function SubmitButton() {
  const s = useStore();
  const n = () => s.drafts().length;
  return (
    <button
      class="flex items-center gap-2 rounded-full bg-pk py-2 pr-3.5 pl-3 text-sm font-semibold text-ink disabled:opacity-50"
      disabled={n() === 0 && !s.posted()}
      title={n() === 0 ? "Nothing to submit yet: hover a line and click + to comment" : "Review your drafts and post them"}
      onClick={() => s.setDrawer(true)}
    >
      <Icon name="send" class="text-[18px]" />
      Submit
      <b class="rounded-full bg-ink px-[7px] font-mono text-[11px] leading-[18px] font-semibold text-white">{n()}</b>
    </button>
  );
}

/** Verdict as a small chip for the Review top bar; opens the Briefing. */
export function VerdictChip() {
  const s = useStore();
  return (
    <Show when={s.review()?.annotation?.verdict}>
      {(v) => (
        <button
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-pk py-[3px] pr-[3px] pl-[9px] text-[13px] font-semibold whitespace-nowrap text-ink"
          title="Merge verdict, set once when the PR was classified. Opens the briefing."
          onClick={() => s.go("briefing")}
        >
          <Icon name={VERDICT[v().level].icon} class="text-[16px]" />
          {VERDICT[v().level].name}
          <b class="rounded-full bg-ink px-[7px] font-mono text-xs leading-5 font-semibold text-white">{v().score}</b>
        </button>
      )}
    </Show>
  );
}

/** By tier / By feature switch. */
export function GroupSwitch(props: { class?: string }) {
  const s = useStore();
  const btn = (g: "tier" | "feature", icon: "layers" | "category", label: string) => (
    <button
      class="relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-[5px] text-xs font-medium whitespace-nowrap"
      classList={{ "text-ink": s.groupBy() === g, "text-mu hover:text-tx": s.groupBy() !== g }}
      aria-pressed={s.groupBy() === g}
      onClick={() => s.setGroupBy(g)}
    >
      <Icon name={icon} class="text-[16px]" />
      {label}
    </button>
  );
  return (
    <div class={`relative flex rounded-full bg-hov p-[3px] ${props.class ?? ""}`}>
      {/* The pink pill slides between the two halves. */}
      <span
        class="absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-full bg-pk transition-[translate] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]"
        style={{ translate: s.groupBy() === "feature" ? "100% 0" : "0 0" }}
        aria-hidden="true"
      />
      {btn("tier", "layers", "By tier")}
      {btn("feature", "category", "By feature")}
    </div>
  );
}

/** A file name that truncates before its extension: `very-long-na….ts`. */
export function FileName(props: { name: string; class?: string }) {
  const dot = () => props.name.lastIndexOf(".");
  return (
    <span class={`flex min-w-0 whitespace-nowrap ${props.class ?? ""}`} title={props.name}>
      <span class="truncate">{dot() > 0 ? props.name.slice(0, dot()) : props.name}</span>
      {dot() > 0 ? props.name.slice(dot()) : ""}
    </span>
  );
}

/** Small uppercase section heading with an icon. */
export function Heading(props: { icon: Parameters<typeof Icon>[0]["name"]; children: JSX.Element; id?: string }) {
  return (
    <h2 id={props.id} class="m-0 mb-1 flex items-center gap-2 text-[13px] font-semibold tracking-[.08em] text-mu uppercase">
      <Icon name={props.icon} class="text-[17px] text-pkink" />
      {props.children}
    </h2>
  );
}
