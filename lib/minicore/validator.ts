import type {
  Alt,
  Expr,
  FunctionDef,
  LocalId,
  Program,
  SymbolId,
} from "./ast.ts";
import { getRuntimeSymbolSignature } from "./runtimeSymbols.ts";

export class MiniCoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniCoreValidationError";
  }
}

export interface MiniCoreValidationOptions {
  requireNullaryEntry?: boolean;
}

export function validateMiniCoreProgram(
  program: Program,
  options: MiniCoreValidationOptions = {},
): void {
  const requireNullaryEntry = options.requireNullaryEntry ?? true;
  const entrySymbol = program.symbols[program.entry];
  if (entrySymbol === undefined) {
    throw new MiniCoreValidationError(
      `Entry symbol ${program.entry} not found`,
    );
  }
  if (entrySymbol.kind !== "function") {
    throw new MiniCoreValidationError(
      `Entry symbol ${entrySymbol.name} must be a function`,
    );
  }
  if (requireNullaryEntry && entrySymbol.arity !== 0) {
    throw new MiniCoreValidationError(
      `Entry function ${entrySymbol.name} must have arity 0`,
    );
  }

  for (let i = 0; i < program.symbols.length; i++) {
    const symbol = program.symbols[i]!;
    if (symbol.id !== i) {
      throw new MiniCoreValidationError(
        `Symbol ${symbol.name} ID mismatch: expected ${i}, got ${symbol.id}`,
      );
    }
    const namedId = program.symbolsByName.get(symbol.name);
    if (namedId === undefined) {
      throw new MiniCoreValidationError(
        `Symbol ${symbol.name} missing from symbolsByName`,
      );
    }
    if (namedId !== i) {
      throw new MiniCoreValidationError(
        `symbolsByName mismatch for ${symbol.name}: expected ${i}, got ${namedId}`,
      );
    }

    if (symbol.kind === "function") {
      validateFunction(symbol, program);
    } else if (symbol.kind === "primitive") {
      if (symbol.strict.length !== symbol.arity) {
        throw new MiniCoreValidationError(
          `Primitive ${symbol.name} arity/strictness mismatch`,
        );
      }
    } else if (symbol.kind === "constructor") {
      if (symbol.arity < 0) {
        throw new MiniCoreValidationError(
          `Constructor ${symbol.name} has negative arity`,
        );
      }
    }
  }
}

function validateFunction(fn: FunctionDef, program: Program): void {
  if (fn.arity < 0) {
    throw new MiniCoreValidationError(`Function ${fn.name} has negative arity`);
  }
  if (fn.arity !== fn.params.length) {
    throw new MiniCoreValidationError(
      `Function ${fn.name} arity ${fn.arity} does not match params length ${fn.params.length}`,
    );
  }

  const uniqueParams = new Set(fn.params);
  if (uniqueParams.size !== fn.params.length) {
    throw new MiniCoreValidationError(
      `Function ${fn.name} has duplicate parameters`,
    );
  }

  validateExpr(fn.body, uniqueParams, program, fn.name);
}

function validateExpr(
  expr: Expr,
  boundLocals: Set<LocalId>,
  program: Program,
  context: string,
): void {
  switch (expr.kind) {
    case "var":
      if (!boundLocals.has(expr.id)) {
        throw new MiniCoreValidationError(
          `Local variable ${expr.id} is unbound in ${context}`,
        );
      }
      break;
    case "lit":
      break;
    case "call": {
      const target = program.symbols[expr.target];
      if (!target || target.kind !== "function") {
        throw new MiniCoreValidationError(
          `Call target ${expr.target} in ${context} is not a function`,
        );
      }
      if (expr.args.length !== target.arity) {
        throw new MiniCoreValidationError(
          `Call to ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${expr.args.length}`,
        );
      }
      for (const arg of expr.args) {
        validateExpr(arg, boundLocals, program, context);
      }
      break;
    }
    case "con": {
      const target = program.symbols[expr.target];
      if (!target || target.kind !== "constructor") {
        throw new MiniCoreValidationError(
          `Constructor target ${expr.target} in ${context} is not a constructor`,
        );
      }
      if (expr.fields.length !== target.arity) {
        throw new MiniCoreValidationError(
          `Constructor ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${expr.fields.length}`,
        );
      }
      for (const field of expr.fields) {
        validateExpr(field, boundLocals, program, context);
      }
      break;
    }
    case "prim": {
      const target = program.symbols[expr.target];
      if (!target || target.kind !== "primitive") {
        throw new MiniCoreValidationError(
          `Primitive target ${expr.target} in ${context} is not a primitive`,
        );
      }
      if (expr.args.length !== target.arity) {
        throw new MiniCoreValidationError(
          `Primitive ${target.name} in ${context} has wrong arity: expected ${target.arity}, got ${expr.args.length}`,
        );
      }
      for (const arg of expr.args) {
        validateExpr(arg, boundLocals, program, context);
      }
      break;
    }
    case "runtimeCall": {
      const signature = runtimeSignature(expr.name);
      if (expr.args.length !== signature.args.length) {
        throw new MiniCoreValidationError(
          `Runtime call ${expr.name} in ${context} has wrong arity: expected ${signature.args.length}, got ${expr.args.length}`,
        );
      }
      for (const arg of expr.args) {
        validateExpr(arg, boundLocals, program, context);
      }
      break;
    }
    case "case": {
      validateExpr(expr.scrutinee, boundLocals, program, context);
      const constructors = new Set<SymbolId>();
      for (const alt of expr.alts) {
        if (constructors.has(alt.constructor)) {
          const name =
            program.symbols[alt.constructor]?.name ?? String(alt.constructor);
          throw new MiniCoreValidationError(
            `Duplicate constructor ${name} in case expression in ${context}`,
          );
        }
        constructors.add(alt.constructor);
        validateAlt(alt, boundLocals, program, context);
      }
      break;
    }
    case "let": {
      let currentLocals = boundLocals;
      for (const binding of expr.bindings) {
        validateExpr(binding.value, currentLocals, program, context);
        currentLocals = new Set(currentLocals);
        currentLocals.add(binding.id);
      }
      validateExpr(expr.body, currentLocals, program, context);
      break;
    }
  }
}

function runtimeSignature(
  name: Parameters<typeof getRuntimeSymbolSignature>[0],
) {
  try {
    return getRuntimeSymbolSignature(name);
  } catch {
    throw new MiniCoreValidationError(
      `Unknown Trip runtime symbol ${String(name)}`,
    );
  }
}

function validateAlt(
  alt: Alt,
  boundLocals: Set<LocalId>,
  program: Program,
  context: string,
): void {
  const target = program.symbols[alt.constructor];
  if (!target || target.kind !== "constructor") {
    throw new MiniCoreValidationError(
      `Case alternative constructor ${alt.constructor} in ${context} is not a constructor`,
    );
  }
  if (alt.binders.length !== target.arity) {
    throw new MiniCoreValidationError(
      `Case alternative for ${target.name} in ${context} has wrong binder count: expected ${target.arity}, got ${alt.binders.length}`,
    );
  }
  const uniqueBinders = new Set(alt.binders);
  if (uniqueBinders.size !== alt.binders.length) {
    throw new MiniCoreValidationError(
      `Case alternative for ${target.name} in ${context} has duplicate binders`,
    );
  }

  const nextLocals = new Set(boundLocals);
  for (const binder of alt.binders) {
    nextLocals.add(binder);
  }
  validateExpr(alt.body, nextLocals, program, context);
}
