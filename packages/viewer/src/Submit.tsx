import type { Draft } from "@changestack/schema";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "./icons";
import { useStore } from "./store";
import { plural } from "./ui";

/**
 * Submit: a drawer from the right over the review. Every draft once, grouped by file,
 * outdated ones apart; then Post review or Copy all as prompt. After posting it turns
 * into Posted.
 */
export function SubmitDrawer() {
  const s = useStore();
  return (
    <Show when={s.drawer()}>
      <div class="fade-in fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px]" onClick={() => s.setDrawer(false)} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Submit review"
        class="drawer-in fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-ln bg-bg shadow-[-12px_0_40px_rgb(0_0_0/.18)] sm:w-[480px]"
      >
        <Show when={s.posted()} fallback={<Confirm />}>
          {(p) => <Posted result={p().result} prompt={p().prompt} />}
        </Show>
      </aside>
    </Show>
  );
}

function Header(props: { title: string }) {
  const s = useStore();
  return (
    <div class="flex items-center gap-3 border-b border-ln px-6 py-4">
      <h2 class="m-0 flex-1 text-base font-semibold">{props.title}</h2>
      <button class="grid size-8 place-items-center rounded-full text-[20px] text-mu hover:bg-hov hover:text-tx" title="Close (Esc)" onClick={() => s.setDrawer(false)}>
        <Icon name="close" />
      </button>
    </div>
  );
}

function Confirm() {
  const s = useStore();
  const groups = createMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of s.sortedDrafts()) if (d.status === "active") m.set(d.file, [...(m.get(d.file) ?? []), d]);
    return [...m];
  });
  const outdated = () => s.sortedDrafts().filter((d) => d.status === "outdated");
  const active = () => s.drafts().length - outdated().length;
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    if (await s.copy(s.prompt())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const open = (d: Draft) => {
    s.goDraft(d);
  };

  return (
    <>
      <Header title={`Submit review · #${s.pr()?.number ?? ""}`} />
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Show when={s.drafts().length} fallback={<p class="text-mu">No drafts yet. Hover a line in the diff and click + to comment.</p>}>
          <For each={groups()}>
            {([file, list]) => (
              <section class="mb-5">
                <h3 class="m-0 mb-1.5 font-mono text-xs font-semibold tracking-[.06em] break-all text-mu uppercase">{file}</h3>
                <For each={list}>{(d) => <DraftItem draft={d} onOpen={() => open(d)} />}</For>
              </section>
            )}
          </For>
          <Show when={outdated().length}>
            <section class="mb-5">
              <h3 class="m-0 mb-1.5 text-xs font-semibold tracking-[.06em] text-mu uppercase">Outdated · goes in the review body</h3>
              <For each={outdated()}>{(d) => <DraftItem draft={d} onOpen={() => open(d)} />}</For>
            </section>
          </Show>
        </Show>

        <label class="mt-2 block text-[13px] font-semibold" for="overall">
          Overall comment <span class="font-normal text-mu">(optional)</span>
        </label>
        <textarea
          id="overall"
          rows={4}
          class="mt-1.5 block w-full resize-y rounded-xl border border-ln bg-code px-3 py-2 text-sm outline-none placeholder:text-mu focus:border-pk"
          placeholder="A summary for the author"
          value={s.reviewBody()}
          onInput={(e) => s.setReviewBody(e.currentTarget.value)}
        />
      </div>

      <div class="flex flex-col gap-3 border-t border-ln px-6 py-4">
        <Show when={s.submitError()}>
          <p class="m-0 rounded-xl bg-risky/12 px-3 py-2 text-sm text-risky" role="alert">
            <b>GitHub didn't take the review.</b> {s.submitError()} Your drafts are kept; try again.
          </p>
        </Show>
        <p class="m-0 text-[13px] text-mu">
          Posts {plural(active(), "comment")}
          {outdated().length ? ` and ${plural(outdated().length, "outdated note")}` : ""} to #{s.pr()?.number} as you. Comment only, no approval. Flags stay
          here; they're never posted.
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            class="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov disabled:opacity-50"
            disabled={!s.drafts().length}
            onClick={copy}
          >
            <Icon name={copied() ? "check" : "content_copy"} class="text-[16px]" />
            {copied() ? "Copied" : "Copy all as prompt"}
          </button>
          <button
            class="inline-flex items-center gap-1.5 rounded-full bg-pk px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
            disabled={!s.drafts().length || s.submitting()}
            onClick={() => void s.submit()}
          >
            <Icon name={s.submitting() ? "progress_activity" : "send"} class={`text-[16px] ${s.submitting() ? "spin" : ""}`} />
            {s.submitting() ? "Posting…" : "Post review"}
          </button>
        </div>
      </div>
    </>
  );
}

function DraftItem(props: { draft: Draft; onOpen: () => void }) {
  const s = useStore();
  const d = props.draft;
  return (
    <div class="group grid grid-cols-[auto_1fr_auto] gap-x-3 border-b border-ln py-2.5 text-sm last:border-b-0">
      <button class="font-mono text-xs whitespace-nowrap text-mu hover:text-tx" title="Show in the diff" onClick={props.onOpen}>
        {d.status === "outdated" ? `${d.file.slice(d.file.lastIndexOf("/") + 1)} · was line ${d.line}` : `line ${d.line}`}
      </button>
      <div class="min-w-0">
        <Show when={d.status === "outdated"}>
          <code class="mb-1 block truncate rounded-md bg-hov px-2 font-mono text-xs leading-5 text-mu">{d.lineText.trim() || "(blank line)"}</code>
        </Show>
        <p class="m-0 whitespace-pre-wrap">{d.body}</p>
      </div>
      <span class="flex gap-0.5 opacity-60 group-hover:opacity-100">
        <button
          class="grid size-7 place-items-center rounded-full text-[16px] text-mu hover:bg-hov hover:text-tx"
          title="Edit in the diff"
          onClick={() => {
            s.setDrawer(false);
            s.goDraft(d);
            s.editDraft(d);
          }}
        >
          <Icon name="edit" />
        </button>
        <button class="grid size-7 place-items-center rounded-full text-[16px] text-mu hover:bg-hov hover:text-tx" title="Delete draft" onClick={() => s.deleteDraft(d)}>
          <Icon name="delete" />
        </button>
      </span>
    </div>
  );
}

function Posted(props: { result: { url: string; posted: number; inBody: number }; prompt: string }) {
  const s = useStore();
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    if (await s.copy(props.prompt)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <>
      <Header title={`#${s.pr()?.number ?? ""} ${s.pr()?.title ?? ""}`} />
      <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <span class="appear grid size-16 place-items-center rounded-full bg-pk text-[34px] text-ink">
          <Icon name="check" />
        </span>
        <div class="text-[28px] font-semibold tracking-[-.03em]">Review posted</div>
        <p class="m-0 text-mu">
          {plural(props.result.posted, "comment")} on #{s.pr()?.number}
          {props.result.inBody ? `, plus ${plural(props.result.inBody, "outdated note")} in the review body` : ""}.
        </p>
        <div class="flex flex-wrap justify-center gap-2">
          <button class="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium shadow-[inset_0_0_0_1px_var(--color-ln)] hover:bg-hov" onClick={copy}>
            <Icon name={copied() ? "check" : "content_copy"} class="text-[16px]" />
            {copied() ? "Copied" : "Copy as prompt"}
          </button>
          <a href={props.result.url} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 rounded-full bg-tx px-4 py-2 text-sm font-semibold text-bg">
            View on GitHub
            <Icon name="open_in_new" class="text-[16px]" />
          </a>
        </div>
        <p class="m-0 max-w-[36ch] text-[13px] text-mu">
          Drafts cleared. After the agent pushes, run <code class="font-mono">changestack {s.pr()?.number}</code> again.
        </p>
        <button class="text-[13px] text-mu underline underline-offset-2 hover:text-tx" onClick={() => s.setPosted(null)}>
          Back to drafts
        </button>
      </div>
    </>
  );
}
