import { For, type JSX } from "solid-js";

/**
 * Just enough markdown for a review comment's prose: paragraphs, fenced code, `code` and
 * **bold**. Built from text nodes, never innerHTML: the text comes from GitHub.
 */
export function Prose(props: { text: string; class?: string }) {
  const blocks = () => {
    const out: { code: boolean; text: string }[] = [];
    const parts = props.text.split(/^```[^\n]*\n?/m);
    // Fences alternate: even parts are prose, odd parts are code.
    parts.forEach((part, i) => {
      if (i % 2) out.push({ code: true, text: part.replace(/\n$/, "") });
      else for (const p of part.split(/\n\s*\n/)) if (p.trim()) out.push({ code: false, text: p.trim() });
    });
    return out;
  };
  return (
    <div class={props.class}>
      <For each={blocks()}>
        {(b) =>
          b.code ? (
            <pre class="my-1.5 overflow-x-auto rounded-md bg-hov px-2 py-1 font-mono text-xs leading-5">{b.text}</pre>
          ) : (
            <p class="m-0 whitespace-pre-line [&+&]:mt-1.5">{inline(b.text)}</p>
          )
        }
      </For>
    </div>
  );
}

function inline(text: string): JSX.Element[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((t) =>
    t.startsWith("`") && t.endsWith("`") && t.length > 2 ? (
      <code class="rounded bg-hov px-1 font-mono text-[0.9em] text-tx">{t.slice(1, -1)}</code>
    ) : t.startsWith("**") && t.endsWith("**") && t.length > 4 ? (
      <b class="font-semibold text-tx">{t.slice(2, -2)}</b>
    ) : (
      (t as unknown as JSX.Element)
    ),
  );
}
