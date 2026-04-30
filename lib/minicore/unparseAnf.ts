import type { Literal, SymbolId } from "./ast.ts";
import type {
  AnfAlt,
  AnfAtom,
  AnfExpr,
  AnfProgram,
  AnfValue,
} from "./anfAst.ts";

export function unparseAnfProgram(program: AnfProgram): string {
  return program.symbols
    .filter((symbol) => symbol.kind === "function")
    .map((symbol) => {
      const params = symbol.params.map(formatLocal).join(" ");
      const header =
        params.length === 0 ? `${symbol.name} =` : `${symbol.name} ${params} =`;
      return `${header}\n${indent(unparseAnfExpr(symbol.body, program), 2)}`;
    })
    .join("\n\n");
}

export function unparseAnfExpr(expr: AnfExpr, program?: AnfProgram): string {
  switch (expr.kind) {
    case "atom":
      return unparseAtom(expr.atom);
    case "let":
      return [
        `let ${formatLocal(expr.id)} = ${unparseAnfValue(expr.value, program)}`,
        "in",
        unparseAnfExpr(expr.body, program),
      ].join("\n");
    case "call":
    case "con":
    case "prim":
    case "case":
      return unparseAnfValue(expr, program);
  }
}

function unparseAnfValue(value: AnfValue, program?: AnfProgram): string {
  switch (value.kind) {
    case "atom":
      return unparseAtom(value.atom);
    case "call":
      return unparseApply(symbolName(value.target, program), value.args);
    case "con":
      return unparseApply(symbolName(value.target, program), value.fields);
    case "prim":
      return unparseApply(symbolName(value.target, program), value.args);
    case "case":
      return [
        `case ${unparseAtom(value.scrutinee)} of`,
        ...value.alts.map((alt) => indent(unparseAlt(alt, program), 2)),
      ].join("\n");
  }
}

function unparseAlt(alt: AnfAlt, program?: AnfProgram): string {
  const binders = alt.binders.map(formatLocal);
  const pattern = [symbolName(alt.constructor, program), ...binders].join(" ");
  return `${pattern} ->\n${indent(unparseAnfExpr(alt.body, program), 2)}`;
}

function unparseApply(name: string, atoms: AnfAtom[]): string {
  if (atoms.length === 0) {
    return name;
  }
  return `${name} ${atoms.map(unparseAtom).join(" ")}`;
}

function unparseAtom(atom: AnfAtom): string {
  switch (atom.kind) {
    case "var":
      return formatLocal(atom.id);
    case "lit":
      return unparseLiteral(atom.value);
  }
}

function unparseLiteral(literal: Literal): string {
  switch (literal.kind) {
    case "nat":
      return literal.value.toString();
    case "u8":
      return `${literal.value}u8`;
  }
}

function symbolName(id: SymbolId, program?: AnfProgram): string {
  return program?.symbols[id]?.name ?? `#${id}`;
}

function formatLocal(id: number): string {
  return `%${id}`;
}

function indent(input: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return input
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
