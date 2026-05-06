import type { SymbolId } from "./ast.ts";
import type {
  Block,
  BlockFunctionDef,
  BlockInstruction,
  BlockModule,
  BlockParam,
  BlockSymbolDef,
  BlockTerminator,
  BlockValueRef,
} from "./blockAst.ts";
import {
  miniTypeEquals,
  miniTypeToString,
  miniTypeUnify,
  substituteMiniType,
  typeOfLiteral,
  type MiniType,
} from "./metadata.ts";
import { getRuntimeSymbolSignature } from "./runtimeSymbols.ts";

export class MiniCoreBlockValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniCoreBlockValidationError";
  }
}

interface FunctionValidationContext {
  module: BlockModule;
  symbolsById: ReadonlyMap<SymbolId, BlockSymbolDef>;
  fn: BlockFunctionDef;
  blocksByLabel: ReadonlyMap<string, Block>;
  localTypes: ReadonlyMap<number, MiniType>;
  dominatorLocalIdsByBlock: ReadonlyMap<string, ReadonlySet<number>>;
}

export function validateBlockModule(module: BlockModule): void {
  const symbolsById = new Map<SymbolId, BlockSymbolDef>();
  for (const symbol of module.symbols) {
    if (symbolsById.has(symbol.id)) {
      throw new MiniCoreBlockValidationError(
        `Duplicate symbol id ${symbol.id}`,
      );
    }
    symbolsById.set(symbol.id, symbol);
  }

  validateConstructorMetadata(module, symbolsById);

  for (const symbol of module.symbols) {
    if (symbol.kind === "function") {
      validateBlockFunction(symbol, module, symbolsById);
    }
  }
}

function validateConstructorMetadata(
  module: BlockModule,
  symbolsById: ReadonlyMap<SymbolId, BlockSymbolDef>,
): void {
  const tagsByDataType = new Map<number, Map<number, SymbolId>>();
  for (const [symbolId, info] of module.metadata.constructors) {
    const symbol = symbolsById.get(symbolId);
    if (!symbol || symbol.kind !== "constructor") {
      throw new MiniCoreBlockValidationError(
        `Constructor metadata symbol ${symbolId} is not a constructor`,
      );
    }
    if (info.symbol !== symbolId) {
      throw new MiniCoreBlockValidationError(
        `Constructor metadata symbol mismatch: key ${symbolId}, value ${info.symbol}`,
      );
    }
    if (symbol.tag !== info.tag) {
      throw new MiniCoreBlockValidationError(
        `Constructor ${symbol.name} tag mismatch: symbol has ${symbol.tag}, metadata has ${info.tag}`,
      );
    }
    if (symbol.arity !== info.fieldTypes.length) {
      throw new MiniCoreBlockValidationError(
        `Constructor ${symbol.name} arity mismatch: symbol has ${symbol.arity}, metadata has ${info.fieldTypes.length} fields`,
      );
    }
    if (!module.metadata.dataTypes.has(info.dataType)) {
      throw new MiniCoreBlockValidationError(
        `Constructor ${symbol.name} references missing datatype ${info.dataType}`,
      );
    }
    const dataDef = module.metadata.dataTypes.get(info.dataType);
    if (dataDef && !dataDef.constructors.includes(symbolId)) {
      throw new MiniCoreBlockValidationError(
        `Constructor ${symbol.name} is not listed in datatype ${dataDef.name}`,
      );
    }
    if (
      info.resultType.kind === "data" &&
      info.resultType.id !== info.dataType
    ) {
      throw new MiniCoreBlockValidationError(
        `Constructor ${symbol.name} result datatype ${info.resultType.id} does not match metadata datatype ${info.dataType}`,
      );
    }

    const tags = tagsByDataType.get(info.dataType) ?? new Map();
    const previous = tags.get(info.tag);
    if (previous !== undefined) {
      const previousName = symbolsById.get(previous)?.name ?? String(previous);
      throw new MiniCoreBlockValidationError(
        `Datatype ${info.dataType} has duplicate constructor tag ${info.tag} on ${previousName} and ${symbol.name}`,
      );
    }
    tags.set(info.tag, symbolId);
    tagsByDataType.set(info.dataType, tags);
  }
}

function validateBlockFunction(
  fn: BlockFunctionDef,
  module: BlockModule,
  symbolsById: ReadonlyMap<SymbolId, BlockSymbolDef>,
): void {
  if (fn.blocks.length === 0) {
    throw new MiniCoreBlockValidationError(`Function ${fn.name} has no blocks`);
  }

  const blocksByLabel = collectBlocks(fn);
  const localTypes = collectLocalDefinitions(fn);
  const predecessorsByLabel = collectPredecessors(fn, blocksByLabel);
  const dominatorsByLabel = collectDominators(fn, predecessorsByLabel);
  const dominatorLocalIdsByBlock = collectDominatorLocalIds(
    fn,
    dominatorsByLabel,
  );
  validateEntryBlock(fn);

  const context: FunctionValidationContext = {
    module,
    symbolsById,
    fn,
    blocksByLabel,
    localTypes,
    dominatorLocalIdsByBlock,
  };

  for (const block of fn.blocks) {
    validateBlock(block, context);
  }
}

function collectBlocks(fn: BlockFunctionDef): Map<string, Block> {
  const blocksByLabel = new Map<string, Block>();
  for (const block of fn.blocks) {
    if (blocksByLabel.has(block.label)) {
      throw new MiniCoreBlockValidationError(
        `Function ${fn.name} has duplicate block label ${block.label}`,
      );
    }
    blocksByLabel.set(block.label, block);
  }
  return blocksByLabel;
}

function collectLocalDefinitions(
  fn: BlockFunctionDef,
): ReadonlyMap<number, MiniType> {
  const localTypes = new Map<number, MiniType>();

  const define = (param: BlockParam, context: string) => {
    if (localTypes.has(param.id)) {
      throw new MiniCoreBlockValidationError(
        `Function ${fn.name} has duplicate local definition %${param.id} in ${context}`,
      );
    }
    localTypes.set(param.id, param.type);
  };

  for (const block of fn.blocks) {
    const blockParams = new Set<number>();
    for (const param of block.params) {
      if (blockParams.has(param.id)) {
        throw new MiniCoreBlockValidationError(
          `Block ${block.label} in ${fn.name} has duplicate block param %${param.id}`,
        );
      }
      blockParams.add(param.id);
      define(param, `block ${block.label}`);
    }

    for (const instruction of block.instructions) {
      if (!instruction.result) {
        if (instruction.resultType.kind !== "unit") {
          throw new MiniCoreBlockValidationError(
            `Instruction in ${fn.name}.${block.label} has non-Unit result without a local`,
          );
        }
        continue;
      }
      if (!miniTypeEquals(instruction.result.type, instruction.resultType)) {
        throw new MiniCoreBlockValidationError(
          `Instruction result %${instruction.result.id} in ${fn.name}.${block.label} has type ${miniTypeToString(
            instruction.result.type,
          )}, but resultType is ${miniTypeToString(instruction.resultType)}`,
        );
      }
      define(instruction.result, `block ${block.label}`);
    }
  }

  return localTypes;
}

function collectPredecessors(
  fn: BlockFunctionDef,
  blocksByLabel: ReadonlyMap<string, Block>,
): Map<string, Set<string>> {
  const predecessorsByLabel = new Map<string, Set<string>>();
  for (const block of fn.blocks) {
    predecessorsByLabel.set(block.label, new Set());
  }

  for (const block of fn.blocks) {
    for (const successor of terminatorSuccessors(block.terminator)) {
      if (!blocksByLabel.has(successor)) {
        continue;
      }
      predecessorsByLabel.get(successor)?.add(block.label);
    }
  }

  return predecessorsByLabel;
}

function terminatorSuccessors(terminator: BlockTerminator): string[] {
  switch (terminator.kind) {
    case "jump":
      return [terminator.target];
    case "branch":
      return [terminator.thenTarget, terminator.elseTarget];
    case "case":
      return terminator.alts.map((alt) => alt.target);
    case "return":
    case "unreachable":
      return [];
  }
}

function collectDominators(
  fn: BlockFunctionDef,
  predecessorsByLabel: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const entryLabel = fn.blocks[0]!.label;
  const allLabels = fn.blocks.map((block) => block.label);
  const dominatorsByLabel = new Map<string, Set<string>>();

  for (const label of allLabels) {
    dominatorsByLabel.set(
      label,
      label === entryLabel ? new Set([label]) : new Set(allLabels),
    );
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const label of allLabels) {
      if (label === entryLabel) {
        continue;
      }

      const predecessors = [...(predecessorsByLabel.get(label) ?? [])];
      const next =
        predecessors.length === 0
          ? new Set<string>()
          : intersectSets(
              predecessors.map(
                (predecessor) =>
                  dominatorsByLabel.get(predecessor) ?? new Set<string>(),
              ),
            );
      next.add(label);

      const previous = dominatorsByLabel.get(label) ?? new Set<string>();
      if (!setsEqual(previous, next)) {
        dominatorsByLabel.set(label, next);
        changed = true;
      }
    }
  }

  return dominatorsByLabel;
}

function collectDominatorLocalIds(
  fn: BlockFunctionDef,
  dominatorsByLabel: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<number>> {
  const localIdsByBlock = new Map<string, Set<number>>();
  for (const block of fn.blocks) {
    const ids = new Set(block.params.map((param) => param.id));
    for (const instruction of block.instructions) {
      if (instruction.result) {
        ids.add(instruction.result.id);
      }
    }
    localIdsByBlock.set(block.label, ids);
  }

  const result = new Map<string, Set<number>>();
  for (const block of fn.blocks) {
    const ids = new Set<number>();
    for (const dominatorLabel of dominatorsByLabel.get(block.label) ?? []) {
      if (dominatorLabel === block.label) {
        continue;
      }
      for (const id of localIdsByBlock.get(dominatorLabel) ?? []) {
        ids.add(id);
      }
    }
    result.set(block.label, ids);
  }
  return result;
}

function intersectSets(sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  if (sets.length === 0) {
    return new Set();
  }

  const first = sets[0]!;
  const rest = sets.slice(1);
  const result = new Set(first);
  for (const candidate of first) {
    if (!rest.every((set) => set.has(candidate))) {
      result.delete(candidate);
    }
  }
  return result;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function validateEntryBlock(fn: BlockFunctionDef): void {
  const entry = fn.blocks[0]!;
  if (entry.params.length !== fn.params.length) {
    throw new MiniCoreBlockValidationError(
      `Entry block for ${fn.name} has ${entry.params.length} params, expected ${fn.params.length}`,
    );
  }

  entry.params.forEach((actual, index) => {
    const expected = fn.params[index]!;
    if (
      actual.id !== expected.id ||
      !miniTypeEquals(actual.type, expected.type)
    ) {
      throw new MiniCoreBlockValidationError(
        `Entry block param ${index} for ${fn.name} does not match function param %${expected.id}`,
      );
    }
  });
}

function validateBlock(block: Block, context: FunctionValidationContext): void {
  const scope = new Set(
    context.dominatorLocalIdsByBlock.get(block.label) ?? [],
  );
  for (const param of block.params) {
    scope.add(param.id);
  }

  for (const instruction of block.instructions) {
    validateInstruction(instruction, block, scope, context);
    if (instruction.result) {
      scope.add(instruction.result.id);
    }
  }

  validateTerminator(block.terminator, block, scope, context);
}

function validateInstruction(
  instruction: BlockInstruction,
  block: Block,
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
): void {
  const location = `${context.fn.name}.${block.label}`;
  const { op } = instruction;

  if (!op || typeof (op as { kind?: unknown }).kind !== "string") {
    throw new MiniCoreBlockValidationError(
      `Instruction in ${location} has malformed op`,
    );
  }

  switch (op.kind) {
    case "move":
      validateValueRef(op.value, scope, context, `move in ${location}`);
      if (instruction.result) {
        assertType(
          op.value.type,
          instruction.resultType,
          `Move result in ${location}`,
        );
      }
      return;
    case "call": {
      const target = requireSymbol(context, op.target, "function", location);
      assertTargetName(op.name, target.name, location);
      const info = context.module.metadata.functions.get(op.target);

      let expectedParams = target.params.map((param) => param.type);
      let expectedResult = target.returnType;

      if (info?.typeScheme && info.typeScheme.kind === "forall") {
        const typeArgs = op.typeArgs ?? [];
        if (typeArgs.length !== info.typeScheme.params.length) {
          throw new MiniCoreBlockValidationError(
            `${op.name} expects ${info.typeScheme.params.length} type arg(s), got ${typeArgs.length}`,
          );
        }
        const subst = new Map<string, MiniType>();
        info.typeScheme.params.forEach((name, i) => {
          subst.set(name, typeArgs[i]!);
        });
        expectedParams = info.paramTypes.map((p) =>
          substituteMiniType(p, subst),
        );
        expectedResult = substituteMiniType(info.resultType, subst);
      }

      validateValueArgs(
        op.args,
        expectedParams,
        scope,
        context,
        `call ${op.name} in ${location}`,
      );
      assertType(
        instruction.resultType,
        expectedResult,
        `Call ${op.name} result in ${location}`,
      );
      return;
    }
    case "prim": {
      const target = requireSymbol(context, op.target, "primitive", location);
      assertTargetName(op.name, target.name, location);
      if (op.args.length !== target.arity) {
        throw new MiniCoreBlockValidationError(
          `Primitive ${op.name} in ${location} has wrong arity: expected ${target.arity}, got ${op.args.length}`,
        );
      }
      const primitiveInfo = context.module.metadata.primitives.get(op.target);
      if (primitiveInfo) {
        let expectedArgs = primitiveInfo.argTypes;
        let expectedResult = primitiveInfo.resultType;

        // Note: primitives currently don't use typeScheme in metadata,
        // but if they did, we would specialized here using op.typeArgs.

        validateValueArgs(
          op.args,
          expectedArgs,
          scope,
          context,
          `primitive ${op.name} in ${location}`,
        );
        assertType(
          instruction.resultType,
          expectedResult,
          `Primitive ${op.name} result in ${location}`,
        );
      } else {
        for (const [index, arg] of op.args.entries()) {
          validateValueRef(
            arg,
            scope,
            context,
            `primitive ${op.name} arg ${index} in ${location}`,
          );
        }
      }
      return;
    }
    case "runtimeCall": {
      const signature = runtimeSignature(op.name);
      validateValueArgs(
        op.args,
        signature.args,
        scope,
        context,
        `runtimeCall ${String(op.name)} in ${location}`,
      );
      assertType(
        instruction.resultType,
        signature.result,
        `Runtime call ${String(op.name)} result in ${location}`,
      );
      return;
    }
    case "construct": {
      const target = requireSymbol(context, op.target, "constructor", location);
      assertTargetName(op.name, target.name, location);
      if (op.args.length !== target.arity) {
        throw new MiniCoreBlockValidationError(
          `Constructor ${op.name} in ${location} has wrong arity: expected ${target.arity}, got ${op.args.length}`,
        );
      }
      const constructorInfo = context.module.metadata.constructors.get(
        op.target,
      );
      if (constructorInfo) {
        let expectedFields = constructorInfo.fieldTypes;
        let expectedResult = constructorInfo.resultType;

        const typeArgs = op.typeArgs ?? [];
        const dataDef = context.module.metadata.dataTypes.get(
          constructorInfo.dataType,
        );
        if (dataDef) {
          if (typeArgs.length !== dataDef.typeParams.length) {
            throw new MiniCoreBlockValidationError(
              `${op.name} expects ${dataDef.typeParams.length} type arg(s), got ${typeArgs.length}`,
            );
          }
          const subst = new Map<string, MiniType>();
          dataDef.typeParams.forEach((name, i) => {
            subst.set(name, typeArgs[i]!);
          });
          expectedFields = constructorInfo.fieldTypes.map((f) =>
            substituteMiniType(f, subst),
          );
          expectedResult = substituteMiniType(
            constructorInfo.resultType,
            subst,
          );
        }

        validateValueArgs(
          op.args,
          expectedFields,
          scope,
          context,
          `construct ${op.name} in ${location}`,
        );
        assertType(
          instruction.resultType,
          expectedResult,
          `Construct ${op.name} result in ${location}`,
        );
      } else {
        for (const [index, arg] of op.args.entries()) {
          validateValueRef(
            arg,
            scope,
            context,
            `construct ${op.name} arg ${index} in ${location}`,
          );
        }
      }
      return;
    }
    default:
      throw new MiniCoreBlockValidationError(
        `Instruction in ${location} has malformed op kind ${(op as { kind: string }).kind}`,
      );
  }
}

function validateTerminator(
  terminator: BlockTerminator,
  block: Block,
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
): void {
  const location = `${context.fn.name}.${block.label}`;
  if (
    !terminator ||
    typeof (terminator as { kind?: unknown }).kind !== "string"
  ) {
    throw new MiniCoreBlockValidationError(
      `Block ${location} has missing or malformed terminator`,
    );
  }

  switch (terminator.kind) {
    case "return":
      validateReturnTerminator(terminator.value, scope, context, location);
      return;
    case "jump":
      validateTargetArgs(
        terminator.target,
        terminator.args,
        scope,
        context,
        `jump from ${location}`,
      );
      return;
    case "branch":
      validateValueRef(
        terminator.condition,
        scope,
        context,
        `branch condition in ${location}`,
      );
      if (terminator.condition.type.kind !== "bool") {
        throw new MiniCoreBlockValidationError(
          `Branch condition in ${location} must be bool, got ${miniTypeToString(
            terminator.condition.type,
          )}`,
        );
      }
      validateTargetArgs(
        terminator.thenTarget,
        terminator.thenArgs,
        scope,
        context,
        `then branch from ${location}`,
      );
      validateTargetArgs(
        terminator.elseTarget,
        terminator.elseArgs,
        scope,
        context,
        `else branch from ${location}`,
      );
      return;
    case "case":
      validateCaseTerminator(terminator, scope, context, location);
      return;
    case "unreachable":
      return;
    default:
      throw new MiniCoreBlockValidationError(
        `Block ${location} has malformed terminator kind ${(terminator as { kind: string }).kind}`,
      );
  }
}

function validateReturnTerminator(
  value: BlockValueRef | undefined,
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
  location: string,
): void {
  if (context.fn.returnType.kind === "unit") {
    if (value) {
      throw new MiniCoreBlockValidationError(
        `Return in ${location} has a value but ${context.fn.name} returns Unit`,
      );
    }
    return;
  }

  if (!value) {
    throw new MiniCoreBlockValidationError(
      `Return in ${location} has no value but ${context.fn.name} returns ${miniTypeToString(
        context.fn.returnType,
      )}`,
    );
  }
  validateValueRef(value, scope, context, `return in ${location}`);
  assertType(value.type, context.fn.returnType, `Return in ${location}`);
}

function validateCaseTerminator(
  terminator: Extract<BlockTerminator, { kind: "case" }>,
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
  location: string,
): void {
  validateValueRef(
    terminator.scrutinee,
    scope,
    context,
    `case scrutinee in ${location}`,
  );

  const seenConstructors = new Set<number>();
  const seenTags = new Set<number>();
  let caseDataType: number | undefined;
  let caseResultType: MiniType | undefined;

  for (const alt of terminator.alts) {
    if (seenConstructors.has(alt.constructor)) {
      throw new MiniCoreBlockValidationError(
        `Duplicate case alternative ${alt.constructorName} in ${location}`,
      );
    }
    seenConstructors.add(alt.constructor);

    const constructor = requireSymbol(
      context,
      alt.constructor,
      "constructor",
      location,
    );
    assertTargetName(alt.constructorName, constructor.name, location);
    if (alt.binders.length !== constructor.arity) {
      throw new MiniCoreBlockValidationError(
        `Case alternative ${alt.constructorName} in ${location} has wrong binder count: expected ${constructor.arity}, got ${alt.binders.length}`,
      );
    }

    const constructorInfo = context.module.metadata.constructors.get(
      alt.constructor,
    );
    if (constructorInfo) {
      if (caseDataType === undefined) {
        caseDataType = constructorInfo.dataType;
        caseResultType = constructorInfo.resultType;
      } else if (caseDataType !== constructorInfo.dataType) {
        throw new MiniCoreBlockValidationError(
          `Case alternative ${alt.constructorName} in ${location} belongs to datatype ${constructorInfo.dataType}, expected ${caseDataType}`,
        );
      }

      if (seenTags.has(constructorInfo.tag)) {
        throw new MiniCoreBlockValidationError(
          `Datatype ${constructorInfo.dataType} has duplicate constructor tag ${constructorInfo.tag} in case at ${location}`,
        );
      }
      seenTags.add(constructorInfo.tag);

      // Use unification to specialize constructor types for the scrutinee
      const subst = new Map<string, MiniType>();
      try {
        miniTypeUnify(
          terminator.scrutinee.type,
          constructorInfo.resultType,
          subst,
        );
      } catch (e) {
        throw new MiniCoreBlockValidationError(
          `Case scrutinee in ${location} type mismatch: expected compatible with ${miniTypeToString(
            constructorInfo.resultType,
          )}, got ${miniTypeToString(terminator.scrutinee.type)}`,
        );
      }

      alt.binders.forEach((binder, index) => {
        const expected = substituteMiniType(
          constructorInfo.fieldTypes[index]!,
          subst,
        );
        assertType(
          binder.type,
          expected,
          `Case binder %${binder.id} for ${alt.constructorName} in ${location}`,
        );
      });
    }

    for (const [index, arg] of alt.args.entries()) {
      validateValueRef(
        arg,
        scope,
        context,
        `case alternative ${alt.constructorName} arg ${index} in ${location}`,
      );
    }

    validateCaseTarget(
      alt.target,
      alt.binders,
      alt.args,
      context,
      `case alternative ${alt.constructorName} from ${location}`,
    );
  }
}
function validateCaseTarget(
  targetLabel: string,
  binders: BlockParam[],
  args: BlockValueRef[],
  context: FunctionValidationContext,
  location: string,
): void {
  const target = context.blocksByLabel.get(targetLabel);
  if (!target) {
    throw new MiniCoreBlockValidationError(
      `${location} targets missing block ${targetLabel}`,
    );
  }

  const expectedLength = binders.length + args.length;
  if (target.params.length !== expectedLength) {
    throw new MiniCoreBlockValidationError(
      `${location} passes ${expectedLength} args to ${targetLabel}, expected ${target.params.length}`,
    );
  }

  binders.forEach((binder, index) => {
    const targetParam = target.params[index]!;
    if (
      targetParam.id !== binder.id ||
      !miniTypeEquals(targetParam.type, binder.type)
    ) {
      throw new MiniCoreBlockValidationError(
        `${location} target ${targetLabel} param ${index} must be binder %${binder.id}`,
      );
    }
  });

  args.forEach((arg, index) => {
    assertType(
      arg.type,
      target.params[binders.length + index]!.type,
      `${location} arg ${binders.length + index} for ${targetLabel}`,
    );
  });
}

function validateTargetArgs(
  targetLabel: string,
  args: BlockValueRef[],
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
  location: string,
): void {
  for (const [index, arg] of args.entries()) {
    validateValueRef(arg, scope, context, `${location} arg ${index}`);
  }
  validateTargetTypes(targetLabel, args, context, location);
}

function validateTargetTypes(
  targetLabel: string,
  args: Array<{ type: MiniType }>,
  context: FunctionValidationContext,
  location: string,
): void {
  const target = context.blocksByLabel.get(targetLabel);
  if (!target) {
    throw new MiniCoreBlockValidationError(
      `${location} targets missing block ${targetLabel}`,
    );
  }
  if (args.length !== target.params.length) {
    throw new MiniCoreBlockValidationError(
      `${location} passes ${args.length} args to ${targetLabel}, expected ${target.params.length}`,
    );
  }

  args.forEach((arg, index) => {
    assertType(
      arg.type,
      target.params[index]!.type,
      `${location} arg ${index} for ${targetLabel}`,
    );
  });
}

function validateValueArgs(
  args: BlockValueRef[],
  expectedTypes: MiniType[],
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
  location: string,
): void {
  if (args.length !== expectedTypes.length) {
    throw new MiniCoreBlockValidationError(
      `${location} has wrong arity: expected ${expectedTypes.length}, got ${args.length}`,
    );
  }

  args.forEach((arg, index) => {
    validateValueRef(arg, scope, context, `${location} arg ${index}`);
    assertType(arg.type, expectedTypes[index]!, `${location} arg ${index}`);
  });
}

function validateValueRef(
  value: BlockValueRef,
  scope: ReadonlySet<number>,
  context: FunctionValidationContext,
  location: string,
): void {
  switch (value.kind) {
    case "literal": {
      const literalType = typeOfLiteral(value.value);
      assertType(value.type, literalType, `${location} literal`);
      return;
    }
    case "local": {
      if (!scope.has(value.id)) {
        throw new MiniCoreBlockValidationError(
          `${location} references local %${value.id} before it is defined in this block`,
        );
      }
      const definedType = context.localTypes.get(value.id);
      if (!definedType) {
        throw new MiniCoreBlockValidationError(
          `${location} references local %${value.id} with no definition`,
        );
      }
      assertType(value.type, definedType, `${location} local %${value.id}`);
      return;
    }
  }
}

function assertType(actual: MiniType, expected: MiniType, context: string) {
  if (!miniTypeEquals(actual, expected)) {
    throw new MiniCoreBlockValidationError(
      `${context} type mismatch: expected ${miniTypeToString(
        expected,
      )}, got ${miniTypeToString(actual)}`,
    );
  }
}

function assertTargetName(actual: string, expected: string, location: string) {
  if (actual !== expected) {
    throw new MiniCoreBlockValidationError(
      `Target name mismatch in ${location}: expected ${expected}, got ${actual}`,
    );
  }
}

function requireSymbol<K extends BlockSymbolDef["kind"]>(
  context: FunctionValidationContext,
  id: SymbolId,
  kind: K,
  location: string,
): Extract<BlockSymbolDef, { kind: K }> {
  const symbol = context.symbolsById.get(id);
  if (!symbol || symbol.kind !== kind) {
    throw new MiniCoreBlockValidationError(
      `Symbol ${id} in ${location} is not a ${kind}`,
    );
  }
  return symbol as Extract<BlockSymbolDef, { kind: K }>;
}

function runtimeSignature(
  name: Parameters<typeof getRuntimeSymbolSignature>[0],
) {
  try {
    return getRuntimeSymbolSignature(name);
  } catch {
    throw new MiniCoreBlockValidationError(
      `Unknown Trip runtime symbol ${String(name)}`,
    );
  }
}
