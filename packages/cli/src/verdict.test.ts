import { describe, expect, test } from "bun:test";
import type { Flag, Section, Tier } from "@changestack/schema";
import type { FileDiff } from "./git";
import { resolveFlagLines } from "./lines";
import { changedLines, computeVerdict } from "./verdict";

/** A file diff with `adds` added lines in one hunk. */
const diffOf = (file: string, adds: number): FileDiff => ({
  file,
  status: "modified",
  text: [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${adds} @@`, ...Array.from({ length: adds }, (_, i) => `+line ${i}`)].join("\n"),
});
const sec = (file: string, tier: Tier): Section => ({ file, symbol: null, tier, why: "", feature: null });
const flag = (file: string, kind: Flag["kind"]): Flag => ({ file, symbol: null, kind, note: "", line: null });

describe("computeVerdict", () => {
  // Line counts from the lustre-clinic #127 mockup: 277 core, 72 glue, 129 tests, 24 docs, 31 boilerplate, 191 generated.
  const files = [diffOf("core.ts", 277), diffOf("glue.ts", 72), diffOf("a.test.ts", 129), diffOf("README.md", 24), diffOf("index.ts", 31), diffOf("bun.lock", 191)];
  const sections = [sec("core.ts", "core"), sec("glue.ts", "glue"), sec("a.test.ts", "tests"), sec("README.md", "docs"), sec("index.ts", "boilerplate"), sec("bun.lock", "generated")];

  test("core with a deviation is careful, and the #127 mockup scores 10", () => {
    expect(computeVerdict(sections, [flag("core.ts", "deviation")], files, [])).toEqual({ level: "careful", score: 10 });
  });

  test("core without serious flags reads the core", () => {
    expect(computeVerdict(sections, [flag("core.ts", "uncertain")], files, []).level).toBe("core");
  });

  test("a serious flag on a non-core file does not make it careful", () => {
    expect(computeVerdict(sections, [flag("glue.ts", "risky")], files, []).level).toBe("core");
  });

  test("glue at most is skim; tests and docs only is instamerge", () => {
    expect(computeVerdict([sec("glue.ts", "glue")], [], [diffOf("glue.ts", 5)], []).level).toBe("skim");
    const v = computeVerdict([sec("a.test.ts", "tests"), sec("README.md", "docs")], [], [diffOf("a.test.ts", 3), diffOf("README.md", 3)], []);
    expect(v.level).toBe("merge");
    expect(v.score).toBeGreaterThanOrEqual(90);
  });

  test("config forced to glue by the rule still counts as instamerge", () => {
    const overrides = [{ file: "config/app.json", from: "boilerplate" as const, to: "glue" as const, rule: "config" }];
    expect(computeVerdict([sec("config/app.json", "glue")], [], [diffOf("config/app.json", 4)], overrides).level).toBe("merge");
  });

  test("bigger changes score lower inside the same range", () => {
    const small = computeVerdict([sec("c.ts", "core")], [], [diffOf("c.ts", 5)], []);
    const big = computeVerdict([sec("c.ts", "core")], [], [diffOf("c.ts", 900)], []);
    expect(small.score).toBeGreaterThan(big.score);
    expect(big.score).toBeGreaterThanOrEqual(40);
  });

  test("changedLines ignores the --- and +++ headers", () => {
    expect(changedLines(diffOf("x.ts", 7).text)).toBe(7);
  });
});

describe("resolveFlagLines", () => {
  const file: FileDiff = {
    file: "confirm.ts",
    status: "modified",
    text: [
      "diff --git a/confirm.ts b/confirm.ts",
      "--- a/confirm.ts",
      "+++ b/confirm.ts",
      "@@ -11,4 +11,5 @@ export async function confirmAppointment",
      " export async function confirmAppointment(req: Request) {",
      "-  const token = verifyToken(req.query.t)",
      "+  const id = Number(req.query.id)",
      "+  if (!id) return notFound()",
      "   return ok()",
      " }",
    ].join("\n"),
  };
  const draft = (quote: string | null) => ({ file: "confirm.ts", symbol: null, kind: "deviation" as const, note: "", quote });

  test("finds the new-file line of an added line, ignoring indentation", () => {
    expect(resolveFlagLines([draft("const id = Number(req.query.id)")], [file])[0]!.line).toBe(12);
  });

  test("context lines count too; deleted lines never match", () => {
    expect(resolveFlagLines([draft("return ok()")], [file])[0]!.line).toBe(14);
    expect(resolveFlagLines([draft("const token = verifyToken(req.query.t)")], [file])[0]!.line).toBeNull();
  });

  test("no quote, an unknown file or an ambiguous quote leaves the flag on the whole file", () => {
    expect(resolveFlagLines([draft(null)], [file])[0]!.line).toBeNull();
    expect(resolveFlagLines([{ ...draft("}"), file: "other.ts" }], [file])[0]!.line).toBeNull();
    const twice: FileDiff = { ...file, text: `${file.text}\n+}\n` };
    expect(resolveFlagLines([draft("}")], [twice])[0]!.line).toBeNull();
  });

  test("drops the quote from the served flag", () => {
    expect(resolveFlagLines([draft(null)], [file])[0]).not.toHaveProperty("quote");
  });
});
