import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon, type IconName } from "./icons";

/**
 * One context menu for the whole app; render `<Menu />` once at the root and open it from
 * any `contextmenu` handler with `openMenu(e, items)`. Closes on a pick, Escape, a click
 * elsewhere, scrolling or leaving the window. Arrow keys move, Enter picks.
 */

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** A shortcut that does the same, shown on the right. */
  hint?: string;
  onSelect: () => void;
}

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
}

export const closeMenu = () => setMenu(null);

const EDGE = 8;

export function Menu() {
  let el: HTMLDivElement | undefined;
  /** Where focus was before the menu took it, to hand back on close. */
  let before: Element | null = null;

  const buttons = () => [...(el?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];

  const close = () => {
    if (!menu()) return;
    setMenu(null);
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    before = null;
  };

  /** Keep the menu on screen, then focus its first item. */
  const placed = (node: HTMLDivElement) => {
    el = node;
    const m = menu()!;
    before = document.activeElement;
    queueMicrotask(() => {
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      node.style.left = `${Math.max(EDGE, Math.min(m.x, innerWidth - w - EDGE))}px`;
      node.style.top = `${m.y + h > innerHeight - EDGE ? Math.max(EDGE, m.y - h) : m.y}px`;
      buttons()[0]?.focus({ preventScroll: true });
    });
  };

  const pick = (item: MenuItem) => {
    close();
    item.onSelect();
  };

  const onKey = (e: KeyboardEvent) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  onMount(() => {
    const outside = (e: Event) => {
      if (menu() && !(e.target instanceof Node && el?.contains(e.target))) close();
    };
    // A right-click elsewhere closes this one; its own handler may open the next.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("contextmenu", outside, true);
    window.addEventListener("scroll", outside, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("scroll", outside, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    });
  });

  return (
    <Show when={menu()}>
      {(m) => (
        <div ref={placed} class="menu" role="menu" onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
          <For each={m().items}>
            {(item) => (
              <button type="button" role="menuitem" class="menu-item" onClick={() => pick(item)}>
                <Show when={item.icon} fallback={<span class="w-4" />}>
                  <Icon name={item.icon!} class="text-[16px] text-mu" />
                </Show>
                <span class="min-w-0 flex-1 truncate">{item.label}</span>
                <Show when={item.hint}>
                  <kbd class="font-mono text-[11px] text-mu">{item.hint}</kbd>
                </Show>
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
