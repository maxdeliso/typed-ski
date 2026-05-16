import type {
  Block,
  BlockCaseAlt,
  BlockFunctionDef,
  BlockInstruction,
  BlockModule,
  BlockTerminator,
  BlockValueRef,
  MiniType,
  RuntimeSymbol,
  SymbolId,
} from "../../minicore/index.ts";
import { validateBlockModule } from "../../minicore/validateBlock.ts";
import { lowerLlvmReturnType, lowerLlvmValueType } from "./lowerTypes.ts";
import {
  llvmFunctionName,
  llvmLabelName,
  llvmLabelRef,
  llvmLocalName,
  llvmRuntimeName,
  sanitizeLlvmIdentifier,
} from "./llvmNames.ts";
import { LlvmWriter } from "./printLlvm.ts";
import {
  collectRuntimeSymbols,
  printRuntimeDeclaration,
} from "./runtimeAbi.ts";
import type {
  EmitLlvmOptions,
  LlvmMainWrapper,
  LlvmRepresentation,
  LlvmTargetProfile,
  LlvmValueType,
} from "./types.ts";
import { lookupLlvmV0Primitive } from "./types.ts";
import {
  analyzeLlvmIncomingEdges,
  validateLlvmV0,
  type LlvmIncomingEdges,
} from "./validateLlvmV0.ts";

export class LlvmEmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlvmEmissionError";
  }
}

interface ModuleEmitContext {
  functionNames: ReadonlyMap<SymbolId, string>;
  module: BlockModule;
  representation: LlvmRepresentation;
}

interface FunctionEmitContext extends ModuleEmitContext {
  aliases: ReadonlyMap<number, BlockValueRef>;
  incoming: ReadonlyMap<string, readonly EmitIncomingEdge[]>;
  caseUnpacks: ReadonlyMap<string, readonly CaseUnpackBlock[]>;
  expectedReturnType: MiniType;
  runtimePointers: ReadonlyMap<RuntimeSymbol, string>;
}

type IncomingValue =
  | BlockValueRef
  | { kind: "llvm"; type: MiniType; rendered: string };

interface EmitIncomingEdge {
  predecessor: string;
  target: string;
  args: IncomingValue[];
}

interface CaseUnpackBlock {
  source: string;
  label: string;
  scrutinee: BlockValueRef;
  alt: BlockCaseAlt;
  fieldValues: Array<{ param: MiniType; rawName: string; valueName: string }>;
}

export function emitLlvmModule(
  module: BlockModule,
  options: EmitLlvmOptions = {},
): string {
  const representation = options.representation ?? "scalar-v0";
  if (representation === "scalar-v0") {
    validateLlvmV0(module);
  } else {
    validateBlockModule(module);
  }

  const writer = new LlvmWriter();
  const target = options.target ?? { kind: "generic" };
  const mainWrapper = options.mainWrapper ?? legacyMainWrapper(options);
  emitTargetTriple(writer, target);

  const runtimeSymbols = collectRuntimeSymbols(module);
  for (const symbol of runtimeSymbols) {
    writer.line(printRuntimeDeclaration(symbol));
  }
  if (representation === "boxed-runtime" && needsObjectRuntime(module)) {
    writer.line("declare noalias ptr @trip_alloc_obj(i64, i64) nounwind");
    writer.line("declare void @trip_obj_set_field(ptr, i64, i64) nounwind");
    writer.line("declare i64 @trip_obj_tag(ptr) nounwind readonly willreturn");
    writer.line(
      "declare i64 @trip_obj_field(ptr, i64) nounwind readonly willreturn",
    );
  }
  if (mainWrapper?.kind === "stdin-list-u8") {
    writer.line("declare noalias ptr @trip_read_stdin_list_u8() nounwind");
  }
  if (
    runtimeSymbols.length > 0 ||
    (representation === "boxed-runtime" && needsObjectRuntime(module))
  ) {
    writer.blank();
  } else if (mainWrapper?.kind === "stdin-list-u8") {
    writer.blank();
  }

  const context: ModuleEmitContext = {
    functionNames: collectFunctionNames(module),
    module,
    representation,
  };
  const functions = module.symbols.filter(
    (symbol): symbol is BlockFunctionDef => symbol.kind === "function",
  );
  functions.forEach((fn, index) => {
    if (index > 0) writer.blank();
    emitFunction(writer, fn, context);
  });
  if (mainWrapper) {
    writer.blank();
    emitMainWrapper(writer, module, context, mainWrapper);
  }

  return writer.toString();
}

function legacyMainWrapper(
  options: EmitLlvmOptions,
): LlvmMainWrapper | undefined {
  return options.emitMainWrapper ? { kind: "c-main" } : undefined;
}
function needsObjectRuntime(module: BlockModule): boolean {
  return module.symbols.some(
    (symbol) =>
      symbol.kind === "function" &&
      symbol.blocks.some(
        (block) =>
          block.instructions.some(
            (instruction) => instruction.op.kind === "construct",
          ) || block.terminator.kind === "case",
      ),
  );
}

function emitTargetTriple(writer: LlvmWriter, target: LlvmTargetProfile): void {
  switch (target.kind) {
    case "generic":
      return;
    case "arm64-apple-darwin":
    case "x86_64-unknown-linux-gnu":
    case "x86_64-pc-windows-msvc":
      writer.line(`target triple = "${target.kind}"`);
      writer.blank();
      return;
  }
}

function collectFunctionNames(module: BlockModule): Map<SymbolId, string> {
  const names = new Map<SymbolId, string>();
  for (const symbol of module.symbols) {
    if (symbol.kind === "function") {
      names.set(symbol.id, llvmFunctionName(symbol.name));
    }
  }
  return names;
}

function emitMainWrapper(
  writer: LlvmWriter,
  module: BlockModule,
  context: ModuleEmitContext,
  wrapper: LlvmMainWrapper,
): void {
  const entry = module.symbols.find(
    (symbol): symbol is BlockFunctionDef =>
      symbol.kind === "function" && symbol.id === module.entry,
  );
  if (!entry) {
    throw new LlvmEmissionError("Cannot emit C main wrapper without an entry");
  }

  const entryName = context.functionNames.get(entry.id);
  /* node:coverage ignore next 3 */
  if (!entryName) {
    throw new LlvmEmissionError(`Cannot emit C main wrapper for ${entry.name}`);
  }

  const entryReturnType = lowerLlvmReturnType(entry.returnType);
  writer.line("define i32 @main() {");
  writer.line("entry:");
  switch (wrapper.kind) {
    case "c-main":
      if (entry.params.length !== 0) {
        throw new LlvmEmissionError(
          `Cannot emit C main wrapper for parameterized entry ${entry.name}`,
        );
      }
      if (entryReturnType === "void") {
        writer.indented(`call void ${entryName}()`);
        writer.indented("ret i32 0");
      } else if (entryReturnType === "i8") {
        writer.indented(`%trip_result = call i8 ${entryName}()`);
        writer.indented("%exit_code = zext i8 %trip_result to i32");
        writer.indented("ret i32 %exit_code");
      } else if (entryReturnType === "i1") {
        writer.indented(`%trip_result = call i1 ${entryName}()`);
        writer.indented("%exit_code = zext i1 %trip_result to i32");
        writer.indented("ret i32 %exit_code");
      } else if (entryReturnType === "i64") {
        writer.indented(`%trip_result = call i64 ${entryName}()`);
        writer.indented("%exit_code = trunc i64 %trip_result to i32");
        writer.indented("ret i32 %exit_code");
      } else {
        writer.indented(
          `%trip_result = call ${entryReturnType} ${entryName}()`,
        );
        writer.indented("ret i32 0");
      }
      break;
    case "stdin-list-u8": {
      if (entry.params.length !== 1) {
        throw new LlvmEmissionError(
          `Cannot emit stdin List U8 main wrapper for ${entry.name} with ${entry.params.length} parameter(s)`,
        );
      }
      const [param] = entry.params;
      const entryParamType = lowerLlvmValueType(param!.type);
      writer.indented("%trip_source = call ptr @trip_read_stdin_list_u8()");
      if (entryReturnType === "void") {
        writer.indented(
          `call void ${entryName}(${entryParamType} %trip_source)`,
        );
      } else {
        writer.indented(
          `%trip_result = call ${entryReturnType} ${entryName}(${entryParamType} %trip_source)`,
        );
      }
      writer.indented("ret i32 0");
      break;
    }
  }
  writer.line("}");
}

function emitFunction(
  writer: LlvmWriter,
  fn: BlockFunctionDef,
  moduleContext: ModuleEmitContext,
): void {
  const controlFlow = analyzeEmitControlFlow(fn, moduleContext);

  const runtimeUsage = new Map<RuntimeSymbol, number>();
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op.kind === "runtimeCall") {
        const name = instruction.op.name as RuntimeSymbol;
        runtimeUsage.set(name, (runtimeUsage.get(name) ?? 0) + 1);
      }
    }
  }

  const runtimePointers = new Map<RuntimeSymbol, string>();
  const context: FunctionEmitContext = {
    ...moduleContext,
    aliases: collectMoveAliases(fn),
    incoming: controlFlow.incoming,
    caseUnpacks: controlFlow.caseUnpacks,
    expectedReturnType: fn.returnType,
    runtimePointers,
  };

  const params = fn.params
    .map(
      (param) => `${lowerLlvmValueType(param.type)} ${llvmLocalName(param.id)}`,
    )
    .join(", ");
  writer.line(
    `define ${lowerLlvmReturnType(
      fn.returnType,
    )} ${llvmFunctionName(fn.name)}(${params}) local_unnamed_addr nounwind {`,
  );

  // Emit runtime pointer aliases for frequently used functions to enable 2-byte calls
  runtimeUsage.forEach((count, name) => {
    if (count > 2) {
      const ptrName = `%rt_ptr_${sanitizeLlvmIdentifier(name)}`;
      runtimePointers.set(name, ptrName);
    }
  });

  fn.blocks.forEach((block, index) => {
    emitBlock(writer, block, index === 0, context);
  });

  writer.line("}");
}

function analyzeEmitControlFlow(
  fn: BlockFunctionDef,
  context: ModuleEmitContext,
): {
  incoming: ReadonlyMap<string, readonly EmitIncomingEdge[]>;
  caseUnpacks: ReadonlyMap<string, readonly CaseUnpackBlock[]>;
} {
  if (context.representation === "scalar-v0") {
    return {
      incoming: new Map(
        [...analyzeLlvmIncomingEdges(fn)].map(([target, edges]) => [
          target,
          edges.map((edge) => ({ ...edge, args: [...edge.args] })),
        ]),
      ),
      caseUnpacks: new Map(),
    };
  }

  const incoming = new Map<string, EmitIncomingEdge[]>();
  const caseUnpacks = new Map<string, CaseUnpackBlock[]>();

  const record = (
    predecessor: string,
    target: string,
    args: IncomingValue[],
  ) => {
    const targetIncoming = incoming.get(target) ?? [];
    targetIncoming.push({ predecessor, target, args });
    incoming.set(target, targetIncoming);
  };

  for (const block of fn.blocks) {
    const terminator = block.terminator;
    switch (terminator.kind) {
      case "jump":
        record(block.label, terminator.target, [...terminator.args]);
        break;
      case "branch":
        record(block.label, terminator.thenTarget, [...terminator.thenArgs]);
        record(block.label, terminator.elseTarget, [...terminator.elseArgs]);
        break;
      case "case": {
        const unpackBlocks: CaseUnpackBlock[] = [];
        terminator.alts.forEach((alt, index) => {
          const label = `${block.label}_case_${index}_${labelSuffix(
            alt.constructorName,
          )}`;
          const fieldValues = alt.binders.map((binder, fieldIndex) => {
            const prefix = sanitizeLlvmIdentifier(
              `${label}_field${fieldIndex}`,
            );
            return {
              param: binder.type,
              rawName: `%${prefix}_raw`,
              valueName: `%${prefix}`,
            };
          });
          unpackBlocks.push({
            source: block.label,
            label,
            scrutinee: terminator.scrutinee,
            alt,
            fieldValues,
          });
          record(label, alt.target, [
            ...alt.binders.map((binder, fieldIndex) => ({
              kind: "llvm" as const,
              type: binder.type,
              rendered: fieldValues[fieldIndex]!.valueName,
            })),
            ...alt.args,
          ]);
        });
        caseUnpacks.set(block.label, unpackBlocks);
        break;
      }
      case "return":
      case "unreachable":
        break;
    }
  }

  return { incoming, caseUnpacks };
}

function collectMoveAliases(fn: BlockFunctionDef): Map<number, BlockValueRef> {
  const aliases = new Map<number, BlockValueRef>();
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op.kind === "move" && instruction.result) {
        aliases.set(instruction.result.id, instruction.op.value);
      }
    }
  }
  return aliases;
}

function emitBlock(
  writer: LlvmWriter,
  block: Block,
  isEntry: boolean,
  context: FunctionEmitContext,
): void {
  writer.line(`${llvmLabelName(block.label)}:`);
  if (!isEntry) {
    emitPhiNodes(writer, block, context);
  }

  if (isEntry) {
    context.runtimePointers.forEach((ptrName, symbol) => {
      writer.indented(
        `${ptrName} = bitcast ptr ${llvmRuntimeName(symbol)} to ptr`,
      );
    });
  }

  for (const instruction of block.instructions) {
    const emitted = emitInstruction(instruction, context);
    if (emitted) {
      emitIndentedLines(writer, emitted);
    }
  }

  emitIndentedLines(writer, emitTerminator(block, context));
  emitCaseUnpackBlocks(writer, block.label, context);
  emitCaseUnreachableBlock(writer, block, context);
}

function emitCaseUnreachableBlock(
  writer: LlvmWriter,
  block: Block,
  context: FunctionEmitContext,
): void {
  if (block.terminator.kind !== "case") return;
  if (context.representation !== "boxed-runtime") return;
  const unreachableLabel = `${block.label}_case_unreachable`;
  writer.line(`${llvmLabelName(unreachableLabel)}:`);
  writer.indented("unreachable");
}

function emitIndentedLines(writer: LlvmWriter, lines: string | string[]): void {
  if (Array.isArray(lines)) {
    lines.forEach((line) => writer.indented(line));
    return;
  }
  writer.indented(lines);
}

function emitPhiNodes(
  writer: LlvmWriter,
  block: Block,
  context: FunctionEmitContext,
): void {
  if (block.params.length === 0) return;
  const incoming = context.incoming.get(block.label) ?? [];
  for (const [paramIndex, param] of block.params.entries()) {
    const type = lowerLlvmValueType(param.type);
    const values = incoming
      .map((edge) => {
        const value = formatIncomingValue(edge.args[paramIndex]!, context);
        return `[ ${value}, ${llvmLabelRef(edge.predecessor)} ]`;
      })
      .join(", ");
    writer.indented(`${llvmLocalName(param.id)} = phi ${type} ${values}`);
  }
}

function emitInstruction(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string | string[] | undefined {
  switch (instruction.op.kind) {
    case "move":
      return undefined;
    case "prim":
      return emitPrimitive(instruction, context);
    case "call":
      return emitCall(
        instruction,
        context.functionNames.get(instruction.op.target),
        instruction.op.args,
        context,
      );
    case "runtimeCall":
      return emitRuntimeCall(instruction, context);
    case "construct":
      return emitConstruct(instruction, context);
  }
}

function emitPrimitive(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string | string[] {
  if (instruction.op.kind !== "prim") {
    throw new LlvmEmissionError("emitPrimitive called for non-primitive op");
  }
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit primitive ${instruction.op.name} without result`,
    );
  }
  if (context.representation === "boxed-runtime") {
    const boxed = emitBoxedPrimitive(instruction, context);
    if (boxed) return boxed;
  }
  const primitive = lookupLlvmV0Primitive(instruction.op.name);
  if (!primitive) {
    throw new LlvmEmissionError(
      `LLVM-v0 unsupported primitive: ${instruction.op.name}`,
    );
  }
  const [left, right] = instruction.op.args;
  if (!left || !right) {
    throw new LlvmEmissionError(
      `Primitive ${instruction.op.name} expected two args`,
    );
  }
  const result = llvmLocalName(instruction.result.id);
  const lhs = formatValue(left, context);
  const rhs = formatValue(right, context);
  if (primitive.instruction === "icmp") {
    return `${result} = icmp ${primitive.predicate} ${primitive.argType} ${lhs}, ${rhs}`;
  }
  return `${result} = ${primitive.instruction} ${primitive.argType} ${lhs}, ${rhs}`;
}

function emitBoxedPrimitive(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string | string[] | undefined {
  if (instruction.op.kind !== "prim") return undefined;
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit primitive ${instruction.op.name} without result`,
    );
  }
  const result = llvmLocalName(instruction.result.id);
  const [left, right] = instruction.op.args;
  const lhs = left ? formatValue(left, context) : undefined;
  const rhs = right ? formatValue(right, context) : undefined;
  const lhsType = left ? lowerLlvmValueType(left.type) : undefined;
  const rhsType = right ? lowerLlvmValueType(right.type) : undefined;

  const ensureI64 = (
    val: string,
    type: LlvmValueType | undefined,
    prefix: string,
  ): { val: string; lines: string[] } => {
    if (type === "i64") return { val, lines: [] };
    if (type === "ptr") {
      const casted = `%${sanitizeLlvmIdentifier(`${prefix}_as_i64`)}`;
      return { val: casted, lines: [`${casted} = ptrtoint ptr ${val} to i64`] };
    }
    return { val, lines: [] };
  };

  switch (instruction.op.name) {
    case "Nat.succ": {
      requireArgs(instruction.op.name, lhs);
      const cast = ensureI64(lhs!, lhsType, `${result}_lhs`);
      return [...cast.lines, `${result} = add i64 ${cast.val}, 1`];
    }
    case "Nat.add": {
      requireArgs(instruction.op.name, lhs, rhs);
      const castL = ensureI64(lhs!, lhsType, `${result}_lhs`);
      const castR = ensureI64(rhs!, rhsType, `${result}_rhs`);
      return [
        ...castL.lines,
        ...castR.lines,
        `${result} = add i64 ${castL.val}, ${castR.val}`,
      ];
    }
    case "Nat.mul": {
      requireArgs(instruction.op.name, lhs, rhs);
      const castL = ensureI64(lhs!, lhsType, `${result}_lhs`);
      const castR = ensureI64(rhs!, rhsType, `${result}_rhs`);
      return [
        ...castL.lines,
        ...castR.lines,
        `${result} = mul i64 ${castL.val}, ${castR.val}`,
      ];
    }
    case "Nat.lte": {
      requireArgs(instruction.op.name, lhs, rhs);
      const castL = ensureI64(lhs!, lhsType, `${result}_lhs`);
      const castR = ensureI64(rhs!, rhsType, `${result}_rhs`);
      return [
        ...castL.lines,
        ...castR.lines,
        `${result} = icmp ule i64 ${castL.val}, ${castR.val}`,
      ];
    }
    case "Prelude.not":
      requireArgs(instruction.op.name, lhs);
      return `${result} = xor i1 ${lhs}, true`;
    case "Prelude.eqU8":
    case "eqU8":
      requireArgs(instruction.op.name, lhs, rhs);
      return `${result} = icmp eq i8 ${lhs}, ${rhs}`;
    case "Prelude.ltU8":
    case "ltU8":
      requireArgs(instruction.op.name, lhs, rhs);
      return `${result} = icmp ult i8 ${lhs}, ${rhs}`;
    case "Prelude.addU8":
    case "addU8":
      requireArgs(instruction.op.name, lhs, rhs);
      return `${result} = add i8 ${lhs}, ${rhs}`;
    case "Prelude.subU8":
    case "subU8":
      requireArgs(instruction.op.name, lhs, rhs);
      return `${result} = sub i8 ${lhs}, ${rhs}`;
    case "Prelude.divU8":
    case "divU8": {
      requireArgs(instruction.op.name, lhs, rhs);
      const zero = `${result}_div_zero`;
      const safeRhs = `${result}_div_rhs`;
      const raw = `${result}_div_raw`;
      return [
        `${zero} = icmp eq i8 ${rhs}, 0`,
        `${safeRhs} = select i1 ${zero}, i8 1, i8 ${rhs}`,
        `${raw} = udiv i8 ${lhs}, ${safeRhs}`,
        `${result} = select i1 ${zero}, i8 0, i8 ${raw}`,
      ];
    }
    case "Prelude.modU8":
    case "modU8": {
      requireArgs(instruction.op.name, lhs, rhs);
      const zero = `${result}_mod_zero`;
      const safeRhs = `${result}_mod_rhs`;
      const raw = `${result}_mod_raw`;
      return [
        `${zero} = icmp eq i8 ${rhs}, 0`,
        `${safeRhs} = select i1 ${zero}, i8 1, i8 ${rhs}`,
        `${raw} = urem i8 ${lhs}, ${safeRhs}`,
        `${result} = select i1 ${zero}, i8 0, i8 ${raw}`,
      ];
    }
    case "Prelude.error": {
      const type = lowerLlvmReturnType(instruction.resultType);
      const lines: string[] = [];
      if (type !== "void") {
        if (type === "ptr") {
          lines.push(`${result} = inttoptr i64 0 to ptr`);
        } else {
          lines.push(`${result} = add ${type} 0, 0`);
        }
      }
      return lines;
    }
    default:
      return undefined;
  }
}

function requireArgs(name: string, ...args: Array<string | undefined>): void {
  if (args.some((arg) => arg === undefined)) {
    throw new LlvmEmissionError(`Primitive ${name} expected more args`);
  }
}

function emitConstruct(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string[] {
  if (instruction.op.kind !== "construct") {
    throw new LlvmEmissionError("emitConstruct called for non-construct op");
  }
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit constructor ${instruction.op.name} without result`,
    );
  }
  const op = instruction.op;
  if (context.representation !== "boxed-runtime") {
    throw new LlvmEmissionError(
      "LLVM-v0 unsupported: construct requires representation lowering",
    );
  }

  const bool = context.module.metadata.bool;
  if (bool?.falseConstructor === op.target) {
    return [`${llvmLocalName(instruction.result.id)} = icmp eq i8 0, 1`];
  }
  if (bool?.trueConstructor === op.target) {
    return [`${llvmLocalName(instruction.result.id)} = icmp eq i8 0, 0`];
  }

  const constructor = context.module.symbols.find(
    (symbol) => symbol.kind === "constructor" && symbol.id === op.target,
  );
  if (!constructor || constructor.kind !== "constructor") {
    throw new LlvmEmissionError(
      `Cannot emit constructor ${instruction.op.name}: missing symbol`,
    );
  }

  const result = llvmLocalName(instruction.result.id);
  const lines = [
    `${result} = call ptr @trip_alloc_obj(i64 ${constructor.tag}, i64 ${constructor.arity})`,
  ];
  instruction.op.args.forEach((arg, index) => {
    const word = wordFromValue(arg, `${result}_field${index}`, context);
    lines.push(...word.lines);
    lines.push(
      `call void @trip_obj_set_field(ptr ${result}, i64 ${index}, i64 ${word.value})`,
    );
  });
  return lines;
}

function emitCall(
  instruction: BlockInstruction,
  targetName: string | undefined,
  args: BlockValueRef[],
  context: FunctionEmitContext,
): string {
  if (instruction.op.kind !== "call") {
    throw new LlvmEmissionError("emitCall called for non-call op");
  }
  if (!targetName) {
    throw new LlvmEmissionError("Cannot emit call to unknown function");
  }
  const resultType = lowerLlvmReturnType(instruction.resultType);
  const renderedArgs = args
    .map((arg) => formatTypedValue(arg, context))
    .join(", ");
  const tail = instruction.op.isTail ? "tail " : "";
  if (resultType === "void") {
    return `${tail}call void ${targetName}(${renderedArgs})`;
  }
  if (!instruction.result) {
    throw new LlvmEmissionError("Cannot emit non-void call without result");
  }
  return `${llvmLocalName(
    instruction.result.id,
  )} = ${tail}call ${resultType} ${targetName}(${renderedArgs})`;
}

function emitRuntimeCall(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string {
  if (instruction.op.kind !== "runtimeCall") {
    throw new LlvmEmissionError("emitRuntimeCall called for non-runtime op");
  }
  const resultType = lowerLlvmReturnType(instruction.resultType);
  const renderedArgs = instruction.op.args
    .map((arg) => formatTypedValue(arg, context))
    .join(", ");

  const name = instruction.op.name as RuntimeSymbol;
  const cachedPtr = context.runtimePointers.get(name);
  const runtimeName = cachedPtr ?? llvmRuntimeName(name);

  const tail = instruction.op.isTail ? "tail " : "";
  if (resultType === "void") {
    return `${tail}call void ${runtimeName}(${renderedArgs})`;
  }
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit non-void runtime call ${instruction.op.name} without result`,
    );
  }
  return `${llvmLocalName(
    instruction.result.id,
  )} = ${tail}call ${resultType} ${runtimeName}(${renderedArgs})`;
}

function emitTerminator(
  block: Block,
  context: FunctionEmitContext,
): string | string[] {
  const terminator: BlockTerminator = block.terminator;
  switch (terminator.kind) {
    case "return":
      if (!terminator.value) {
        return "ret void";
      }
      const val = formatValue(terminator.value, context);
      const actualType = lowerLlvmValueType(terminator.value.type);
      const expectedType = lowerLlvmReturnType(context.expectedReturnType);
      if (actualType === expectedType) {
        return `ret ${actualType} ${val}`;
      }
      if (actualType === "ptr" && expectedType === "i64") {
        const casted = `%${sanitizeLlvmIdentifier(`${block.label}_ret_ptr_to_i64`)}`;
        return [`${casted} = ptrtoint ptr ${val} to i64`, `ret i64 ${casted}`];
      }
      if (actualType === "i64" && expectedType === "ptr") {
        const casted = `%${sanitizeLlvmIdentifier(`${block.label}_ret_i64_to_ptr`)}`;
        return [`${casted} = inttoptr i64 ${val} to ptr`, `ret ptr ${casted}`];
      }
      return `ret ${actualType} ${val}`;
    case "jump":
      return `br label ${llvmLabelRef(terminator.target)}`;
    case "branch":
      return `br ${formatTypedValue(
        terminator.condition,
        context,
      )}, label ${llvmLabelRef(terminator.thenTarget)}, label ${llvmLabelRef(
        terminator.elseTarget,
      )}`;
    case "unreachable":
      return "unreachable";
    case "case":
      return emitCaseTerminator(block, terminator, context);
  }
}

function emitCaseTerminator(
  block: Block,
  terminator: Extract<BlockTerminator, { kind: "case" }>,
  context: FunctionEmitContext,
): string[] {
  if (context.representation !== "boxed-runtime") {
    throw new LlvmEmissionError(
      "LLVM-v0 unsupported: high-level ADT case requires representation lowering",
    );
  }

  // NOTE: Bool cases should NEVER reach this function. The fromAnf lowering stage
  // converts Bool cases to branch instructions (br i1) via boolBranchTargets().
  // If a Bool case somehow reached here, it would generate incorrect LLVM code:
  // `call i64 @trip_obj_tag(ptr %scrutinee)` where %scrutinee is i1, not ptr.
  // This would fail at LLVM verification time. The invariant is maintained by
  // fromAnf's boolBranchTargets() lowering Bool cases with 2 alts, 0-binder case,
  // matching Bool type, to branch instructions instead of case terminators.

  const tagName = `%${sanitizeLlvmIdentifier(`${block.label}_case_tag`)}`;
  const scrutinee = formatValue(terminator.scrutinee, context);
  const unpacks = context.caseUnpacks.get(block.label) ?? [];
  if (unpacks.length === 0) {
    throw new LlvmEmissionError(
      `Missing case unpack blocks for ${block.label}`,
    );
  }
  const unreachableLabel = `${block.label}_case_unreachable`;
  const switchLines = [
    `${tagName} = call i64 @trip_obj_tag(ptr ${scrutinee})`,
    `switch i64 ${tagName}, label ${llvmLabelRef(unreachableLabel)} [`,
  ];
  for (const unpack of unpacks) {
    switchLines.push(
      `  i64 ${constructorTag(context.module, unpack.alt.constructor)}, label ${llvmLabelRef(
        unpack.label,
      )}`,
    );
  }
  switchLines.push("]");
  return switchLines;
}

function emitCaseUnpackBlocks(
  writer: LlvmWriter,
  sourceLabel: string,
  context: FunctionEmitContext,
): void {
  const unpacks = context.caseUnpacks.get(sourceLabel) ?? [];
  for (const unpack of unpacks) {
    writer.line(`${llvmLabelName(unpack.label)}:`);
    unpack.fieldValues.forEach((field, index) => {
      const rawName = field.rawName;
      writer.indented(
        `${rawName} = call i64 @trip_obj_field(ptr ${formatValue(
          unpack.scrutinee,
          context,
        )}, i64 ${index})`,
      );

      const targetType = lowerLlvmValueType(field.param);
      if (targetType === "i64") {
        writer.indented(`${field.valueName} = add i64 ${rawName}, 0`);
      } else {
        const converted = valueFromWord(rawName, field.valueName, field.param);
        converted.forEach((line) => writer.indented(line));
      }
    });
    writer.indented(`br label ${llvmLabelRef(unpack.alt.target)}`);
  }
}

function formatTypedValue(
  value: BlockValueRef,
  context: FunctionEmitContext,
): string {
  return `${lowerLlvmValueType(value.type)} ${formatValue(value, context)}`;
}

function formatIncomingValue(
  value: IncomingValue,
  context: FunctionEmitContext,
): string {
  return value.kind === "llvm" ? value.rendered : formatValue(value, context);
}

function wordFromValue(
  value: BlockValueRef,
  prefix: string,
  context: FunctionEmitContext,
): { lines: string[]; value: string } {
  const rendered = formatValue(value, context);
  const type = lowerLlvmValueType(value.type);
  const word = `%${sanitizeLlvmIdentifier(`${prefix}_word`)}`;
  switch (type) {
    case "i64":
      return { lines: [], value: rendered };
    case "i8":
    case "i1":
      return {
        lines: [`${word} = zext ${type} ${rendered} to i64`],
        value: word,
      };
    case "ptr":
      return {
        lines: [`${word} = ptrtoint ptr ${rendered} to i64`],
        value: word,
      };
  }
}

function valueFromWord(
  rawName: string,
  valueName: string,
  type: MiniType,
): string[] {
  const targetType = lowerLlvmValueType(type);
  switch (targetType) {
    case "i64":
      return [`${valueName} = add i64 ${rawName}, 0`];
    case "i8":
      return [`${valueName} = trunc i64 ${rawName} to i8`];
    case "i1":
      return [`${valueName} = trunc i64 ${rawName} to i1`];
    case "ptr":
      return [`${valueName} = inttoptr i64 ${rawName} to ptr`];
  }
}

function constructorTag(module: BlockModule, constructorId: SymbolId): number {
  const symbol = module.symbols.find(
    (candidate) =>
      candidate.kind === "constructor" && candidate.id === constructorId,
  );
  if (!symbol || symbol.kind !== "constructor") {
    throw new LlvmEmissionError(`Missing constructor symbol ${constructorId}`);
  }
  return symbol.tag;
}

function formatValue(
  value: BlockValueRef,
  context: FunctionEmitContext,
  resolving: ReadonlySet<number> = new Set(),
): string {
  switch (value.kind) {
    case "literal":
      return formatLiteral(value);
    case "local": {
      const alias = context.aliases.get(value.id);
      if (alias) {
        if (resolving.has(value.id)) {
          throw new LlvmEmissionError(
            `Cyclic move alias for local %${value.id}`,
          );
        }
        return formatValue(alias, context, new Set([...resolving, value.id]));
      }
      return llvmLocalName(value.id);
    }
  }
}

function formatLiteral(value: Extract<BlockValueRef, { kind: "literal" }>) {
  switch (value.value.kind) {
    case "u8":
      return String(value.value.value);
    case "nat":
      return String(value.value.value);
  }
}

function labelSuffix(name: string): string {
  return name
    .split(".")
    .at(-1)!
    .replace(/[^A-Za-z0-9_]/g, "_");
}
