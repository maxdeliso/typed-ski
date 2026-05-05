import type {
  Block,
  BlockFunctionDef,
  BlockInstruction,
  BlockModule,
  BlockTerminator,
  BlockValueRef,
  RuntimeSymbol,
  SymbolId,
} from "../../minicore/index.ts";
import { lowerLlvmReturnType, lowerLlvmValueType } from "./lowerTypes.ts";
import {
  llvmFunctionName,
  llvmLabelName,
  llvmLabelRef,
  llvmLocalName,
  llvmRuntimeName,
} from "./llvmNames.ts";
import { LlvmWriter } from "./printLlvm.ts";
import {
  collectRuntimeSymbols,
  printRuntimeDeclaration,
} from "./runtimeAbi.ts";
import type { EmitLlvmOptions, LlvmTargetProfile } from "./types.ts";
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
}

interface FunctionEmitContext extends ModuleEmitContext {
  aliases: ReadonlyMap<number, BlockValueRef>;
  incoming: LlvmIncomingEdges;
}

export function emitLlvmModule(
  module: BlockModule,
  options: EmitLlvmOptions = {},
): string {
  validateLlvmV0(module);

  const writer = new LlvmWriter();
  const target = options.target ?? { kind: "generic" };
  emitTargetTriple(writer, target);

  const runtimeSymbols = collectRuntimeSymbols(module);
  for (const symbol of runtimeSymbols) {
    writer.line(printRuntimeDeclaration(symbol));
  }
  if (runtimeSymbols.length > 0) {
    writer.blank();
  }

  const context: ModuleEmitContext = {
    functionNames: collectFunctionNames(module),
  };
  const functions = module.symbols.filter(
    (symbol): symbol is BlockFunctionDef => symbol.kind === "function",
  );
  functions.forEach((fn, index) => {
    if (index > 0) writer.blank();
    emitFunction(writer, fn, context);
  });
  if (options.emitMainWrapper) {
    writer.blank();
    emitMainWrapper(writer, module, context);
  }

  return writer.toString();
}

function emitTargetTriple(writer: LlvmWriter, target: LlvmTargetProfile): void {
  switch (target.kind) {
    case "generic":
      return;
    case "x86_64-unknown-linux-gnu":
    case "x86_64-pc-windows-msvc":
    case "wasm32-unknown-unknown":
    case "wasm32-wasi":
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
): void {
  const entry = module.symbols.find(
    (symbol): symbol is BlockFunctionDef =>
      symbol.kind === "function" && symbol.id === module.entry,
  );
  if (!entry) {
    throw new LlvmEmissionError("Cannot emit C main wrapper without an entry");
  }
  if (entry.params.length !== 0) {
    throw new LlvmEmissionError(
      `Cannot emit C main wrapper for parameterized entry ${entry.name}`,
    );
  }

  const entryName = context.functionNames.get(entry.id);
  if (!entryName) {
    throw new LlvmEmissionError(`Cannot emit C main wrapper for ${entry.name}`);
  }

  const entryReturnType = lowerLlvmReturnType(entry.returnType);
  writer.line("define i32 @main() {");
  writer.line("entry:");
  if (entryReturnType === "void") {
    writer.indented(`call void ${entryName}()`);
  } else {
    writer.indented(`%trip_result = call ${entryReturnType} ${entryName}()`);
  }
  writer.indented("ret i32 0");
  writer.line("}");
}

function emitFunction(
  writer: LlvmWriter,
  fn: BlockFunctionDef,
  moduleContext: ModuleEmitContext,
): void {
  const context: FunctionEmitContext = {
    ...moduleContext,
    aliases: collectMoveAliases(fn),
    incoming: analyzeLlvmIncomingEdges(fn),
  };
  const params = fn.params
    .map(
      (param) => `${lowerLlvmValueType(param.type)} ${llvmLocalName(param.id)}`,
    )
    .join(", ");
  writer.line(
    `define ${lowerLlvmReturnType(fn.returnType)} ${llvmFunctionName(
      fn.name,
    )}(${params}) {`,
  );

  fn.blocks.forEach((block, index) => {
    emitBlock(writer, block, index === 0, context);
  });

  writer.line("}");
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

  for (const instruction of block.instructions) {
    const emitted = emitInstruction(instruction, context);
    if (emitted) {
      writer.indented(emitted);
    }
  }

  writer.indented(emitTerminator(block.terminator, context));
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
        const value = formatValue(edge.args[paramIndex]!, context);
        return `[ ${value}, ${llvmLabelRef(edge.predecessor)} ]`;
      })
      .join(", ");
    writer.indented(`${llvmLocalName(param.id)} = phi ${type} ${values}`);
  }
}

function emitInstruction(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string | undefined {
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
      throw new LlvmEmissionError(
        "LLVM-v0 unsupported: construct requires representation lowering",
      );
  }
}

function emitPrimitive(
  instruction: BlockInstruction,
  context: FunctionEmitContext,
): string {
  if (instruction.op.kind !== "prim") {
    throw new LlvmEmissionError("emitPrimitive called for non-primitive op");
  }
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit primitive ${instruction.op.name} without result`,
    );
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

function emitCall(
  instruction: BlockInstruction,
  targetName: string | undefined,
  args: BlockValueRef[],
  context: FunctionEmitContext,
): string {
  if (!targetName) {
    throw new LlvmEmissionError("Cannot emit call to unknown function");
  }
  const resultType = lowerLlvmReturnType(instruction.resultType);
  const renderedArgs = args
    .map((arg) => formatTypedValue(arg, context))
    .join(", ");
  if (resultType === "void") {
    return `call void ${targetName}(${renderedArgs})`;
  }
  if (!instruction.result) {
    throw new LlvmEmissionError("Cannot emit non-void call without result");
  }
  return `${llvmLocalName(
    instruction.result.id,
  )} = call ${resultType} ${targetName}(${renderedArgs})`;
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
  const runtimeName = llvmRuntimeName(instruction.op.name as RuntimeSymbol);
  if (resultType === "void") {
    return `call void ${runtimeName}(${renderedArgs})`;
  }
  if (!instruction.result) {
    throw new LlvmEmissionError(
      `Cannot emit non-void runtime call ${instruction.op.name} without result`,
    );
  }
  return `${llvmLocalName(
    instruction.result.id,
  )} = call ${resultType} ${runtimeName}(${renderedArgs})`;
}

function emitTerminator(
  terminator: BlockTerminator,
  context: FunctionEmitContext,
): string {
  switch (terminator.kind) {
    case "return":
      if (!terminator.value) {
        return "ret void";
      }
      return `ret ${lowerLlvmValueType(terminator.value.type)} ${formatValue(
        terminator.value,
        context,
      )}`;
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
      throw new LlvmEmissionError(
        "LLVM-v0 unsupported: high-level ADT case requires representation lowering",
      );
  }
}

function formatTypedValue(
  value: BlockValueRef,
  context: FunctionEmitContext,
): string {
  return `${lowerLlvmValueType(value.type)} ${formatValue(value, context)}`;
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
      throw new LlvmEmissionError("LLVM-v0 unsupported literal: nat");
  }
}
