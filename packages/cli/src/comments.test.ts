import { describe, expect, test } from "bun:test";
import { onlyCommentsChanged, syntaxFor } from "./comments";

const ts = syntaxFor("a.ts")!;
const tsx = syntaxFor("a.tsx")!;
const py = syntaxFor("a.py")!;
const go = syntaxFor("a.go")!;
const css = syntaxFor("a.css")!;

describe("comments only", () => {
  test("removed line, trailing and doc comments", () => {
    const before = `/**\n * Docs.\n */\nexport function f(a: number) {\n  // why\n  return a + 1; // trailing\n}\n`;
    const after = `export function f(a: number) {\n  return a + 1;\n}\n`;
    expect(onlyCommentsChanged(before, after, ts)).toBe(true);
  });

  test("a block comment on the same line as code", () => {
    expect(onlyCommentsChanged(`} /* x */ import type { A } from 'a';\n`, `}\nimport type { A } from 'a';\n`, ts)).toBe(false);
    expect(onlyCommentsChanged(`*/ import type { A } from 'a';`.replace("*/", "/* x */"), `import type { A } from 'a';`, ts)).toBe(true);
  });

  test("a doc block ending on a code line", () => {
    expect(onlyCommentsChanged(`/**\n * Grid.\n */ import type { R } from 'react';\n`, `import type { R } from 'react';\n`, ts)).toBe(true);
  });

  test("an emptied catch", () => {
    expect(onlyCommentsChanged(`try { x() } catch {\n  // never mind\n}\n`, `try { x() } catch {\n}\n`, ts)).toBe(true);
  });

  test("an emptied catch on one line", () => {
    expect(onlyCommentsChanged(`try { x() } catch {\n  // never mind\n}\n`, `try { x() } catch {}\n`, ts)).toBe(true);
  });

  test("jsx comments", () => {
    const before = `return (\n  <View>\n    {/* The header. */}\n    <Header />\n    {/*\n      Two lines.\n    */}\n  </View>\n);\n`;
    const after = `return (\n  <View>\n    <Header />\n  </View>\n);\n`;
    expect(onlyCommentsChanged(before, after, tsx)).toBe(true);
  });

  test("jsx comments after closing and self-closing tags", () => {
    const before = `<A>\n  <B x={y} />\n  {/* a */}\n  </C>\n  {/* b */}\n  <D />\n</A>\n`;
    const after = `<A>\n  <B x={y} />\n  </C>\n  <D />\n</A>\n`;
    expect(onlyCommentsChanged(before, after, tsx)).toBe(true);
  });

  test("python", () => {
    expect(onlyCommentsChanged(`x = 1  # one\n# note\ny = 2\n`, `x = 1\ny = 2\n`, py)).toBe(true);
  });
});

describe("not comments only", () => {
  test("a code change next to a comment change", () => {
    expect(onlyCommentsChanged(`// a\nconst x = 1;\n`, `// b\nconst x = 2;\n`, ts)).toBe(false);
  });

  test("identical files", () => {
    expect(onlyCommentsChanged(`const x = 1;\n`, `const x = 1;\n`, ts)).toBe(false);
  });

  test("whitespace only", () => {
    expect(onlyCommentsChanged(`const x  = 1;\n`, `const x = 1;\n`, ts)).toBe(false);
  });

  test("comment markers inside strings are text", () => {
    expect(onlyCommentsChanged(`const u = "http://a";\n`, `const u = "http://b";\n`, ts)).toBe(false);
    expect(onlyCommentsChanged(`const u = 'a /* b */ c';\n`, `const u = 'a c';\n`, ts)).toBe(false);
    expect(onlyCommentsChanged("const t = `x // ${a} y`;\n", "const t = `x // ${a} z`;\n", ts)).toBe(false);
    expect(onlyCommentsChanged(`s = "a # b"\n`, `s = "a # c"\n`, py)).toBe(false);
  });

  test("nested templates stay in sync", () => {
    const before = "const t = `a${`b${c}`}d`; // note\nconst u = 'x // y';\n";
    const after = "const t = `a${`b${c}`}d`;\nconst u = 'x // z';\n";
    expect(onlyCommentsChanged(before, after, ts)).toBe(false);
  });

  test("a regex holding quotes or slashes", () => {
    expect(onlyCommentsChanged(`const r = /"/; f(1); // a\n`, `const r = /"/; f(2);\n`, ts)).toBe(false);
    expect(onlyCommentsChanged(`const r = /https?:\\/\\//; g(1);\n`, `const r = /https?:\\/\\//; g(2);\n`, ts)).toBe(false);
  });

  test("whitespace inside a string", () => {
    expect(onlyCommentsChanged(`// c\nconst s = "a  b";\n`, `const s = "a b";\n`, ts)).toBe(false);
  });

  test("python indentation", () => {
    expect(onlyCommentsChanged(`if a:\n    # c\n    b()\nc()\n`, `if a:\n    b()\n    c()\n`, py)).toBe(false);
  });

  test("python docstrings are code", () => {
    expect(onlyCommentsChanged(`def f():\n    """Old."""\n`, `def f():\n    """New."""\n`, py)).toBe(false);
  });

  test("a block comment holding a newline still ends the line", () => {
    expect(onlyCommentsChanged(`return /*\n*/ x;\n`, `return x;\n`, ts)).toBe(false);
  });

  test("go raw strings have no escapes", () => {
    expect(onlyCommentsChanged("p := `C:\\`\nq := 1 // a\n", "p := `C:\\`\nq := 2\n", go)).toBe(false);
  });

  test("css has no line comments", () => {
    expect(onlyCommentsChanged(`a { background: url(http://x/a.png); }\n`, `a { background: url(http://x/b.png); }\n`, css)).toBe(false);
  });

  test("braces holding a comment are only dropped as a jsx child", () => {
    expect(onlyCommentsChanged(`if (a) {/* x */}\nb();\n`, `if (a)\nb();\n`, tsx)).toBe(false);
    expect(onlyCommentsChanged(`const f = () => {/* x */}\nb();\n`, `const f = () =>\nb();\n`, tsx)).toBe(false);
    expect(onlyCommentsChanged(`<A>{/* x */}</A>`, `<A></A>`, ts)).toBe(false);
  });

  test("unknown languages are skipped", () => {
    expect(syntaxFor("a.rs")).toBeNull();
    expect(syntaxFor("Makefile")).toBeNull();
    expect(syntaxFor("a.sh")).toBeNull();
  });
});
