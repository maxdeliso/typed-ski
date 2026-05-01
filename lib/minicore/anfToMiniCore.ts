import type { Expr, FunctionDef, Program, SymbolDef } from "./ast.ts";
import type {
  AnfAtom,
  AnfExpr,
  AnfFunctionDef,
  AnfProgram,
  AnfValue,
} from "./anfAst.ts";

export function anfToMiniCoreProgram(program: AnfProgram): Program {
  const symbols: SymbolDef[] = program.symbols.map((symbol) =>
    symbol.kind === "function" ? anfToMiniCoreFunction(symbol) : symbol,
  );
  return {
    symbols,
    entry: program.entry,
    symbolsByName: program.symbolsByName,
    metadata: program.metadata,
  };
}

export function anfToMiniCoreFunction(fn: AnfFunctionDef): FunctionDef {
  return {
    ...fn,
    body: anfToMiniCoreExpr(fn.body),
  };
}

export function anfToMiniCoreExpr(expr: AnfExpr): Expr {
  switch (expr.kind) {
    case "atom":
      return atomToMiniCore(expr.atom);
    case "let":
      return {
        kind: "let",
        bindings: [{ id: expr.id, value: valueToMiniCore(expr.value) }],
        body: anfToMiniCoreExpr(expr.body),
      };
    case "call":
    case "con":
    case "prim":
    case "runtimeCall":
    case "case":
      return valueToMiniCore(expr);
  }
}

function valueToMiniCore(value: AnfValue): Expr {
  switch (value.kind) {
    case "atom":
      return atomToMiniCore(value.atom);
    case "call":
      return {
        kind: "call",
        target: value.target,
        args: value.args.map(atomToMiniCore),
      };
    case "con":
      return {
        kind: "con",
        target: value.target,
        fields: value.fields.map(atomToMiniCore),
      };
    case "prim":
      return {
        kind: "prim",
        target: value.target,
        args: value.args.map(atomToMiniCore),
      };
    case "runtimeCall":
      return {
        kind: "runtimeCall",
        name: value.name,
        args: value.args.map(atomToMiniCore),
      };
    case "case":
      return {
        kind: "case",
        scrutinee: atomToMiniCore(value.scrutinee),
        alts: value.alts.map((alt) => ({
          constructor: alt.constructor,
          binders: alt.binders,
          body: anfToMiniCoreExpr(alt.body),
        })),
      };
  }
}

function atomToMiniCore(atom: AnfAtom): Expr {
  switch (atom.kind) {
    case "var":
      return { kind: "var", id: atom.id };
    case "lit":
      return { kind: "lit", value: atom.value };
  }
}
