import type { LocalId, SymbolId } from "./ast.ts";
import {
  miniTypeEquals,
  miniTypeToString,
  type MiniCoreMetadata,
  type MiniType,
  type TypeId,
} from "./metadata.ts";
import { getRuntimeSymbolSignature } from "./runtimeSymbols.ts";
import { typeOfAnfAtom, typeOfAnfExpr } from "./typeOf.ts";
import type {
  AnfAlt,
  AnfAtom,
  AnfCase,
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
  if (program.metadata) {
    validateConstructorTags(program.metadata);
  }

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

  validateExpr(fn.body, uniqueParams, program, fn);
}

function validateExpr(
  expr: AnfExpr,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  fn: AnfFunctionDef,
): void {
  switch (expr.kind) {
    case "atom":
      validateAtom(expr.atom, boundLocals, fn.name);
      break;
    case "call":
    case "con":
    case "prim":
    case "runtimeCall":
    case "case":
      validateValue(expr, boundLocals, program, fn);
      break;
    case "let": {
      validateValue(expr.value, boundLocals, program, fn);
      if (boundLocals.has(expr.id)) {
        throw new MiniCoreAnfValidationError(
          `Local variable ${expr.id} is rebound in ${fn.name}`,
        );
      }
      const nextLocals = new Set(boundLocals);
      nextLocals.add(expr.id);
      validateExpr(expr.body, nextLocals, program, fn);
      break;
    }
  }
}

function validateValue(
  value: AnfValue,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  fn: AnfFunctionDef,
): void {
  switch (value.kind) {
    case "atom":
      validateAtom(value.atom, boundLocals, fn.name);
      break;
    case "call": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "function") {
        throw new MiniCoreAnfValidationError(
          `Call target ${value.target} in ${fn.name} is not a function`,
        );
      }
      if (value.args.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Call to ${target.name} in ${fn.name} has wrong arity: expected ${target.arity}, got ${value.args.length}`,
        );
      }
      validateAtoms(value.args, boundLocals, fn.name);
      break;
    }
    case "con": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "constructor") {
        throw new MiniCoreAnfValidationError(
          `Constructor target ${value.target} in ${fn.name} is not a constructor`,
        );
      }
      if (value.fields.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Constructor ${target.name} in ${fn.name} has wrong arity: expected ${target.arity}, got ${value.fields.length}`,
        );
      }
      validateAtoms(value.fields, boundLocals, fn.name);
      break;
    }
    case "prim": {
      const target = program.symbols[value.target];
      if (!target || target.kind !== "primitive") {
        throw new MiniCoreAnfValidationError(
          `Primitive target ${value.target} in ${fn.name} is not a primitive`,
        );
      }
      if (value.args.length !== target.arity) {
        throw new MiniCoreAnfValidationError(
          `Primitive ${target.name} in ${fn.name} has wrong arity: expected ${target.arity}, got ${value.args.length}`,
        );
      }
      validateAtoms(value.args, boundLocals, fn.name);
      break;
    }
    case "runtimeCall": {
      const signature = runtimeSignature(value.name);
      if (value.args.length !== signature.args.length) {
        throw new MiniCoreAnfValidationError(
          `Runtime call ${value.name} in ${fn.name} has wrong arity: expected ${signature.args.length}, got ${value.args.length}`,
        );
      }
      validateAtoms(value.args, boundLocals, fn.name);
      break;
    }
    case "case": {
      if (program.metadata) {
        validateCase(value, boundLocals, program, fn);
      } else {
        validateAtom(value.scrutinee, boundLocals, fn.name);
        const constructors = new Set<SymbolId>();
        for (const alt of value.alts) {
          if (constructors.has(alt.constructor)) {
            const name =
              program.symbols[alt.constructor]?.name ?? String(alt.constructor);
            throw new MiniCoreAnfValidationError(
              `Duplicate constructor ${name} in case expression in ${fn.name}`,
            );
          }
          constructors.add(alt.constructor);
          validateAlt(alt, boundLocals, program, fn);
        }
      }
      break;
    }
  }
}

function validateAlt(
  alt: AnfAlt,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  fn: AnfFunctionDef,
): void {
  const target = program.symbols[alt.constructor];
  if (!target || target.kind !== "constructor") {
    throw new MiniCoreAnfValidationError(
      `Case alternative constructor ${alt.constructor} in ${fn.name} is not a constructor`,
    );
  }
  if (alt.binders.length !== target.arity) {
    throw new MiniCoreAnfValidationError(
      `Case alternative for ${target.name} in ${fn.name} has wrong binder count: expected ${target.arity}, got ${alt.binders.length}`,
    );
  }
  const uniqueBinders = new Set(alt.binders);
  if (uniqueBinders.size !== alt.binders.length) {
    throw new MiniCoreAnfValidationError(
      `Case alternative for ${target.name} in ${fn.name} has duplicate binders`,
    );
  }

  const nextLocals = new Set(boundLocals);
  for (const binder of alt.binders) {
    if (nextLocals.has(binder)) {
      throw new MiniCoreAnfValidationError(
        `Case alternative for ${target.name} in ${fn.name} rebinds local ${binder}`,
      );
    }
    nextLocals.add(binder);
  }
  validateExpr(alt.body, nextLocals, program, fn);
}

function validateCase(
  value: AnfCase,
  boundLocals: Set<LocalId>,
  program: AnfProgram,
  fn: AnfFunctionDef,
): void {
  const metadata = program.metadata!;
  validateAtom(value.scrutinee, boundLocals, fn.name);
  if (value.alts.length === 0) {
    throw new MiniCoreAnfValidationError(
      `Case expression in ${fn.name} has no alternatives`,
    );
  }

  const scrutineeType = readType(() =>
    typeOfAnfAtom(value.scrutinee, fn.id, metadata),
  );
  const seenConstructors = new Set<SymbolId>();
  let dataType: TypeId | undefined;
  let branchType: MiniType | undefined;
  const localTypes = ensureFunctionLocalTypes(metadata, fn.id);

  for (const alt of value.alts) {
    if (seenConstructors.has(alt.constructor)) {
      const name =
        program.symbols[alt.constructor]?.name ?? String(alt.constructor);
      throw new MiniCoreAnfValidationError(
        `Duplicate constructor ${name} in case expression in ${fn.name}`,
      );
    }
    seenConstructors.add(alt.constructor);

    const ctor = metadata.constructors.get(alt.constructor);
    if (!ctor) {
      throw new MiniCoreAnfValidationError(
        `Case alternative ${alt.constructor} is not a known constructor`,
      );
    }

    if (dataType === undefined) {
      dataType = ctor.dataType;
    } else if (dataType !== ctor.dataType) {
      throw new MiniCoreAnfValidationError(
        `Case mixes constructors from multiple datatypes in ${fn.name}`,
      );
    }

    if (alt.binders.length !== ctor.fieldTypes.length) {
      throw new MiniCoreAnfValidationError(
        `Case alternative binder count does not match constructor field count in ${fn.name}`,
      );
    }

    const nextLocals = new Set(boundLocals);
    for (let i = 0; i < alt.binders.length; i++) {
      const binder = alt.binders[i]!;
      if (nextLocals.has(binder)) {
        throw new MiniCoreAnfValidationError(
          `Case alternative in ${fn.name} rebinds local ${binder}`,
        );
      }
      const expectedType = ctor.fieldTypes[i]!;
      const knownType = localTypes.get(binder);
      if (knownType && !miniTypeEquals(knownType, expectedType)) {
        throw new MiniCoreAnfValidationError(
          `Case binder ${binder} in ${fn.name} has type ${miniTypeToString(
            knownType,
          )}, expected ${miniTypeToString(expectedType)}`,
        );
      }
      localTypes.set(binder, knownType ?? expectedType);
      nextLocals.add(binder);
    }

    const altType = readType(() => typeOfAnfExpr(alt.body, fn.id, metadata));
    if (branchType === undefined) {
      branchType = altType;
    } else if (!miniTypeEquals(branchType, altType)) {
      throw new MiniCoreAnfValidationError(
        `Case branch type mismatch in ${fn.name}: expected ${miniTypeToString(
          branchType,
        )}, got ${miniTypeToString(altType)}`,
      );
    }

    validateExpr(alt.body, nextLocals, program, fn);
  }

  if (dataType === undefined) {
    throw new MiniCoreAnfValidationError(
      `Case expression in ${fn.name} has no datatype`,
    );
  }
  assertScrutineeMatchesDataType(scrutineeType, dataType, metadata, fn.name);
}

function validateConstructorTags(metadata: MiniCoreMetadata): void {
  for (const dataType of metadata.dataTypes.values()) {
    const tags = new Map<number, SymbolId>();
    for (const constructor of dataType.constructors) {
      const info = metadata.constructors.get(constructor);
      if (!info) continue;
      const previous = tags.get(info.tag);
      if (previous !== undefined) {
        throw new MiniCoreAnfValidationError(
          `Duplicate constructor tag ${info.tag} in datatype ${dataType.name}`,
        );
      }
      tags.set(info.tag, constructor);
    }
  }
}

function assertScrutineeMatchesDataType(
  scrutineeType: MiniType,
  dataType: TypeId,
  metadata: MiniCoreMetadata,
  context: string,
): void {
  if (scrutineeType.kind === "unknown") return;
  if (metadata.bool?.dataType === dataType && scrutineeType.kind === "bool") {
    return;
  }
  if (scrutineeType.kind === "data" && scrutineeType.id === dataType) {
    return;
  }
  throw new MiniCoreAnfValidationError(
    `Case scrutinee in ${context} has type ${miniTypeToString(
      scrutineeType,
    )}, expected datatype ${metadata.dataTypes.get(dataType)?.name ?? dataType}`,
  );
}

function ensureFunctionLocalTypes(
  metadata: MiniCoreMetadata,
  fnId: SymbolId,
): Map<LocalId, MiniType> {
  let locals = metadata.localTypesByFunction.get(fnId);
  if (!locals) {
    locals = new Map();
    metadata.localTypesByFunction.set(fnId, locals);
  }
  return locals;
}

function readType(fn: () => MiniType): MiniType {
  try {
    return fn();
  } catch (error) {
    throw new MiniCoreAnfValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function runtimeSignature(
  name: Parameters<typeof getRuntimeSymbolSignature>[0],
) {
  try {
    return getRuntimeSymbolSignature(name);
  } catch {
    throw new MiniCoreAnfValidationError(
      `Unknown Trip runtime symbol ${String(name)}`,
    );
  }
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
