import { Match, Show, Switch } from "solid-js";
import { Briefing } from "./Briefing";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { Review } from "./Review";
import { createStore, StoreProvider, useStore } from "./store";
import { SubmitDrawer } from "./Submit";
import { Tooltip } from "./Tooltip";

/** Two screens: the Briefing opens first, Review is the diff. Submit is a drawer over either. */
export function App() {
  const store = createStore();
  return (
    <StoreProvider value={store}>
      <Switch>
        <Match when={store.screen() === "briefing"}>
          <Briefing />
        </Match>
        <Match when={store.screen() === "review"}>
          <Review />
        </Match>
      </Switch>
      <SubmitDrawer />
      <OfflineBanner />
      <ErrorToast />
      <Tooltip />
      <Menu />
    </StoreProvider>
  );
}

/** The CLI is gone: nothing saves until it runs again. Clears itself when it comes back. */
function OfflineBanner() {
  const s = useStore();
  return (
    <Show when={s.offline()}>
      <div
        class="fade-in fixed bottom-4 left-1/2 z-[55] flex max-w-[min(640px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-2 pr-4 pl-3 text-sm text-white shadow-lg"
        role="alert"
      >
        <Icon name="cloud_off" class="shrink-0 text-[18px] text-pk" />
        <span class="min-w-0">
          <b class="font-semibold">changestack stopped.</b> Drafts can't save until you run{" "}
          <code class="font-mono text-[13px]">changestack {s.pr()?.number ?? ""}</code> again.
        </span>
      </div>
    </Show>
  );
}

function ErrorToast() {
  const s = useStore();
  return (
    // While the CLI is gone, the banner already says why saving fails.
    <Show when={!s.offline() && s.error()}>
      <div class="fixed bottom-4 left-1/2 z-50 flex max-w-[min(640px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-2xl bg-ink py-2.5 pr-2.5 pl-4 text-sm text-white shadow-lg" role="alert">
        <Icon name="error" class="text-[18px] text-pk" />
        <span class="min-w-0 flex-1">{s.error()}</span>
        <button class="grid size-7 place-items-center rounded-full text-[16px] hover:bg-white/10" title="Dismiss" onClick={() => s.setError(null)}>
          <Icon name="close" />
        </button>
      </div>
    </Show>
  );
}
