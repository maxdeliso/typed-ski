/**
 * Stage-0 verification of the .trip ANF -> LLVM emitter (anfLlvm.trip).
 *
 * Runs `AnfLlvm.compileSourceToLlvmText` under the TypeScript MiniCore
 * evaluator on a small `U8` corpus (params, let-bindings, direct
 * known-symbol calls, the read/write runtime primitives, and nullary
 * constructors emitted as their i8 tag) and asserts the emitted LLVM
 * text. Constructors with fields, cases, and inner lambdas are not yet
 * supported by the emitter.
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

/**
 * Runs `AnfLlvm.compileSourceToLlvmText` on `source` under the host MiniCore
 * evaluator and returns the emitted LLVM text.
 */
async function compileSourceToLlvm(source: string): Promise<string> {
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

poly main = compileSourceToLlvmText ${JSON.stringify(source)}
`,
  });

  const program = compileMiniCoreModules(modules, "Verify");
  const result = evaluateMiniCore(program);
  return Buffer.from(valueToBytes(result.value)).toString("utf8");
}

/** Wraps a function body as `module Demo` with `main` taking U8 params `names`. */
function demoMain(names: readonly string[], body: string): string {
  const binders = names.map((n) => `\\${n} : U8 => `).join("");
  return `module Demo
export main
poly main = ${binders}${body}
`;
}

describe("ANF -> LLVM emitter (.trip)", () => {
  it("emits LLVM for the straight-line U8 subset (params, lets, calls)", async () => {
    assert.equal(await compileSourceToLlvm(DEMO_SOURCE), EXPECTED_LLVM);
  });

  it("emits inline LLVM for U8 literals and arithmetic/comparison primitives", async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [
        "byte literal",
        `module Demo
export main
poly main = #u8(7)
`,
        `define i8 @main() {
entry:
  ret i8 7
}

`,
      ],
      [
        "addU8",
        demoMain(["a", "b"], "addU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0 = add i8 %a, %b
  ret i8 %__ll0
}

`,
      ],
      [
        "subU8",
        demoMain(["a", "b"], "subU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0 = sub i8 %a, %b
  ret i8 %__ll0
}

`,
      ],
      [
        "divU8 (guards divide-by-zero)",
        demoMain(["a", "b"], "divU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0_zero = icmp eq i8 %b, 0
  %__ll0_safe = select i1 %__ll0_zero, i8 1, i8 %b
  %__ll0_raw = udiv i8 %a, %__ll0_safe
  %__ll0 = select i1 %__ll0_zero, i8 0, i8 %__ll0_raw
  ret i8 %__ll0
}

`,
      ],
      [
        "modU8 (guards divide-by-zero)",
        demoMain(["a", "b"], "modU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0_zero = icmp eq i8 %b, 0
  %__ll0_safe = select i1 %__ll0_zero, i8 1, i8 %b
  %__ll0_raw = urem i8 %a, %__ll0_safe
  %__ll0 = select i1 %__ll0_zero, i8 0, i8 %__ll0_raw
  ret i8 %__ll0
}

`,
      ],
      [
        "eqU8 (zext i1 result to i8)",
        demoMain(["a", "b"], "eqU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0_c = icmp eq i8 %a, %b
  %__ll0 = zext i1 %__ll0_c to i8
  ret i8 %__ll0
}

`,
      ],
      [
        "ltU8 (zext i1 result to i8)",
        demoMain(["a", "b"], "ltU8 a b"),
        `define i8 @main(i8 %a, i8 %b) {
entry:
  %__ll0_c = icmp ult i8 %a, %b
  %__ll0 = zext i1 %__ll0_c to i8
  ret i8 %__ll0
}

`,
      ],
      [
        "byte literal as an operand",
        demoMain(["a"], "addU8 a #u8(1)"),
        `define i8 @main(i8 %a) {
entry:
  %__ll0 = add i8 %a, 1
  ret i8 %__ll0
}

`,
      ],
      [
        "nested arithmetic threads SSA temps through a let",
        demoMain(["a", "b", "c"], "addU8 (addU8 a b) c"),
        `define i8 @main(i8 %a, i8 %b, i8 %c) {
entry:
  %__ll0 = add i8 %a, %b
  %__ll1 = add i8 %__ll0, %c
  ret i8 %__ll1
}

`,
      ],
      [
        "writeOne compilation",
        `module Demo
import Prelude writeOne
export main
poly main = \\a : U8 => writeOne a [U8] (\\u : U8 => a)
`,
        `declare void @trip_write_one(i8)
declare i8 @trip_read_one()

define i8 @main(i8 %a) {
entry:
  call void @trip_write_one(i8 %a)
  ret i8 %a
}

`,
      ],
      [
        "readOne compilation",
        `module Demo
import Prelude readOne
export main
poly main = \\u : U8 => readOne [U8] (\\b : U8 => b)
`,
        `declare void @trip_write_one(i8)
declare i8 @trip_read_one()

define i8 @main(i8 %u) {
entry:
  %__ll0 = call i8 @trip_read_one()
  ret i8 %__ll0
}

`,
      ],
      [
        "nullary constructor emits its i8 tag (first arm = 0)",
        `module Demo
data Color = | Red | Green | Blue
export main
poly main = Red
`,
        `define i8 @main() {
entry:
  ret i8 0
}

`,
      ],
      [
        "declaration order drives the tag (middle arm = 1)",
        `module Demo
data Color = | Red | Green | Blue
export main
poly main = Green
`,
        `define i8 @main() {
entry:
  ret i8 1
}

`,
      ],
      [
        "match on a nullary enum lowers to switch + alloca/store/load",
        `module Demo
data Color = | Red | Green | Blue
export main
poly main = \\c : Color => match c [U8] { | Red => #u8(10) | Green => #u8(20) | Blue => #u8(30) }
`,
        `define i8 @main(i8 %c) {
entry:
  %__case0.slot = alloca i8
  switch i8 %c, label %__case0.default [
    i8 0, label %__case0.arm0
    i8 1, label %__case0.arm1
    i8 2, label %__case0.arm2
  ]
__case0.arm0:
  store i8 10, ptr %__case0.slot
  br label %__case0.end
__case0.arm1:
  store i8 20, ptr %__case0.slot
  br label %__case0.end
__case0.arm2:
  store i8 30, ptr %__case0.slot
  br label %__case0.end
__case0.default:
  unreachable
__case0.end:
  %__case0.result = load i8, ptr %__case0.slot
  ret i8 %__case0.result
}

`,
      ],
    ];

    for (const [label, source, expected] of cases) {
      assert.equal(await compileSourceToLlvm(source), expected, label);
    }
  });
});
