import type {
  ConstructorDef,
  Literal,
  LocalId,
  PrimitiveDef,
  SymbolId,
} from "./ast.ts";
import type {
  AnfAlt,
  AnfAtom,
  AnfCase,
  AnfExpr,
  AnfFunctionDef,
  AnfProgram,
  AnfSymbolDef,
  AnfValue,
} from "./anfAst.ts";
import type {
  Block,
  BlockCaseAlt,
  BlockFunctionDef,
  BlockInstruction,
  BlockModule,
  BlockParam,
  BlockSymbolDef,
  BlockTerminator,
  BlockValueRef,
  BlockVisibility,
} from "./blockAst.ts";
import {
  cloneMiniCoreMetadata,
  miniTypeUnify,
  miniTypeEquals,
  substituteMiniType,
  typeOfLiteral,
  type MiniCoreMetadata,
  type MiniType,
} from "./metadata.ts";
import { getRuntimeSymbolSignature } from "./runtimeSymbols.ts";
import { typeOfAnfAtom, typeOfAnfExpr, typeOfAnfValue } from "./typeOf.ts";

export class MiniCoreBlockLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniCoreBlockLoweringError";
  }
}

interface FunctionLoweringState {
  program: AnfProgram;
  metadata: MiniCoreMetadata;
  fn: AnfFunctionDef;
  localTypes: Map<LocalId, MiniType>;
  blocks: Block[];
  nextLocalId: LocalId;
  nextCaseId: number;
}

type LocalEnv = ReadonlyMap<LocalId, LocalId>;

interface CaseTargets {
  alts: BlockCaseAlt[];
  altBlocks: Array<{ block: Block; alt: AnfAlt; env: LocalEnv }>;
}

export function anfToBlockModule(program: AnfProgram): BlockModule {
  if (!program.metadata) {
    throw new MiniCoreBlockLoweringError(
      "ANF program must include MiniCore metadata to lower to Block IR",
    );
  }

  const metadata = cloneMiniCoreMetadata(program.metadata);
  const withMetadata: AnfProgram = { ...program, metadata };
  const symbols = withMetadata.symbols.map((symbol): BlockSymbolDef => {
    switch (symbol.kind) {
      case "function":
        return anfToBlockFunction(symbol, withMetadata);
      case "constructor":
        return blockConstructor(symbol);
      case "primitive":
        return blockPrimitive(symbol);
    }
  });

  return {
    symbols,
    entry: withMetadata.entry,
    symbolsByName: withMetadata.symbolsByName,
    metadata,
  };
}

export function anfToBlockFunction(
  fn: AnfFunctionDef,
  program: AnfProgram,
  visibility: BlockVisibility = visibilityFor(fn, program),
): BlockFunctionDef {
  if (!program.metadata) {
    throw new MiniCoreBlockLoweringError(
      "ANF program must include MiniCore metadata to lower to Block IR",
    );
  }
  const metadata = program.metadata;
  const localTypes = ensureFunctionLocalTypes(metadata, fn.id);
  const state: FunctionLoweringState = {
    program,
    metadata,
    fn,
    localTypes,
    blocks: [],
    nextLocalId: maxLocalIdInFunction(fn) + 1,
    nextCaseId: 0,
  };

  const params = fn.params.map((id) => blockParam(state, id));
  const entry = createBlock("entry", params);
  state.blocks.push(entry);
  lowerExprToReturn(fn.body, entry, state, new Map());

  return {
    kind: "function",
    id: fn.id,
    name: fn.name,
    params,
    returnType:
      metadata.functions.get(fn.id)?.resultType ??
      typeOfAnfExpr(fn.body, fn.id, metadata),
    blocks: state.blocks,
    visibility,
  };
}

function lowerExprToReturn(
  expr: AnfExpr,
  block: Block,
  state: FunctionLoweringState,
  env: LocalEnv,
): void {
  switch (expr.kind) {
    case "let": {
      lowerLet(expr.id, expr.value, block, state, env, (nextBlock, nextEnv) =>
        lowerExprToReturn(expr.body, nextBlock, state, nextEnv),
      );
      return;
    }
    case "case":
      lowerCaseToReturn(expr, block, state, env);
      return;
    case "atom": {
      const returnType = functionReturnType(state);
      if (returnType.kind === "unit") {
        const exprType = typeOfAnfAtom(expr.atom, state.fn.id, state.metadata);
        if (exprType.kind !== "unit") {
          throw new MiniCoreBlockLoweringError(
            `Cannot drop non-Unit return value in ${state.fn.name}`,
          );
        }
        block.terminator = { kind: "return" };
        return;
      }
      block.terminator = {
        kind: "return",
        value: atomRef(expr.atom, state, env),
      };
      return;
    }
    case "call":
    case "con":
    case "prim":
    case "runtimeCall": {
      const resultType = typeOfAnfValue(expr, state.fn.id, state.metadata);
      const isTailCall = expr.kind === "call" || expr.kind === "runtimeCall";
      if (resultType.kind === "unit") {
        if (functionReturnType(state).kind !== "unit") {
          throw new MiniCoreBlockLoweringError(
            `Cannot return Unit from non-Unit function ${state.fn.name}`,
          );
        }
        emitInstruction(expr, block, state, env, undefined, isTailCall);
        block.terminator = { kind: "return" };
        return;
      }
      const result = emitInstruction(expr, block, state, env, undefined, isTailCall);
      if (!result) {
        throw new MiniCoreBlockLoweringError(
          `Cannot return Unit from non-Unit function ${state.fn.name}`,
        );
      }
      block.terminator = { kind: "return", value: result };
      return;
    }
  }
}

function lowerExprToJump(
  expr: AnfExpr,
  block: Block,
  target: string,
  state: FunctionLoweringState,
  env: LocalEnv,
): void {
  switch (expr.kind) {
    case "let":
      lowerLet(expr.id, expr.value, block, state, env, (nextBlock, nextEnv) =>
        lowerExprToJump(expr.body, nextBlock, target, state, nextEnv),
      );
      return;
    case "case":
      lowerCaseToJump(expr, block, target, state, env);
      return;
    case "atom":
      block.terminator = {
        kind: "jump",
        target,
        args: [atomRef(expr.atom, state, env)],
      };
      return;
    case "call":
    case "con":
    case "prim":
    case "runtimeCall": {
      const result = emitInstruction(expr, block, state, env);
      if (!result) {
        throw new MiniCoreBlockLoweringError(
          `Cannot pass Unit value to block ${target} from ${state.fn.name}`,
        );
      }
      block.terminator = {
        kind: "jump",
        target,
        args: [result],
      };
      return;
    }
  }
}

function lowerLet(
  id: LocalId,
  value: AnfValue,
  block: Block,
  state: FunctionLoweringState,
  env: LocalEnv,
  continueWith: (block: Block, env: LocalEnv) => void,
): void {
  if (value.kind === "case") {
    const result = blockParam(state, id);
    const caseId = state.nextCaseId++;
    const join = createBlock(`case${caseId}_join`, [result]);
    lowerCaseWithContinuation(
      value,
      block,
      state,
      env,
      caseId,
      (alt, altBlock, altEnv) =>
        lowerExprToJump(alt.body, altBlock, join.label, state, altEnv),
    );
    state.blocks.push(join);
    continueWith(join, withoutLocal(env, id));
    return;
  }

  if (typeOfAnfValue(value, state.fn.id, state.metadata).kind === "unit") {
    emitInstruction(value, block, state, env);
    continueWith(block, withoutLocal(env, id));
    return;
  }

  emitInstruction(value, block, state, env, id);
  continueWith(block, withoutLocal(env, id));
}

function lowerCaseToReturn(
  expr: AnfCase,
  block: Block,
  state: FunctionLoweringState,
  env: LocalEnv,
): void {
  const caseId = state.nextCaseId++;
  lowerCaseWithContinuation(
    expr,
    block,
    state,
    env,
    caseId,
    (alt, altBlock, altEnv) =>
      lowerExprToReturn(alt.body, altBlock, state, altEnv),
  );
}

function lowerCaseToJump(
  expr: AnfCase,
  block: Block,
  target: string,
  state: FunctionLoweringState,
  env: LocalEnv,
): void {
  const caseId = state.nextCaseId++;
  lowerCaseWithContinuation(
    expr,
    block,
    state,
    env,
    caseId,
    (alt, altBlock, altEnv) =>
      lowerExprToJump(alt.body, altBlock, target, state, altEnv),
  );
}

function lowerCaseWithContinuation(
  expr: AnfCase,
  block: Block,
  state: FunctionLoweringState,
  env: LocalEnv,
  caseId: number,
  lowerAlt: (alt: AnfAlt, block: Block, env: LocalEnv) => void,
): void {
  const targets = buildCaseTargets(expr, state, env, caseId);
  block.terminator = caseTerminator(expr, targets, state, env);
  for (const { block: altBlock, alt, env: altEnv } of targets.altBlocks) {
    state.blocks.push(altBlock);
    lowerAlt(alt, altBlock, altEnv);
  }
}

function caseTerminator(
  expr: AnfCase,
  targets: CaseTargets,
  state: FunctionLoweringState,
  env: LocalEnv,
): BlockTerminator {
  const boolBranch = boolBranchTargets(expr, targets, state, env);
  if (boolBranch) {
    return boolBranch;
  }
  return {
    kind: "case",
    scrutinee: atomRef(expr.scrutinee, state, env),
    alts: targets.alts,
  };
}

function boolBranchTargets(
  expr: AnfCase,
  targets: CaseTargets,
  state: FunctionLoweringState,
  env: LocalEnv,
): BlockTerminator | undefined {
  // Attempt to lower Bool case expressions to branch instructions (br i1).
  // This ensures Bool cases never reach emitCaseTerminator in boxed-runtime,
  // which would incorrectly try to call @trip_obj_tag(ptr %scrutinee).
  // Bool is represented as i1, not a boxed object.

  const bool = state.metadata.bool;
  if (!bool || expr.alts.length !== 2) return undefined;

  const byConstructor = new Map(
    targets.alts.map((alt) => [alt.constructor, alt]),
  );
  const trueAlt = byConstructor.get(bool.trueConstructor);
  const falseAlt = byConstructor.get(bool.falseConstructor);
  if (!trueAlt || !falseAlt) return undefined;
  if (trueAlt.binders.length !== 0 || falseAlt.binders.length !== 0) {
    return undefined;
  }
  if (
    !miniTypeEquals(
      typeOfAnfAtom(expr.scrutinee, state.fn.id, state.metadata),
      bool.type,
    )
  ) {
    return undefined;
  }

  return {
    kind: "branch",
    condition: atomRef(expr.scrutinee, state, env),
    thenTarget: trueAlt.target,
    thenArgs: trueAlt.args,
    elseTarget: falseAlt.target,
    elseArgs: falseAlt.args,
  };
}

function buildCaseTargets(
  expr: AnfCase,
  state: FunctionLoweringState,
  env: LocalEnv,
  caseId: number,
): CaseTargets {
  const alts: BlockCaseAlt[] = [];
  const altBlocks: Array<{ block: Block; alt: AnfAlt; env: LocalEnv }> = [];

  expr.alts.forEach((alt, index) => {
    const constructor = state.program.symbols[alt.constructor];
    if (!constructor || constructor.kind !== "constructor") {
      throw new MiniCoreBlockLoweringError(
        `Case alternative ${alt.constructor} is not a constructor`,
      );
    }

    const captures = freeLocals(alt.body, new Set(alt.binders)).filter(
      (id) => !alt.binders.includes(id),
    );
    specializeCaseBinderTypes(expr.scrutinee, alt, state);
    const binders = alt.binders.map((id) => blockParam(state, id));
    const captureBindings = captures.map((id) => {
      const source = localRef(state, env, id);
      const param = blockParam(state, allocLocal(state, source.type));
      return { original: id, source, param };
    });
    const captureParams = captureBindings.map(({ param }) => param);
    const target = `case${caseId}_alt${index}_${labelSuffix(constructor.name)}`;
    const altEnv = new Map(env);
    for (const binder of binders) {
      altEnv.set(binder.id, binder.id);
    }
    for (const { original, param } of captureBindings) {
      altEnv.set(original, param.id);
    }

    alts.push({
      constructor: alt.constructor,
      constructorName: constructor.name,
      binders,
      target,
      args: captureBindings.map(({ source }) => source),
    });
    altBlocks.push({
      block: createBlock(target, [...binders, ...captureParams]),
      alt,
      env: altEnv,
    });
  });

  return { alts, altBlocks };
}

function specializeCaseBinderTypes(
  scrutinee: AnfAtom,
  alt: AnfAlt,
  state: FunctionLoweringState,
): void {
  const constructorInfo = state.metadata.constructors.get(alt.constructor);
  if (!constructorInfo) return;

  const scrutineeType = typeOfAnfAtom(scrutinee, state.fn.id, state.metadata);
  if (scrutineeType.kind === "unknown") return;

  const subst = new Map<string, MiniType>();
  try {
    miniTypeUnify(scrutineeType, constructorInfo.resultType, subst);
  } catch {
    return;
  }

  alt.binders.forEach((id, index) => {
    const fieldType = constructorInfo.fieldTypes[index];
    if (!fieldType) return;
    state.localTypes.set(id, substituteMiniType(fieldType, subst));
  });
}

function emitInstruction(
  value: Exclude<AnfValue, AnfCase>,
  block: Block,
  state: FunctionLoweringState,
  env: LocalEnv,
  resultId?: LocalId,
  isTail: boolean = false,
): BlockValueRef | undefined {
  const resultType = typeOfAnfValue(value, state.fn.id, state.metadata);
  const result =
    resultType.kind === "unit"
      ? undefined
      : blockParam(state, resultId ?? allocLocal(state, resultType));
  let instruction: BlockInstruction;

  switch (value.kind) {
    case "atom":
      if (!result) {
        throw new MiniCoreBlockLoweringError(
          `Cannot emit Unit atom in ${state.fn.name}`,
        );
      }
      instruction = {
        result,
        resultType,
        effects: "pure",
        op: { kind: "move", value: atomRef(value.atom, state, env) },
      };
      break;
    case "call": {
      const target = requireSymbol(state, value.target, "function");
      instruction = {
        result,
        resultType,
        effects: "unknown",
        op: {
          kind: "call",
          target: value.target,
          name: target.name,
          args: value.args.map((arg) => atomRef(arg, state, env)),
          typeArgs: value.typeArgs,
          isTail,
        },
      };
      break;
    }
    case "con": {
      const target = requireSymbol(state, value.target, "constructor");
      if (!result) {
        throw new MiniCoreBlockLoweringError(
          `Cannot emit Unit constructor in ${state.fn.name}`,
        );
      }
      instruction = {
        result,
        resultType,
        effects: "pure",
        op: {
          kind: "construct",
          target: value.target,
          name: target.name,
          args: value.fields.map((field) => atomRef(field, state, env)),
          typeArgs: value.typeArgs,
        },
      };
      break;
    }
    case "prim": {
      const target = requireSymbol(state, value.target, "primitive");
      const primitive = state.metadata.primitives.get(value.target);
      if (!result) {
        throw new MiniCoreBlockLoweringError(
          `Cannot emit Unit primitive ${target.name} in ${state.fn.name}`,
        );
      }
      instruction = {
        result,
        resultType,
        effects: primitive?.effects ?? "unknown",
        op: {
          kind: "prim",
          target: value.target,
          name: target.name,
          args: value.args.map((arg) => atomRef(arg, state, env)),
          typeArgs: value.typeArgs,
        },
      };
      break;
    }
    case "runtimeCall": {
      const signature = getRuntimeSymbolSignature(value.name);
      instruction = {
        result,
        resultType,
        effects: signature.effects,
        op: {
          kind: "runtimeCall",
          name: value.name,
          args: value.args.map((arg) => atomRef(arg, state, env)),
          isTail,
        },
      };
      break;
    }
  }

  block.instructions.push(instruction);
  if (!result) return undefined;
  return { kind: "local", id: result.id, name: result.name, type: result.type };
}

function atomRef(
  atom: AnfAtom,
  state: FunctionLoweringState,
  env: LocalEnv,
): BlockValueRef {
  switch (atom.kind) {
    case "lit":
      return literalRef(atom.value);
    case "var":
      return localRef(state, env, atom.id);
  }
}

function localRef(
  state: FunctionLoweringState,
  env: LocalEnv,
  id: LocalId,
): BlockValueRef {
  const resolved = env.get(id) ?? id;
  return {
    kind: "local",
    id: resolved,
    type: blockParam(state, resolved).type,
  };
}

function literalRef(value: Literal): BlockValueRef {
  return { kind: "literal", value, type: typeOfLiteral(value) };
}

function functionReturnType(state: FunctionLoweringState): MiniType {
  return (
    state.metadata.functions.get(state.fn.id)?.resultType ??
    typeOfAnfExpr(state.fn.body, state.fn.id, state.metadata)
  );
}

function withoutLocal(env: LocalEnv, id: LocalId): LocalEnv {
  if (!env.has(id)) return env;
  const next = new Map(env);
  next.delete(id);
  return next;
}

function blockParam(state: FunctionLoweringState, id: LocalId): BlockParam {
  const type = state.localTypes.get(id);
  if (!type) {
    throw new MiniCoreBlockLoweringError(
      `No type recorded for local ${id} in ${state.fn.name}`,
    );
  }
  return { id, type };
}

function allocLocal(state: FunctionLoweringState, type: MiniType): LocalId {
  const id = state.nextLocalId++;
  state.localTypes.set(id, type);
  return id;
}

function createBlock(label: string, params: BlockParam[]): Block {
  return {
    label,
    params,
    instructions: [],
    terminator: { kind: "unreachable" },
  };
}

function requireSymbol<K extends AnfSymbolDef["kind"]>(
  state: FunctionLoweringState,
  id: SymbolId,
  kind: K,
): Extract<AnfSymbolDef, { kind: K }> {
  const symbol = state.program.symbols[id];
  if (!symbol || symbol.kind !== kind) {
    throw new MiniCoreBlockLoweringError(`Symbol ${id} is not a ${kind}`);
  }
  return symbol as Extract<AnfSymbolDef, { kind: K }>;
}

function freeLocals(expr: AnfExpr, bound: Set<LocalId>): LocalId[] {
  const seen = new Set<LocalId>();
  const result: LocalId[] = [];
  const add = (id: LocalId, currentBound: Set<LocalId>) => {
    if (currentBound.has(id) || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  const visitAtom = (atom: AnfAtom, currentBound: Set<LocalId>) => {
    if (atom.kind === "var") add(atom.id, currentBound);
  };
  const visitValue = (value: AnfValue, currentBound: Set<LocalId>) => {
    switch (value.kind) {
      case "atom":
        visitAtom(value.atom, currentBound);
        break;
      case "call":
      case "prim":
      case "runtimeCall":
        value.args.forEach((arg) => visitAtom(arg, currentBound));
        break;
      case "con":
        value.fields.forEach((field) => visitAtom(field, currentBound));
        break;
      case "case":
        visitAtom(value.scrutinee, currentBound);
        for (const alt of value.alts) {
          visitExpr(alt.body, new Set([...currentBound, ...alt.binders]));
        }
        break;
    }
  };
  const visitExpr = (value: AnfExpr, currentBound: Set<LocalId>) => {
    switch (value.kind) {
      case "let":
        visitValue(value.value, currentBound);
        visitExpr(value.body, new Set([...currentBound, value.id]));
        break;
      case "atom":
      case "call":
      case "con":
      case "prim":
      case "runtimeCall":
      case "case":
        visitValue(value, currentBound);
        break;
    }
  };

  visitExpr(expr, bound);
  return result;
}

function maxLocalIdInFunction(fn: AnfFunctionDef): LocalId {
  let max = -1;
  for (const param of fn.params) max = Math.max(max, param);
  const visitAtom = (atom: AnfAtom) => {
    if (atom.kind === "var") max = Math.max(max, atom.id);
  };
  const visitValue = (value: AnfValue) => {
    switch (value.kind) {
      case "atom":
        visitAtom(value.atom);
        break;
      case "call":
      case "prim":
      case "runtimeCall":
        value.args.forEach(visitAtom);
        break;
      case "con":
        value.fields.forEach(visitAtom);
        break;
      case "case":
        visitAtom(value.scrutinee);
        for (const alt of value.alts) {
          alt.binders.forEach((id) => {
            max = Math.max(max, id);
          });
          visitExpr(alt.body);
        }
        break;
    }
  };
  const visitExpr = (expr: AnfExpr) => {
    switch (expr.kind) {
      case "let":
        max = Math.max(max, expr.id);
        visitValue(expr.value);
        visitExpr(expr.body);
        break;
      case "atom":
      case "call":
      case "con":
      case "prim":
      case "runtimeCall":
      case "case":
        visitValue(expr);
        break;
    }
  };
  visitExpr(fn.body);
  return max;
}

function ensureFunctionLocalTypes(
  metadata: MiniCoreMetadata,
  fnId: SymbolId,
): Map<LocalId, MiniType> {
  const existing = metadata.localTypesByFunction.get(fnId);
  if (existing) return existing;
  const created = new Map<LocalId, MiniType>();
  metadata.localTypesByFunction.set(fnId, created);
  return created;
}

function blockConstructor(symbol: ConstructorDef) {
  return {
    kind: "constructor" as const,
    id: symbol.id,
    name: symbol.name,
    tag: symbol.tag,
    arity: symbol.arity,
  };
}

function blockPrimitive(symbol: PrimitiveDef) {
  return {
    kind: "primitive" as const,
    id: symbol.id,
    name: symbol.name,
    arity: symbol.arity,
    strict: symbol.strict,
    class: symbol.class,
  };
}

function visibilityFor(
  fn: AnfFunctionDef,
  program: AnfProgram,
): BlockVisibility {
  return program.metadata?.exportedSymbols.has(fn.id) ? "exported" : "private";
}

function labelSuffix(name: string): string {
  return name
    .split(".")
    .at(-1)!
    .replace(/[^A-Za-z0-9_]/g, "_");
}
