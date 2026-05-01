import type {
  Block,
  BlockFunctionDef,
  BlockModule,
  BlockTerminator,
  BlockValueRef,
  MiniType,
} from "../../minicore/index.ts";
import { miniTypeEquals, miniTypeToString } from "../../minicore/index.ts";
import { validateBlockModule } from "../../minicore/validateBlock.ts";
import {
  isLlvmV0ReturnType,
  isLlvmV0ValueType,
  lowerLlvmValueType,
} from "./lowerTypes.ts";
import { llvmFunctionName, llvmLabelName } from "./llvmNames.ts";
import { lookupLlvmV0Primitive, rejectedLlvmV0Primitive } from "./types.ts";

export class LlvmV0ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlvmV0ValidationError";
  }
}

export interface LlvmIncomingEdge {
  predecessor: string;
  target: string;
  args: BlockValueRef[];
}

export type LlvmIncomingEdges = ReadonlyMap<
  string,
  readonly LlvmIncomingEdge[]
>;

export function validateLlvmV0(module: BlockModule): void {
  validateBlockModule(module);
  validateGeneratedFunctionNames(module);

  for (const symbol of module.symbols) {
    if (symbol.kind === "function") {
      validateFunction(symbol);
    }
  }
}

export function analyzeLlvmIncomingEdges(
  fn: BlockFunctionDef,
): LlvmIncomingEdges {
  const incoming = new Map<string, LlvmIncomingEdge[]>();
  const seen = new Map<string, LlvmIncomingEdge>();

  const record = (
    predecessor: string,
    target: string,
    args: BlockValueRef[],
  ) => {
    const key = `${predecessor}\0${target}`;
    const previous = seen.get(key);
    if (previous) {
      if (!sameArgs(previous.args, args)) {
        throw new LlvmV0ValidationError(
          `LLVM-v0 unsupported: duplicate predecessor-to-target edge ${predecessor} -> ${target} has different args`,
        );
      }
      return;
    }

    const edge = { predecessor, target, args };
    seen.set(key, edge);
    const targetIncoming = incoming.get(target) ?? [];
    targetIncoming.push(edge);
    incoming.set(target, targetIncoming);
  };

  for (const block of fn.blocks) {
    const terminator = block.terminator;
    switch (terminator.kind) {
      case "jump":
        record(block.label, terminator.target, terminator.args);
        break;
      case "branch":
        record(block.label, terminator.thenTarget, terminator.thenArgs);
        record(block.label, terminator.elseTarget, terminator.elseArgs);
        break;
      case "return":
      case "case":
      case "unreachable":
        break;
    }
  }

  return incoming;
}

function validateGeneratedFunctionNames(module: BlockModule): void {
  const seen = new Map<string, string>();
  for (const symbol of module.symbols) {
    if (symbol.kind !== "function") continue;
    const name = llvmFunctionName(symbol.name);
    const previous = seen.get(name);
    if (previous) {
      throw new LlvmV0ValidationError(
        `LLVM-v0 generated function name collision: ${previous} and ${symbol.name} both lower to ${name}`,
      );
    }
    seen.set(name, symbol.name);
  }
}

function validateFunction(fn: BlockFunctionDef): void {
  validateReturnType(fn.returnType, `return type of ${fn.name}`);
  for (const param of fn.params) {
    validateValueType(param.type, `function param %${param.id} of ${fn.name}`);
  }

  validateGeneratedLabels(fn);

  for (const block of fn.blocks) {
    for (const param of block.params) {
      validateValueType(param.type, `block param %${param.id} of ${fn.name}`);
    }
    validateInstructions(fn, block);
    validateTerminator(fn, block);
  }

  const incoming = analyzeLlvmIncomingEdges(fn);
  const entryIncoming = incoming.get(fn.blocks[0]!.label) ?? [];
  if (entryIncoming.length > 0) {
    throw new LlvmV0ValidationError(
      `LLVM-v0 unsupported: entry block ${fn.blocks[0]!.label} has predecessors`,
    );
  }

  fn.blocks.forEach((block, index) => {
    if (index > 0 && block.params.length > 0) {
      const edges = incoming.get(block.label) ?? [];
      if (edges.length === 0) {
        throw new LlvmV0ValidationError(
          `LLVM-v0 unsupported: block ${block.label} has params but no incoming edge`,
        );
      }
    }
  });
}

function validateGeneratedLabels(fn: BlockFunctionDef): void {
  const seen = new Map<string, string>();
  for (const block of fn.blocks) {
    const name = llvmLabelName(block.label);
    const previous = seen.get(name);
    if (previous) {
      throw new LlvmV0ValidationError(
        `LLVM-v0 generated label collision in ${fn.name}: ${previous} and ${block.label} both lower to ${name}`,
      );
    }
    seen.set(name, block.label);
  }
}

function validateInstructions(fn: BlockFunctionDef, block: Block): void {
  const location = `${fn.name}.${block.label}`;
  for (const instruction of block.instructions) {
    if (instruction.op.kind === "construct") {
      throw new LlvmV0ValidationError(
        "LLVM-v0 unsupported: construct requires representation lowering",
      );
    }

    if (instruction.result) {
      validateValueType(
        instruction.result.type,
        `instruction result %${instruction.result.id} in ${location}`,
      );
    } else if (
      instruction.op.kind !== "call" &&
      instruction.op.kind !== "runtimeCall"
    ) {
      if (instruction.op.kind === "move") {
        throw new LlvmV0ValidationError(
          "LLVM-v0 unsupported: move without result",
        );
      }
      throw new LlvmV0ValidationError(
        `LLVM-v0 unsupported: resultless ${instruction.op.kind} instruction in ${location}`,
      );
    }

    switch (instruction.op.kind) {
      case "move":
        validateValueRef(instruction.op.value, `move operand in ${location}`);
        break;
      case "call":
        instruction.op.args.forEach((arg, index) =>
          validateValueRef(arg, `call arg ${index} in ${location}`),
        );
        if (instruction.resultType.kind === "unit" && instruction.result) {
          throw new LlvmV0ValidationError(
            `LLVM-v0 unsupported: first-class Unit local %${instruction.result.id}`,
          );
        }
        break;
      case "runtimeCall":
        instruction.op.args.forEach((arg, index) =>
          validateValueRef(arg, `runtimeCall arg ${index} in ${location}`),
        );
        if (instruction.resultType.kind === "unit" && instruction.result) {
          throw new LlvmV0ValidationError(
            `LLVM-v0 unsupported: first-class Unit local %${instruction.result.id}`,
          );
        }
        break;
      case "prim": {
        const op = instruction.op;
        op.args.forEach((arg, index) =>
          validateValueRef(arg, `primitive arg ${index} in ${location}`),
        );
        const rejected = rejectedLlvmV0Primitive(op.name);
        if (rejected) {
          throw new LlvmV0ValidationError(`LLVM-v0 unsupported: ${rejected}`);
        }
        const primitive = lookupLlvmV0Primitive(op.name);
        if (!primitive) {
          throw new LlvmV0ValidationError(
            `LLVM-v0 unsupported primitive: ${op.name}`,
          );
        }
        if (instruction.resultType.kind === "unit") {
          throw new LlvmV0ValidationError(
            `LLVM-v0 unsupported: primitive ${op.name} has Unit result`,
          );
        }
        op.args.forEach((arg, index) => {
          const actual = lowerLlvmValueType(arg.type);
          if (actual !== primitive.argType) {
            throw new LlvmV0ValidationError(
              `LLVM-v0 primitive ${op.name} arg ${index} in ${location} lowers to ${actual}, expected ${primitive.argType}`,
            );
          }
        });
        const actualResult = lowerLlvmValueType(instruction.resultType);
        if (actualResult !== primitive.resultType) {
          throw new LlvmV0ValidationError(
            `LLVM-v0 primitive ${op.name} result in ${location} lowers to ${actualResult}, expected ${primitive.resultType}`,
          );
        }
        break;
      }
    }
  }
}

function validateTerminator(fn: BlockFunctionDef, block: Block): void {
  const location = `${fn.name}.${block.label}`;
  const terminator: BlockTerminator = block.terminator;
  switch (terminator.kind) {
    case "case":
      throw new LlvmV0ValidationError(
        "LLVM-v0 unsupported: high-level ADT case requires representation lowering",
      );
    case "unreachable":
      throw new LlvmV0ValidationError(
        `LLVM-v0 unsupported: unreachable terminator in ${location}`,
      );
    case "return":
      if (terminator.value) {
        validateValueRef(terminator.value, `return value in ${location}`);
      }
      return;
    case "jump":
      terminator.args.forEach((arg, index) =>
        validateValueRef(arg, `jump arg ${index} in ${location}`),
      );
      return;
    case "branch":
      validateValueRef(terminator.condition, `branch condition in ${location}`);
      terminator.thenArgs.forEach((arg, index) =>
        validateValueRef(arg, `then branch arg ${index} in ${location}`),
      );
      terminator.elseArgs.forEach((arg, index) =>
        validateValueRef(arg, `else branch arg ${index} in ${location}`),
      );
      return;
  }
}

function validateReturnType(type: MiniType, context: string): void {
  if (!isLlvmV0ReturnType(type)) {
    throw new LlvmV0ValidationError(
      `LLVM-v0 unsupported type in ${context}: ${miniTypeToString(type)}`,
    );
  }
}

function validateValueType(type: MiniType, context: string): void {
  if (type.kind === "unit") {
    throw new LlvmV0ValidationError(
      `LLVM-v0 unsupported: first-class Unit value in ${context}`,
    );
  }
  if (!isLlvmV0ValueType(type)) {
    throw new LlvmV0ValidationError(
      `LLVM-v0 unsupported type in ${context}: ${miniTypeToString(type)}`,
    );
  }
}

function validateValueRef(value: BlockValueRef, context: string): void {
  validateValueType(value.type, context);
  if (value.kind === "literal" && value.value.kind !== "u8") {
    throw new LlvmV0ValidationError(
      `LLVM-v0 unsupported literal in ${context}: ${value.value.kind}`,
    );
  }
}

function sameArgs(a: BlockValueRef[], b: BlockValueRef[]): boolean {
  return (
    a.length === b.length &&
    a.every((left, index) => sameValueRef(left, b[index]!))
  );
}

function sameValueRef(a: BlockValueRef, b: BlockValueRef): boolean {
  if (!miniTypeEquals(a.type, b.type) || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "local":
      return b.kind === "local" && a.id === b.id;
    case "literal":
      return (
        b.kind === "literal" &&
        a.value.kind === b.value.kind &&
        a.value.value === b.value.value
      );
  }
}
