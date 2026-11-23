import type { Annotation, Flag, ReviewPayload, Tier, VerdictLevel } from "@changestack/schema";
import { TIER_ORDER } from "@changestack/schema/tiers";
import { type DiffLine, type ParsedFile, parseDiff } from "./diff";
import { anchorOf } from "./drafts";
import { foldRegions, type Region } from "./folds";
import { commentPrefix } from "./highlight";
import type { IconName } from "./icons";

export const TIER_ICON: Record<Tier, IconName> = {
  core: "adjust",
  glue: "cable",
  tests: "science",
  docs: "description",
  boilerplate: "inventory_2",
  generated: "settings",
};

export const FLAG_ICON: Record<Flag["kind"], IconName> = {
  deviation: "alt_route",
  untested: "science_off",
  risky: "bolt",
  uncertain: "help",
};

export const tierColor = (t: Tier) => `var(--color-${t})`;
export const flagColor = (k: Flag["kind"]) => `var(--color-${k})`;

/** Tiers whose files start collapsed: nothing in them changes behavior. */
export const COLLAPSED_BY_DEFAULT: readonly Tier[] = ["boilerplate", "generated"];

/** The group for files that serve no single feature. */
export const OTHER = "Setup and other";

/** A flag as the viewer tracks it. `placed` is false when its line isn't in the diff, so it sits at the top of the file. */
export interface FlagItem extends Flag {
  id: string;
  placed: boolean;
}

export interface ReviewFile extends ParsedFile {
  tier: Tier;
  whys: { symbol: string | null; why: string }[];
  /** Feature names this file builds, in annotation order; empty means "Setup and other". */
  features: string[];
  flags: FlagItem[];
  /** Rule that forced the tier up, if any. */
  overridden: string | null;
  /** Set when the annotation doesn't cover this file. */
  unclassified: string | null;
  name: string;
  dir: string;
  /** The name, plus as much of its folder as it takes to tell it from other files with the same name. */
  label: string;
  /** Foldable blocks (functions, if bodies, …) found in this file's diff. */
  regions: Region[];
}

export interface Model {
  files: ReviewFile[];
  /** Every flag, including ones about the whole PR (file null), in annotation order. */
  flags: FlagItem[];
  features: { name: string; why: string }[];
}

const rank = (t: Tier) => TIER_ORDER.indexOf(t);

/** Join the raw diff with the annotation: tiers, whys, features and flags per file, sorted by tier. */
export function buildModel(payload: ReviewPayload): Model {
  const parsed = parseDiff(payload.diff);
  const ann: Annotation | null = payload.annotation;
  const byFile = new Map(parsed.map((f) => [f.file, f]));

  const order: string[] = [];
  const meta = new Map<string, { tier: Tier; whys: ReviewFile["whys"]; features: string[] }>();
  for (const s of ann?.sections ?? []) {
    if (!byFile.has(s.file)) continue;
    let m = meta.get(s.file);
    if (!m) {
      m = { tier: s.tier, whys: [], features: [] };
      meta.set(s.file, m);
      order.push(s.file);
    } else if (rank(s.tier) < rank(m.tier)) {
      m.tier = s.tier;
    }
    m.whys.push({ symbol: s.symbol, why: s.why });
    if (s.feature && !m.features.includes(s.feature)) m.features.push(s.feature);
  }

  const flags: FlagItem[] = (ann?.flags ?? []).map((f, i) => {
    const file = f.file ? byFile.get(f.file) : undefined;
    const placed = !!file && f.line !== null && file.lines.some((l) => l.newNo === f.line && l.kind !== "del");
    return { ...f, id: String(i), placed };
  });

  const unclassified = ann ? "Changed after classification" : null;
  const files = [...order, ...parsed.map((f) => f.file).filter((f) => !meta.has(f))].map((name): ReviewFile => {
    const m = meta.get(name);
    const slash = name.lastIndexOf("/");
    return {
      ...byFile.get(name)!,
      tier: m?.tier ?? "glue",
      whys: m?.whys ?? [],
      features: m?.features ?? [],
      flags: flags.filter((f) => f.file === name),
      overridden: ann?.overrides.find((o) => o.file === name)?.rule ?? null,
      unclassified: m ? null : unclassified,
      name: name.slice(slash + 1),
      dir: slash === -1 ? "" : name.slice(0, slash + 1),
      label: name.slice(slash + 1),
      regions: foldRegions(byFile.get(name)!.lines, commentPrefix(name)),
    };
  });
  labelDuplicates(files);
  // Stable sort keeps the classifier's reading order within each tier.
  files.sort((a, b) => rank(a.tier) - rank(b.tier));

  const features = [...(ann?.features ?? [])];
  for (const f of files) for (const name of f.features) if (!features.some((x) => x.name === name)) features.push({ name, why: "" });
  return { files, flags, features };
}

/** Go and friends have many `service.go`s: prefix each clashing name with folders until it's unique. */
function labelDuplicates(files: ReviewFile[]): void {
  for (let depth = 1; depth < 8; depth++) {
    const count = new Map<string, number>();
    for (const f of files) count.set(f.label, (count.get(f.label) ?? 0) + 1);
    const clashing = files.filter((f) => count.get(f.label)! > 1);
    if (!clashing.length) return;
    for (const f of clashing) f.label = f.file.split("/").slice(-depth - 1).join("/");
  }
}

export interface Group {
  key: string;
  name: string;
  why: string;
  files: ReviewFile[];
}

/** Files by feature, in feature order, tier order inside; a file serving two features is in both. */
export function featureGroups(m: Model): Group[] {
  const groups: Group[] = m.features.map((f) => ({ key: `f:${f.name}`, name: f.name, why: f.why, files: m.files.filter((x) => x.features.includes(f.name)) }));
  const other = m.files.filter((x) => x.features.length === 0);
  if (other.length) groups.push({ key: "f:", name: OTHER, why: "Setup and plumbing that serves no single feature.", files: other });
  return groups.filter((g) => g.files.length);
}

export function tierGroups(files: ReviewFile[]): { tier: Tier; files: ReviewFile[] }[] {
  return TIER_ORDER.map((tier) => ({ tier, files: files.filter((f) => f.tier === tier) })).filter((g) => g.files.length);
}

/** Reading order for the diff: by tier, or by feature (each file once, at its first feature). */
export function readingOrder(m: Model, by: "tier" | "feature"): ReviewFile[] {
  if (by === "tier") return m.files;
  const seen = new Set<ReviewFile>();
  for (const g of featureGroups(m)) for (const f of g.files) seen.add(f);
  return [...seen];
}

export function tierStats(files: ReviewFile[]): { tier: Tier; files: number; lines: number }[] {
  return tierGroups(files).map((g) => ({
    tier: g.tier,
    files: g.files.length,
    lines: g.files.reduce((n, f) => n + f.additions + f.deletions, 0),
  }));
}

export const VERDICT: Record<VerdictLevel, { name: string; icon: IconName }> = {
  careful: { name: "Read carefully", icon: "visibility-fill" },
  core: { name: "Read the core", icon: "adjust" },
  skim: { name: "Skim and merge", icon: "speed" },
  merge: { name: "Instamerge", icon: "done_all" },
};

/** The verdict's one plain sentence. */
export function verdictLine(level: VerdictLevel, m: Model): string {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  switch (level) {
    case "careful": {
      const n = m.flags.length;
      return `Don't merge this on a skim. ${n} ${plural(n, "thing", "things")} below ${plural(n, "needs", "need")} a real read first.`;
    }
    case "core": {
      const n = m.files.filter((f) => f.tier === "core").length;
      return `Core logic changed. Read the ${n} core ${plural(n, "file", "files")}; the rest can be skimmed.`;
    }
    case "skim":
      return "Likely fine to merge after a quick look.";
    case "merge":
      return "Nothing here changes behavior. Fine to merge.";
  }
}

/** Where Start/Resume review lands: the first unreviewed file, at its first open flag line. */
export function resumeTarget(order: ReviewFile[], reviewed: Set<string>, resolved: Set<string>) {
  const file = order.find((f) => !reviewed.has(f.file));
  if (!file) return null;
  const flag = file.flags.find((f) => f.placed && !resolved.has(f.id));
  return { file, line: flag?.line ?? null };
}

/** Rows of a file's diff that can carry a note, keyed by side and line. Each row is LINE_H tall. */
export function rowIndex(lines: DiffLine[]): Map<string, number> {
  const m = new Map<string, number>();
  lines.forEach((l, i) => {
    const a = anchorOf(l);
    if (a) m.set(`${a.side}:${a.line}`, i);
  });
  return m;
}

export const LINE_H = 24;

/** "x minutes ago" for the source line. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Read and write per-viewer conveniences; storage can be missing or blocked. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-viewer convenience only
  }
}
