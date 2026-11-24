import { onCleanup, onMount } from "solid-js";

/**
 * One styled tooltip for every `title` in the app; render once at the root.
 *
 * Components keep writing plain `title="…"`. While the pointer (or keyboard focus) is on an
 * element, its title moves to `data-tip` so the browser's own tooltip never shows, and goes
 * back when it leaves, so icon buttons keep their accessible name.
 */
export function Tooltip() {
  let tip!: HTMLDivElement;
  let target: Element | null = null;
  /** The target and every titled ancestor: the browser falls back to an outer title once the inner one is gone. */
  let held: Element[] = [];
  let observer: MutationObserver | undefined;
  let timer: number | undefined;
  /** When the last tooltip closed: moving straight to the next hint shows it without the delay. */
  let lastHidden = 0;
  /** A press dismisses the tooltip until the pointer moves to something else. */
  let suppressed = false;

  const DELAY = 750;
  /** Delay for the next hint while one was just open, so sweeping across rows doesn't flash each one. */
  const WARM_DELAY = 150;
  const WARM = 300;
  const GAP = 6;
  const EDGE = 8;

  const take = (el: Element) => {
    const t = el.getAttribute("title");
    if (t === null) return;
    el.setAttribute("data-tip", t);
    el.removeAttribute("title");
  };

  const place = () => {
    if (!target || !target.isConnected) return hide();
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - EDGE));
    const below = r.bottom + GAP;
    const top = below + h > innerHeight - EDGE && r.top - GAP - h >= EDGE ? r.top - GAP - h : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const show = () => {
    const text = target?.getAttribute("data-tip")?.trim();
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    place();
  };

  const hide = () => {
    clearTimeout(timer);
    if (!tip.hidden) lastHidden = performance.now();
    tip.hidden = true;
  };

  const release = () => {
    hide();
    observer?.disconnect();
    for (const el of held) {
      const t = el.getAttribute("data-tip");
      el.removeAttribute("data-tip");
      // A component may have set a fresh title meanwhile; that one wins.
      if (t !== null && !el.hasAttribute("title")) el.setAttribute("title", t);
    }
    held = [];
    target = null;
  };

  const enter = (el: Element | null) => {
    if (el === target) return;
    release();
    suppressed = false;
    if (!el) return;
    target = el;
    // Titles change under the pointer (Mark reviewed → Reviewed); keep the native one away.
    observer ??= new MutationObserver((records) => {
      for (const r of records) take(r.target as Element);
      if (!tip.hidden) show();
    });
    for (let n: Element | null = el; n; n = n.parentElement?.closest("[title],[data-tip]") ?? null) {
      held.push(n);
      take(n);
      observer.observe(n, { attributes: true, attributeFilter: ["title"] });
    }
    const warm = performance.now() - lastHidden < WARM;
    timer = window.setTimeout(show, warm ? WARM_DELAY : DELAY);
  };

  const hintOf = (n: EventTarget | null) => (n instanceof Element ? n.closest("[title],[data-tip]") : null);

  onMount(() => {
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = hintOf(e.target);
      if (suppressed && el === target) return;
      enter(el);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) enter(null);
    };
    const focus = (e: FocusEvent) => {
      const el = e.target instanceof Element && e.target.matches(":focus-visible") ? hintOf(e.target) : null;
      if (el) enter(el);
    };
    const blur = (e: FocusEvent) => {
      if (target && e.target instanceof Node && target.contains(e.target)) enter(null);
    };
    const dismiss = () => {
      hide();
      suppressed = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || !tip.hidden) dismiss();
    };

    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("blur", release);
    onCleanup(() => {
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("wheel", dismiss, { capture: true });
      window.removeEventListener("blur", release);
      release();
    });
  });

  return <div ref={tip} class="tooltip" role="tooltip" hidden />;
}
