import type { BlockLabel } from "../../minicore/index.ts";

export function llvmFunctionName(name: string): string {
  return `@trip_fn_${sanitizeLlvmIdentifier(name)}`;
}

export function llvmRuntimeName(name: string): string {
  return `@${sanitizeLlvmIdentifier(name)}`;
}

export function llvmLocalName(id: number): string {
  return `%v${id}`;
}

export function llvmLabelName(label: BlockLabel): string {
  return sanitizeLlvmIdentifier(label);
}

export function llvmLabelRef(label: BlockLabel): string {
  return `%${llvmLabelName(label)}`;
}

export function sanitizeLlvmIdentifier(input: string): string {
  const sanitized = input.replace(/[^A-Za-z0-9_]/g, "_");
  const nonEmpty = sanitized.length === 0 ? "x" : sanitized;
  return /^[A-Za-z_]/.test(nonEmpty) ? nonEmpty : `_${nonEmpty}`;
}
