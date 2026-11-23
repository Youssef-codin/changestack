import type { SyntaxNodeRef, Tree } from "@lezer/common";
import type { DiffLine } from "./diff";
import { KEYWORDS, LITERALS } from "./highlight";
import { declOf } from "./outline";

/**
 * Go to definition inside the PR. Definitions come from the same Lezer parse that folding uses
 * (syntaxFolds.ts), so they cover every changed file whose language has a grammar; files without
 * one fall back to the outline's declaration patterns. Only code in the diff is known: a name
 * defined outside the hunks has no definition here.
 */

export interface Def {
  name: string;
  /** "func", "type", "field", "param" or "var", for the peek list. */
  kind: string;
  file: string;
  /** Index of the defining line in the file's diff lines, and the name's column in it. */
  index: number;
  col: number;
  /** Which side's parse found it: "old" only for names on removed lines. */
  side: "old" | "new";
  /** Line indexes [start, end] of the function a local (parameter, inner variable) belongs to. */
  scope: [number, number] | null;
  /** Bound by destructuring (`const { a } = x`): a definition only within its own file. */
  pattern?: boolean;
}

/** A definition-name node, by node type: the parents it must sit under (any, when omitted). */
const NAMES: Record<string, RegExp | undefined> = {
  // JS / TS
  VariableDefinition: undefined,
  TypeDefinition: undefined,
  PropertyDefinition: /^(MethodDeclaration|PropertyDeclaration|PropertyType)$/,
  // Go
  DefName: /^(?!PackageClause$|ImportSpec$)/,
  FieldName: /^(MethodDecl|FieldDecl|MethodElem)$/,
  // Python (the first name under a def/class, assignment targets, parameters)
  VariableName: /^(ClassDefinition|FunctionDefinition|ParamList|AssignStatement)$/,
  // Rust
  BoundIdentifier: undefined,
  TypeIdentifier: /^(StructItem|EnumItem|TraitItem|TypeItem|UnionItem|StructSpecifier|ClassSpecifier|UnionSpecifier|EnumSpecifier|TypeDefinition|AliasDeclaration)$/,
  FieldIdentifier: /^(FieldDeclaration|FunctionDeclarator)$/,
  // Java
  Definition: undefined,
  // C / C++, and Rust enum variants
  Identifier: /^(FunctionDeclarator|InitDeclarator|ParameterDeclaration|EnumVariant|ScopedIdentifier)$/,
};

/** Nodes that own a body: names inside their parameters or body are locals. */
const FUNC = /^(FunctionDeclaration|FunctionExpression|ArrowFunction|MethodDeclaration|ConstructorDeclaration|FunctionDecl|MethodDecl|FuncLiteral|FunctionDefinition|LambdaExpression|FunctionItem|ClosureExpression|FunctionDeclarator)$/;
const BODY = /^(Block|Body|ParamList|Parameters|ParameterList|FormalParameters|CompoundStatement|ClosureParamList)$/;

const KINDS: [RegExp, string][] = [
  [/Param/, "param"],
  [/Method|Func|Function|Lambda|Closure|Arrow/, "func"],
  [/Field|Property/, "field"],
  [/Class|Struct|Interface|Trait|Enum|Type|Union|Alias/, "type"],
];
/** Nodes between a name and the declaration that says what it is. */
const WRAP = /^(VarSpec|ConstSpec|TypeSpec|Parameter|VariableDeclarator|InitDeclarator|FunctionDeclarator|ScopedIdentifier)$/;

const PATTERN = /^(ObjectPattern|ArrayPattern|TuplePattern|StructPattern|TupleExpression)$/;
function inPattern(node: SyntaxNodeRef): boolean {
  for (let p = node.node.parent, i = 0; p && i < 4; p = p.parent, i++) if (PATTERN.test(p.name)) return true;
  return false;
}

function kindOf(node: SyntaxNodeRef): string {
  if (inPattern(node)) return "var";
  let p = node.node.parent;
  for (let i = 0; p && i < 3; p = p.parent, i++) {
    for (const [re, kind] of KINDS) if (re.test(p.name)) return kind;
    if (!WRAP.test(p.name)) break;
  }
  return "var";
}

function isDefName(node: SyntaxNodeRef): boolean {
  if (!(node.name in NAMES)) return false;
  const parent = node.node.parent;
  if (!parent) return false;
  for (let p: typeof parent | null = parent; p; p = p.parent) if (/^Import/.test(p.name)) return false;
  const want = NAMES[node.name];
  if (want && !want.test(parent.name)) return false;
  // Python: only a def/class's own name (its first name child), and only assignment targets.
  if (node.name === "VariableName" && parent.name !== "ParamList") {
    let prev = node.node.prevSibling;
    while (prev && prev.name !== "VariableName" && prev.name !== "AssignOp") prev = prev.prevSibling;
    if (prev) return false;
  }
  // `void C::m()`: the method name, not the class qualifier.
  if (parent.name === "ScopedIdentifier" && (parent.parent?.name !== "FunctionDeclarator" || node.node.nextSibling)) return false;
  // Rust / C type names: the first one under the item is its name.
  if (node.name === "TypeIdentifier" && parent.getChild("TypeIdentifier")?.from !== node.from) return false;
  return true;
}

/** The function a name is local to: one whose parameters or body hold it. */
function scopeOf(node: SyntaxNodeRef): { from: number; to: number } | null {
  // `q => q`: an arrow's lone parameter sits right under it.
  const up = node.node.parent;
  if (up?.name === "ArrowFunction") return { from: up.from, to: up.to };
  for (let p = node.node.parent; p?.parent; p = p.parent) {
    if (BODY.test(p.name) && FUNC.test(p.parent.name)) {
      const fn = p.parent.name === "FunctionDeclarator" && p.parent.parent ? p.parent.parent : p.parent;
      return { from: fn.from, to: fn.to };
    }
  }
  return null;
}

/** One parsed stretch of a file: its tree and how to map positions back to diff lines. */
export interface ParsedHunk {
  tree: Tree;
  text: string;
  /** The `lines` index of each line in the parsed text. */
  idx: number[];
  lineOf(pos: number): number;
  starts: number[];
}

/** Definitions in one parsed stretch. */
export function defsIn(file: string, h: ParsedHunk, side: "old" | "new", lines: DiffLine[]): Def[] {
  const out: Def[] = [];
  h.tree.iterate({
    enter(node) {
      if (node.type.isError || !isDefName(node)) return;
      const at = h.lineOf(node.from);
      const index = h.idx[at]!;
      // The old side's parse only adds names on removed lines; the rest the new side has.
      if (side === "old" && lines[index]!.kind !== "del") return;
      const name = h.text.slice(node.from, node.to);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
      const sc = scopeOf(node);
      out.push({
        name,
        kind: kindOf(node),
        file,
        index,
        col: node.from - h.starts[at]!,
        side,
        scope: sc ? [h.idx[h.lineOf(sc.from)]!, h.idx[h.lineOf(Math.max(sc.from, sc.to - 1))]!] : null,
        ...(inPattern(node) ? { pattern: true } : {}),
      });
    },
  });
  return out;
}

/** For files without a grammar: the declarations the outline's patterns recognise. */
export function guessDefs(file: string, lines: DiffLine[]): Def[] {
  const out: Def[] = [];
  lines.forEach((l, index) => {
    if (l.kind === "hunk") return;
    const d = declOf(l.text);
    if (!d || d.kind === "test" || d.kind === "import" || !/^[A-Za-z_$][\w$]*$/.test(d.name)) return;
    const col = l.text.search(new RegExp(`(?<![\\w$])${d.name.replace(/\$/g, "\\$")}(?![\\w$])`));
    if (col < 0) return;
    out.push({ name: d.name, kind: d.kind === "method" || d.kind === "def" || d.kind === "fn" ? "func" : d.kind, file, index, col, side: l.kind === "del" ? "old" : "new", scope: null });
  });
  return out;
}

/** Every definition in the PR, by name. */
export function indexDefs(byFile: Map<string, Def[]>): Map<string, Def[]> {
  const m = new Map<string, Def[]>();
  for (const defs of byFile.values()) {
    for (const d of defs) {
      const list = m.get(d.name);
      if (list) list.push(d);
      else m.set(d.name, [d]);
    }
  }
  return m;
}

const IDENT = /[\w$]/;

/** The identifier at column `col` of `text`, if any, with where it starts. */
export function wordAt(text: string, col: number): { name: string; col: number } | null {
  let a = col;
  let b = col;
  if (!IDENT.test(text[a] ?? "") && IDENT.test(text[a - 1] ?? "")) a = b = col - 1;
  if (!IDENT.test(text[a] ?? "")) return null;
  while (a > 0 && IDENT.test(text[a - 1]!)) a--;
  while (b < text.length && IDENT.test(text[b]!)) b++;
  const name = text.slice(a, b);
  if (!/^[A-Za-z_$]/.test(name) || KEYWORDS.has(name) || LITERALS.has(name)) return null;
  return { name, col: a };
}

/** Where a click on `name` at (file, index, col) leads. */
export type Resolution =
  | { kind: "self"; def: Def }
  | { kind: "defs"; defs: Def[] }
  | { kind: "none" };

/**
 * The definitions a name at a spot refers to. A local in scope wins outright; otherwise every
 * non-local definition of the name in the PR, this file's first. Definitions on the clicked
 * line's own side come first: a removed line's names look for removed definitions.
 */
export function resolve(index: Map<string, Def[]>, name: string, file: string, at: number, col: number, side: "old" | "new", order: string[]): Resolution {
  const all = index.get(name) ?? [];
  const self = all.find((d) => d.file === file && d.index === at && d.col === col);
  if (self) return { kind: "self", def: self };
  const sameSide = (list: Def[]) => {
    const mine = list.filter((d) => d.side === side);
    return mine.length ? mine : list;
  };
  // Locals: the innermost scope holding the click; within it, the nearest one before it.
  const locals = sameSide(all.filter((d) => d.scope && d.file === file && d.scope[0] <= at && at <= d.scope[1]));
  if (locals.length) {
    const width = (d: Def) => d.scope![1] - d.scope![0];
    const best = [...locals].sort((a, b) => width(a) - width(b) || +(b.index <= at) - +(a.index <= at) || Math.abs(a.index - at) - Math.abs(b.index - at))[0]!;
    return { kind: "defs", defs: [best] };
  }
  const globals = sameSide(all.filter((d) => !d.scope && (!d.pattern || d.file === file)));
  if (!globals.length) return { kind: "none" };
  const rank = (d: Def) => (d.file === file ? -1 : order.indexOf(d.file));
  return { kind: "defs", defs: [...globals].sort((a, b) => rank(a) - rank(b) || a.index - b.index) };
}

export interface Ref {
  file: string;
  index: number;
  col: number;
}

/** Where `name` appears as a whole word in the PR's diff lines, skipping comment lines. */
export function referencesOf(files: { file: string; lines: DiffLine[]; comment: string }[], name: string, cap = 200): Ref[] {
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  const out: Ref[] = [];
  for (const f of files) {
    for (let i = 0; i < f.lines.length; i++) {
      const l = f.lines[i]!;
      if (l.kind === "hunk") continue;
      const t = l.text.trimStart();
      if (f.comment && t.startsWith(f.comment)) continue;
      re.lastIndex = 0;
      const m = re.exec(l.text);
      if (!m) continue;
      out.push({ file: f.file, index: i, col: m.index });
      if (out.length >= cap) return out;
    }
  }
  return out;
}
