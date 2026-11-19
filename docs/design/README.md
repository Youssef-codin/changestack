# Viewer redesign: screens brief

Handoff for designing the viewer. What each screen holds is settled; what it looks like is not.

- **Screens guide:** https://claude.ai/artifact/9MM8NuutTRkAZxP5KaeWtN (source: `docs/design/screens.html`). It covers each screen's purpose, contents, data sources and a rough sketch, plus states, where flags show, and the merge verdict rules.
- The sketches are wireframes for content and placement, not visual design. Every visual choice is open.
- Current viewer: `packages/viewer/src/App.tsx` (Solid, virtualized diff) and `styles.css` (palette and tier colors).

## Flow

1. **Pick a PR:** stays a terminal prompt. Not a browser screen.
2. **Briefing:** opens first, at the top of the review.
   - **Layout locked: Open** (`docs/design/briefing-layouts.html#open`). Top bar, then the verdict as a full-width colored band (score, verdict, tier tags, sentence, meter), then the page itself with no cards: Check first on the left, a vertical rule, Resume review and What it builds on the right, thin rules between items.
   - Narrow widths: the band stacks (score above verdict), and the two columns become one in this order: Resume review, Check first, What it builds. Very wide: content caps at about 1200px while the band stays full width.
   - Merge verdict
   - "Check first" flags
   - Tier breakdown
   - Model picker with the source line
   - Start review
   - Submit in the top bar with the draft count, same as Review (opens the same drawer)
3. **Review:** the main screen.
   - **Layout picked: Margin** (`docs/design/review-layouts.html#margin`), still being polished. Notes (flags and drafts) sit in a margin column beside the code, lined up with their line by a small tick, so the code is never split. Hover a note to light its line. The notes column is titled "NOTES 4"; a small round handle sitting on the column separator folds it to round markers at each line. Folded, the handle moves to the right edge with a pink count badge. A flag with no line sits at the top of the margin as "whole file".
   - By feature groups files by feature, then by tier inside each feature (core first). Tier is shown as an icon in a tier-colored circle (core target, glue cable, tests flask, docs page, boilerplate box, generated gear), never color alone. Every group, tier subgroup, and the Flags and Your drafts lists can be collapsed.
   - Flags have one color per kind: risky red, deviation brown, untested teal, uncertain magenta. The color follows the flag everywhere (file list, pointer pill, flagged line, margin note). Pink stays for the verdict, the brand and the primary actions: Submit (filled), Mark reviewed (outlined pill with a pink icon, pink tint once reviewed), the active By tier / By feature switch, the + comment button, progress, and the current file and flag highlight.
   - Diff has one line-number column: the new line number, or the old one (faded) on removed lines. A flagged line is tinted in the flag's color and its number becomes a pill with the flag icon. Hovering a line shows a round pink + button at its right end to comment.
   - Flags can be resolved: Resolve on the margin note (or the check on its row in the Flags list) clears it. A resolved flag turns gray everywhere, its note shrinks to one struck-through line with Undo, and the Flags count reads "N open". "Reply as draft" turns a flag into a draft comment instead.
   - Implementation notes (from Chrome's modern-web-guidance skill): collapsible groups are native `<details>`/`<summary>` with the chevron before the label and a `::details-content` slide; file names truncate before the extension (`<span>name</span>.ts`), never cut in script. For theming, use `color-scheme: light dark` on `:root` and `light-dark()` tokens with a `prefers-color-scheme` fallback.
   - Surfaces: code sits on "paper" (white in light, #141417 in dark); the left column and the notes margin are a tinted side color, so the three columns read apart. With notes hidden the margin tint goes away and the markers sit on the code paper. Background behind the frame: **Glow** (picked): soft pink top-left, warm bottom-right radial gradients, no grain. The notes margin has a full-height 1px separator; the side columns are translucent so the glow shows through them and the top bar. Animations wait until implementation.
   - The file list is a tree: files hang off their tier (By tier), and tiers hang off their feature (By feature), with guide lines.
   - Open margin notes stack from the top of each file (each says its line; hover lights the line). Folded markers sit level with their line.
   - Left column: files on top (scrolls), then Flags and Your drafts as jump lists, then progress (one plain bar, reviewed files out of all) and the By tier / By feature switch pinned to the bottom.
   - Top bar: verdict chip, progress, Submit. No model picker here; the model is chosen on the Briefing.
   - File rail with a By tier / By feature switch
   - Ordered diff, with tier, why and flags per file, and inline drafts
4. **Submit:** a drawer from the right over the diff.
   - Drafts grouped by file, outdated drafts separate
   - Overall comment
   - Post review / Copy all as prompt
5. **Posted:**
   - Count of what was posted
   - View on GitHub
   - Copy as prompt

## Decided

- **Merge verdict.** Four levels: Read carefully, Read the core, Skim and merge, Instamerge. Shown alone as one plain sentence ("Likely fine to merge after a quick look"), never as a ladder with the other levels.
  - Worked out by fixed rules from checkable facts: flags, untested core, CI, the session's test runs, and rule overrides. Never by the model's opinion.
  - Shows its reasons as clickable chips.
  - Picked by the most important tier touched, not by how many files: core with a deviation, risky or untested flag is Read carefully; core without those is Read the core; glue at most is Skim and merge; only tests, docs, boilerplate, config or generated is Instamerge. Core is never Instamerge.
  - Led by a **merge score** out of 100 with an animated bar. The level picks the range (Read carefully 5 to 39, Read the core 40 to 69, Skim and merge 70 to 89, Instamerge 90 to 100), so core can never score into Instamerge. The size of the change picks the spot inside the range: size = core lines + glue/3 + tests/6 + docs/8 + boilerplate/10, generated free, on a log scale. #127 scores 10.
  - Tags under the verdict list what changed per tier ("4 core 277 lines", "4 flags").
  - Set once when the PR is classified. Reviewing doesn't change it.
  - **Reviewed** is separate: a checkmark that appears once every file that needs it is marked. No percentage read.
  - Never approves or merges.
- **Docs tier.** Six tiers now: core, glue, tests, docs, boilerplate, generated. Docs covers READMEs, markdown, changelogs and doc comments only changes. Needs adding to the classifier's tier list in `packages/cli`.
- **Tier colors** are a severity scale, not a ramp: core red, glue orange, tests yellow, docs blue, boilerplate green, generated gray; flags stay the colorway's spot color.
- **Sort by feature.** Files are grouped by what they build, with tier order inside each group.
  - A file serving two features shows under both, labelled with its symbol.
  - Files with no feature go in a last "Setup and other" group.
  - Same model call as today.
- **Model picker.** Haiku / Sonnet / Opus, in the briefing and the top bar.
  - Cached models switch instantly.
  - Uncached ones ask first ("Uses your Claude plan"), then reclassify in place.
  - Drafts and reviewed marks survive the switch.
- **Flags:**
  - All of them are listed in the briefing.
  - A dot on the file in the rail.
  - A line in the file header.
  - A marker at the flagged line in the diff. Placement order: the line the model gave, else the hunk for that function, else the file header only.
  - A flag still shows when its file is collapsed.
  - Never posted to GitHub.
- **Copy as prompt** appears in both Submit and Posted.
- **Colorways.** Riso is the main theme (default). Hazard becomes **Site**, a gimmick theme styled as a real construction site (road signs, barricade meter, clipboard), to be designed later. Scope stays as an option; its Mantis glow is the part worth keeping. Each in light and dark. Preview: `docs/design/colorways.html`; role tokens: `docs/design/colorways.css` (not yet updated for this).
  - No hard 90-degree boxes: round corners, pills and circles.
  - **Hazard** (becoming Site, dark first): concrete grays and black, hi-vis yellow flags with a striped edge, hi-vis orange for Read carefully.
  - **Riso** (light first): black ink on paper with fluoro pink as the one spot color; blue only on added lines.
  - **Scope** (dark first): neutral ink grays with Mantis green (`#8ee53f`) as the one spot color and a faint graticule behind the diff; blue only on added lines.
  - Screens use roles (flag, accent, four verdicts, added and removed, six tier colors, top bar), never raw colors.

## Open for the design phase

- **Showing a flag in the file.** The current sketch repeats the same note in the header and in an amber row a few lines below, which reads as a duplicate. Options:
  - The header shows only a count and line ("1 flag · line 14 ↓"), and the inline row carries the note.
  - A gutter marker that opens the note, instead of a full row.
  - An inline row only when the flag is far from the top of the file.
- Visual direction overall: type, density, how much the tier colors carry, light and dark.
- What each state from the guide's States table looks like: classifying, switching model, failed, no session, no CI, changed since, empty PR, post failed, CLI stopped.
- Narrow widths: rail vs diff, and the drawer.

## New data the design assumes

None of this exists yet:

- An optional `line` on each `Flag`.
- `features[{ name, why }]` on the annotation, and a `feature` on each `Section`.
- The first user prompt from the transcript, only for writing deviation notes (no "What you asked" block).
- CI status from `gh pr checks`, plus the session's test runs as structured data, for the verdict.
- `POST /api/classify { model }`, with `/api/review` listing which models are cached for this diff.
- The verdict rules, in a file next to `packages/cli/src/rules.ts`.
