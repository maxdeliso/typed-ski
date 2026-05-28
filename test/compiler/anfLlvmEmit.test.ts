/**
 * Stage-0 verification of the .trip ANF -> LLVM emitter (anfLlvm.trip).
 *
 * Runs `AnfLlvm.compileSourceToLlvmText` under the TypeScript MiniCore
 * evaluator on a small straight-line `U8` corpus (params, let-bindings,
 * and direct known-symbol calls) and asserts the emitted LLVM text. This
 * is the minimal slice of the ANF->LLVM tail: no constructors, cases,
 * inner lambdas, or runtime primitives yet.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";

const MODULE_NAMES = [
  "Prelude",
  "Nat",
  "Bin",
  "Avl",
  "Lexer",
  "Parser",
  "Core",
  "DataEnv",
  "CoreToLower",
  "Unparse",
  "Lowering",
  "Bridge",
  "CoreToMini",
  "MiniCore",
  "Anf",
  "AnfLlvm",
] as const;

/** Decodes a Scott/ADT-encoded `List U8` MiniCore value to a byte array. */
function valueToBytes(value: Value): number[] {
  const bytes: number[] = [];
  let cur: Value = value;
  while (cur.kind === "con" && cur.fields.length === 2) {
    const head = cur.fields[0];
    const tail = cur.fields[1];
    if (head === undefined || tail === undefined || head.kind !== "lit") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    const literal = head.value;
    if (literal.kind !== "u8") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    bytes.push(literal.value);
    cur = tail;
  }
  if (cur.kind !== "con" || cur.fields.length !== 0) {
    throw new Error(`expected nil terminator, got ${JSON.stringify(cur)}`);
  }
  return bytes;
}

const DEMO_SOURCE = `module Demo
export konst
export main
poly konst = \\x : U8 => \\y : U8 => x
poly main = \\z : U8 => konst (konst z z) z
`;

const EXPECTED_LLVM = `define i8 @konst(i8 %x, i8 %y) {
entry:
  ret i8 %x
}

define i8 @main(i8 %z) {
entry:
  %__ll0 = call i8 @konst(i8 %z, i8 %z)
  %__ll1 = call i8 @konst(i8 %__ll0, i8 %z)
  ret i8 %__ll1
}

`;

describe("ANF -> LLVM emitter (.trip)", () => {
  it("emits LLVM for the straight-line U8 subset (params, lets, calls)", async () => {
    const modules: Array<{ name: string; source: string }> = await Promise.all(
      MODULE_NAMES.map(async (name) => ({
        name,
        source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
      })),
    );
    modules.push({
      name: "Verify",
      source: `module Verify
import Prelude List
import Prelude U8
import AnfLlvm compileSourceToLlvmText

export main

poly main = compileSourceToLlvmText ${JSON.stringify(DEMO_SOURCE)}
`,
    });

    const program = compileMiniCoreModules(modules, "Verify");
    const result = evaluateMiniCore(program);
    const actual = Buffer.from(valueToBytes(result.value)).toString("utf8");

    assert.equal(actual, EXPECTED_LLVM);
  });
});
