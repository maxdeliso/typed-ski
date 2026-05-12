import type { BlockModule, RuntimeSymbol } from "../../minicore/index.ts";
import { getRuntimeSymbolSignature } from "../../minicore/index.ts";
import { lowerLlvmReturnType, lowerLlvmValueType } from "./lowerTypes.ts";
import { llvmRuntimeName } from "./llvmNames.ts";
import type { LlvmReturnType, LlvmValueType } from "./types.ts";

export interface LlvmRuntimeSignature {
  name: RuntimeSymbol;
  args: LlvmValueType[];
  result: LlvmReturnType;
}

export function lowerRuntimeSignature(
  name: RuntimeSymbol,
): LlvmRuntimeSignature {
  const signature = getRuntimeSymbolSignature(name);
  return {
    name,
    args: signature.args.map(lowerLlvmValueType),
    result: lowerLlvmReturnType(signature.result),
  };
}

export function collectRuntimeSymbols(module: BlockModule): RuntimeSymbol[] {
  const names = new Set<RuntimeSymbol>();
  for (const symbol of module.symbols) {
    if (symbol.kind !== "function") continue;
    for (const block of symbol.blocks) {
      for (const instruction of block.instructions) {
        if (instruction.op.kind === "runtimeCall") {
          names.add(instruction.op.name);
        }
      }
    }
  }
  return [...names].sort();
}

export function printRuntimeDeclaration(name: RuntimeSymbol): string {
  const signature = lowerRuntimeSignature(name);
  const rawSignature = getRuntimeSymbolSignature(name);
  const args = signature.args.join(", ");
  const attributes: string[] = ["nounwind"];

  if (rawSignature.effects === "pure") {
    attributes.push("readnone", "willreturn");
  }

  const attrStr = attributes.length > 0 ? ` #${name}_attrs` : "";
  const directAttrs = attributes.join(" ");
  return `declare ${signature.result} ${llvmRuntimeName(name)}(${args}) ${directAttrs}`;
}
