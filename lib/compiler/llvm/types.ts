export type LlvmScalarType = "i1" | "i8";
export type LlvmValueType = LlvmScalarType | "i64" | "ptr";
export type LlvmReturnType = LlvmValueType | "void";

/* node:coverage disable */
export type LlvmTargetProfile =
  | { kind: "generic" }
  | { kind: "arm64-apple-darwin" }
  | { kind: "x86_64-unknown-linux-gnu" }
  | { kind: "x86_64-pc-windows-msvc" };

export interface EmitLlvmOptions {
  target?: LlvmTargetProfile;
  representation?: LlvmRepresentation;
  emitMainWrapper?: boolean;
}
/* node:coverage enable */

export type LlvmRepresentation = "scalar-v0" | "boxed-runtime";
/* node:coverage enable */

export type LlvmV0PrimitiveKind = "addU8" | "subU8" | "eqU8" | "ltU8";
export type LlvmV0RejectedPrimitiveKind = "divU8" | "modU8";

export interface LlvmV0Primitive {
  kind: LlvmV0PrimitiveKind;
  argType: "i8";
  resultType: LlvmScalarType;
  instruction: "add" | "sub" | "icmp";
  predicate?: "eq" | "ult";
}

const SUPPORTED_PRIMITIVES: ReadonlyMap<string, LlvmV0Primitive> = new Map([
  [
    "addU8",
    {
      kind: "addU8",
      argType: "i8",
      resultType: "i8",
      instruction: "add",
    },
  ],
  [
    "subU8",
    {
      kind: "subU8",
      argType: "i8",
      resultType: "i8",
      instruction: "sub",
    },
  ],
  [
    "eqU8",
    {
      kind: "eqU8",
      argType: "i8",
      resultType: "i1",
      instruction: "icmp",
      predicate: "eq",
    },
  ],
  [
    "ltU8",
    {
      kind: "ltU8",
      argType: "i8",
      resultType: "i1",
      instruction: "icmp",
      predicate: "ult",
    },
  ],
]);

export function lookupLlvmV0Primitive(
  name: string,
): LlvmV0Primitive | undefined {
  const canonical = canonicalPrimitiveName(name);
  return canonical ? SUPPORTED_PRIMITIVES.get(canonical) : undefined;
}

export function rejectedLlvmV0Primitive(
  name: string,
): LlvmV0RejectedPrimitiveKind | undefined {
  const canonical = canonicalPrimitiveName(name);
  return canonical === "divU8" || canonical === "modU8" ? canonical : undefined;
}

function canonicalPrimitiveName(
  name: string,
): LlvmV0PrimitiveKind | LlvmV0RejectedPrimitiveKind | undefined {
  switch (name) {
    case "Prelude.addU8":
    case "addU8":
      return "addU8";
    case "Prelude.subU8":
    case "subU8":
      return "subU8";
    case "Prelude.eqU8":
    case "eqU8":
      return "eqU8";
    case "Prelude.ltU8":
    case "ltU8":
      return "ltU8";
    case "Prelude.divU8":
    case "divU8":
      return "divU8";
    case "Prelude.modU8":
    case "modU8":
      return "modU8";
    default:
      return undefined;
  }
}
