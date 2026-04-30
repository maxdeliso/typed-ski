import type { LocalId, SymbolId } from "./ast.ts";
import type {
  AnfAlt,
  AnfAtom,
  AnfExpr,
  AnfFunctionDef,
  AnfProgram,
  AnfValue,
} from "./anfAst.ts";

export class MiniCoreAnfValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniCoreAnfValidationError";
  }
}

export function validateAnfModule(program: AnfProgram): void {
  validateSymbols(program);
}

export function validateAnfExecutable(program: AnfProgram): void {
  validateAnfModule(program);

  const entrySymbol = program.symbols[program.entry];
  if (entrySymbol === undefined) {
    throw new MiniCoreAnfValidationError(
      `Entry symbol ${program.entry} not found`,
    );
  }
  if (entrySymbol.kind !== "function") {
    throw new MiniCoreAnfValidationError(
      `Entry symbol ${entrySymbol.name} must be a function`,
    );
  }
  if (entrySymbol.arity !== 0) {
    throw new MiniCoreAnfValidationError(
      `Entry function ${entrySymbol.name} must have arity 0`,
    );
  }
}

export function validateAnfProgram(program: AnfProgram): void {
  validateAnfExecutable(program);
}

function validateSymbols(program: AnfProgram): void {
  for (let i = 0; i < program.symbols.length; i++) {
    const symbol = program.symbols[i]!;
    if (symbol.id !== i) {
      throw new MiniCoreAnfValidationError(
        `Symbol ${symbol.name} ID mismatch: expected ${i}, got ${symbol.id}`,
      );
    }
    const namedId = program.symbolsByName.get(symbol.name);
    if (namedId === undefined) {
      throw new MiniCoreAnfValidationError(
        `Symbol ${symbol.name} missing from symbolsByName`,
      );
    }
    if (namedId !== i) {
      throw new MiniCoreAnfValidationError(
        `symbolsByName mismatch for ${symbol.name}: expected ${i}, got ${namedId}`,
      );
    }

    if (symbol.kind === "function") {
      validateFunction(symbol, program);
    } else if (symbol.kind === "primitive") {
      if (symbol.strict.length !== symbol.arity) {
        throw new MiniCoreAnfValidationError(
          `Primitive ${symbol.name} arity/strictness mismatch`,
        );
      }
    } else if (symbol.kind === "constructor" && symbol.arity < 0) {
      throw new MiniCoreAnfValidationError(
        `Constructor ${symbol.name} has negative arity`,
      );
    }
  }
}

function validateFunction(fn: AnfFunctionDef, program: AnfProgram): void {
  if (fn.arity < 0) {
    throw new MiniCoreAnfValidationError(
      `Function ${fn.name} has negative arity`,
    );
  }
  if (fn.arity !== fn.params.length) {
    throw new MiniCoreAnfValidationError(
      `Function ${fn.name} arity ${fn.arity} does not match params length ${fn.params.length}`,
    );
  }

  const uniqueParams = new Set(fn.params);
  if (uniqueParams.size !== fn.params.length) {
    throw new MiniCoreAnfValidationError(
      `Function ${fn.name} has duplicate parameters`,
    );
  }

  validateExpr(fn.body, uniqueParams, program, fn.name);
}

function validateExpr(
  expr: AnfExpr,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  context: string,
): void {
  switch (expr.kind) {
    case "atom":
      validateAtom(expr.atom, boundLocals, context);
      break;
    case "call":
    case "con":
    case "prim":
    case "case":
      validateValue(expr, boundLocals, program, context);
      break;
    case "let": {
      validateValue(expr.value, boundLocals, program, context);
      if (boundLocals.has(expr.id)) {
        throw new MiniCoreAnfValidationError(
          `Local variable ${expr.id} is rebound in ${context}`,
        );
      }
      const nextLocals = new Set(boundLocals);
      nextLocals.add(expr.id);
      validateExpr(expr.body, nextLocals, program, context);
      break;
    }
  }
}

function validateValue(
  value: AnfValue,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  context: string,
): void {
  switch (value.kind) {
    case "atom":
      validateAtom(value.atom, boundLocals, context);
      break;
    case "call": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "function") {
        throw new MiniCoreAnfValidationError(
          `Call target ${value.target} in ${context} is not a function`,
        );
      }
      if (value.args.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Call to ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${value.args.length}`,
        );
      }
      validateAtoms(value.args, boundLocals, context);
      break;
    }
    case "con": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "constructor") {
        throw new MiniCoreAnfValidationError(
          `Constructor target ${value.target} in ${context} is not a constructor`,
        );
      }
      if (value.fields.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Constructor ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${value.fields.length}`,
        );
      }
      validateAtoms(value.fields, boundLocals, context);
      break;
    }
    case "prim": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "primitive") {
        throw new MiniCoreAnfValidationError(
          `Primitive target ${value.target} in ${context} is not a primitive`,
        );
      }
      if (value.args.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Primitive ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${value.args.length}`,
        );
      }
      validateAtoms(value.args, boundLocals, context);
      break;
    }
    case "case": {
      validateAtom(value.scrutinee, boundLocals, context);
      const constructors = new Set<SymbolId>();
      for (const alt of value.alts) {
        if (constructors.has(alt.constructor)) {
          const name =
            program.symbols[alt.constructor]?.name ?? String(alt.constructor);
          throw new MiniCoreAnfValidationError(
            `Duplicate constructor ${name} in case expression in ${context}`,
          );
        }
        constructors.add(alt.constructor);
        validateAlt(alt, boundLocals, program, context);
      }
      break;
    }
  }
}

function validateAlt(
  alt: AnfAlt,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  context: string,
): void {
  const target = program.symbols[alt.constructor];
  if (!target || target.kind !== "constructor") {
    throw new MiniCoreAnfValidationError(
      `Case alternative constructor ${alt.constructor} in ${context} is not a constructor`,
    );
  }
  if (alt.binders.length !== target.arity) {
    throw new MiniCoreAnfValidationError(
      `Case alternative for ${target.name} in ${context} has wrong binder count: expected ${target.arity}, got ${alt.binders.length}`,
    );
  }
  const uniqueBinders = new Set(alt.binders);
  if (uniqueBinders.size !== alt.binders.length) {
    throw new MiniCoreAnfValidationError(
      `Case alternative for ${target.name} in ${context} has duplicate binders`,
    );
  }

  const nextLocals = new Set(boundLocals);
  for (const binder of alt.binders) {
    if (nextLocals.has(binder)) {
      throw new MiniCoreAnfValidationError(
        `Case alternative for ${target.name} in ${context} rebinds local ${binder}`,
      );
    }
    nextLocals.add(binder);
  }
  validateExpr(alt.body, nextLocals, program, context);
}

function validateAtom(
  atom: AnfAtom,
  boundLocals: Set<LocalId>,
  context: string,
): void {
  if (atom.kind === "var" && !boundLocals.has(atom.id)) {
    throw new MiniCoreAnfValidationError(
      `Local variable ${atom.id} is unbound in ${context}`,
    );
  }
}

function validateAtoms(
  atoms: AnfAtom[],
  boundLocals: Set<LocalId>,
  context: string,
): void {
  for (const atom of atoms) {
    validateAtom(atom, boundLocals, context);
  }
}
