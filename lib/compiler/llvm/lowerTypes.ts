import { miniTypeToString, type MiniType } from "../../minicore/index.ts";
import type { LlvmReturnType, LlvmScalarType } from "./types.ts";

export class LlvmTypeLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlvmTypeLoweringError";
  }
}

export function lowerLlvmReturnType(type: MiniType): LlvmReturnType {
  switch (type.kind) {
    case "u8":
      return "i8";
    case "bool":
      return "i1";
    case "unit":
      return "void";
    default:
      throw unsupportedType(type);
  }
}

export function lowerLlvmValueType(type: MiniType): LlvmScalarType {
  switch (type.kind) {
    case "u8":
      return "i8";
    case "bool":
      return "i1";
    default:
      throw unsupportedType(type);
  }
}

export function isLlvmV0ReturnType(type: MiniType): boolean {
  return type.kind === "u8" || type.kind === "bool" || type.kind === "unit";
}

export function isLlvmV0ValueType(type: MiniType): boolean {
  return type.kind === "u8" || type.kind === "bool";
}

function unsupportedType(type: MiniType): LlvmTypeLoweringError {
  return new LlvmTypeLoweringError(
    `LLVM-v0 unsupported type: ${miniTypeToString(type)}`,
  );
}
