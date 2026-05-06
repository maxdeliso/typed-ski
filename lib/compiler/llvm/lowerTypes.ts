import { miniTypeToString, type MiniType } from "../../minicore/index.ts";
import type { LlvmReturnType, LlvmValueType } from "./types.ts";

export class LlvmTypeLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlvmTypeLoweringError";
  }
}

export function lowerLlvmReturnType(type: MiniType): LlvmReturnType {
  if (type.kind === "unit") {
    return "void";
  }
  return lowerLlvmValueType(type);
}

export function lowerLlvmValueType(type: MiniType): LlvmValueType {
  switch (type.kind) {
    case "u8":
      return "i8";
    case "bool":
      return "i1";
    case "nat":
      return "i64";
    case "data":
    // Boxed-runtime placeholder: non-scalar values are represented as ptr.
    // Function values are not first-class closures yet; this only supports values
    // that are already lowered away or treated opaquely.
    case "fn":
    case "forall":
    case "var":
    case "unknown":
      return "ptr";
    case "unit":
      throw unsupportedType(type);
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
