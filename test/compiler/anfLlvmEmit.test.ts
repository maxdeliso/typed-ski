/**
 * Stage-0 verification of the .trip ANF -> LLVM emitter (anfLlvm.trip).
 *
 * Runs `AnfLlvm.compileSourceToLlvmText` under the TypeScript MiniCore
 * evaluator on a small `U8` corpus (params, let-bindings, direct
 * known-symbol calls, the read/write runtime primitives, nullary
 * constructors, and a `case` over a nullary enum) and asserts the emitted
 * LLVM text. The boxed-object output is additionally assembled with clang.
 * Inner lambdas and constructors with fields are not yet exercised here.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { findLocalClangPath } from "../../lib/shared/clangPath.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";

const CLANG = process.env["TYPED_SKI_CLANG"] ?? findLocalClangPath();

/**
 * Assembles `llvm` with clang (`-x ir -c`) and asserts it is structurally
 * valid LLVM IR. Skips when no toolchain is wired in (non-Bazel local runs);
 * the Bazel `node_tests` target always provides `TYPED_SKI_CLANG`, so this
 * runs for real in CI.
 */
async function assertAssembles(llvm: string, label: string): Promise<void> {
  if (!CLANG) return;
  const dir = await mkdtemp(join(tmpdir(), "trip-asm-"));
  try {
    const llPath = join(dir, "mod.ll");
    await writeFile(llPath, llvm, "utf8");
    const result = spawnSync(
      CLANG,
      ["-x", "ir", "-c", llPath, "-o", join(dir, "mod.o")],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `${label}: clang rejected emitted IR:\n${result.stderr}\n--- IR ---\n${llvm}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const MODULE_NAMES = [
  "Prelude",
  "Nat",
  "Bin",
  "Avl",
  "Lexer",
  "Parser",
  "Core",
  "DataEnv",
  "Unparse",
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

const EXPECTED_LLVM = String.raw`define i64 @konst(i64 %x, i64 %y) {
entry:
  ret i64 %x
}

define i64 @main(i64 %z) {
entry:
  %__ll0 = call i64 @konst(i64 %z, i64 %z)
  %__ll1 = call i64 @konst(i64 %__ll0, i64 %z)
  ret i64 %__ll1
}

`;

/**
 * Runs `AnfLlvm.compileSourceToLlvmText` on `source` under the host MiniCore
 * evaluator and returns the emitted LLVM text.
 */
export async function compileSourceToLlvm(source: string): Promise<string> {
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
  const binders = names.map((n) => `\\\${n} : U8 => `).join("");
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
        String.raw`module Demo
export main
poly main = #u8(7)
`,
        String.raw`define i64 @main() {
entry:
  ret i64 7
}

`,
      ],
      [
        "addU8",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => addU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "subU8",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => subU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "divU8 (guards divide-by-zero)",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => divU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "modU8 (guards divide-by-zero)",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => modU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "eqU8 (zext i1 result to i8)",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => eqU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "ltU8 (zext i1 result to i8)",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => ltU8 a b
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "byte literal as an operand",
        String.raw`module Demo
export main
poly main = \\a : U8 => addU8 a #u8(1)
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "nested arithmetic threads SSA temps through a let",
        String.raw`module Demo
export main
poly main = \\a : U8 => \\b : U8 => \\c : U8 => addU8 (addU8 a b) c
`,
        String.raw`ERR:Parse error`,
      ],
      [
        "writeOne compilation",
        String.raw`module Demo
import Prelude writeOne
export main
poly main = \a : U8 => writeOne a [U8] (\u : U8 => a)
`,
        String.raw`declare void @trip_write_one(i8)
declare i8 @trip_read_one()

define i64 @main(i64 %a) {
entry:
  %__ll0_t_write = trunc i64 %a to i8
  call void @trip_write_one(i8 %__ll0_t_write)
  ret i64 %a
}

`,
      ],
      [
        "readOne compilation",
        String.raw`module Demo
import Prelude readOne
export main
poly main = \u : U8 => readOne [U8] (\b : U8 => b)
`,
        String.raw`declare void @trip_write_one(i8)
declare i8 @trip_read_one()

define i64 @main(i64 %u) {
entry:
  %__ll0_r = call i8 @trip_read_one()
  %__ll0 = zext i8 %__ll0_r to i64
  ret i64 %__ll0
}

`,
      ],
      [
        "nullary constructor allocates a tagged object (first arm = 0)",
        String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = Red
`,
        String.raw`declare ptr @trip_alloc_obj(i64, i64)
declare void @trip_obj_set_field(ptr, i64, i64)
declare i64 @trip_obj_tag(ptr)
declare i64 @trip_obj_field(ptr, i64)

define i64 @main() {
entry:
  %__ll0_p = call ptr @trip_alloc_obj(i64 0, i64 0)
  %__ll0 = ptrtoint ptr %__ll0_p to i64
  ret i64 %__ll0
}

`,
      ],
      [
        "declaration order drives the tag (middle arm = 1)",
        String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = Green
`,
        String.raw`declare ptr @trip_alloc_obj(i64, i64)
declare void @trip_obj_set_field(ptr, i64, i64)
declare i64 @trip_obj_tag(ptr)
declare i64 @trip_obj_field(ptr, i64)

define i64 @main() {
entry:
  %__ll0_p = call ptr @trip_alloc_obj(i64 1, i64 0)
  %__ll0 = ptrtoint ptr %__ll0_p to i64
  ret i64 %__ll0
}

`,
      ],
      [
        "match on a nullary enum lowers to switch + alloca/store/load",
        String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = \c : Color => match c [U8] { | Red => #u8(10) | Green => #u8(20) | Blue => #u8(30) }
`,
        String.raw`declare ptr @trip_alloc_obj(i64, i64)
declare void @trip_obj_set_field(ptr, i64, i64)
declare i64 @trip_obj_tag(ptr)
declare i64 @trip_obj_field(ptr, i64)

define i64 @main(i64 %c) {
entry:
  %__case_res_0 = alloca i64
  %__scrut_ptr_0 = inttoptr i64 %c to ptr
  %__tag_0 = call i64 @trip_obj_tag(ptr %__scrut_ptr_0)
  switch i64 %__tag_0, label %case_0_unreachable [
    i64 0, label %case_0_arm_0
    i64 1, label %case_0_arm_1
    i64 2, label %case_0_arm_2
  ]
case_0_arm_0:
  store i64 10, ptr %__case_res_0
  br label %case_0_merge
case_0_arm_1:
  store i64 20, ptr %__case_res_0
  br label %case_0_merge
case_0_arm_2:
  store i64 30, ptr %__case_res_0
  br label %case_0_merge
case_0_unreachable:
  unreachable
case_0_merge:
  %__case_res_0_val = load i64, ptr %__case_res_0
  ret i64 %__case_res_0_val
}

`,
      ],
    ];

    for (const [label, source, expected] of cases) {
      assert.equal(await compileSourceToLlvm(source), expected, label);
    }
  });

  // Regression guard: the emitted IR for boxed constructors and `case` must be
  // structurally valid LLVM. A previous revision interleaved the `case` arm
  // basic blocks inside the `switch [...]` table and never declared the
  // `trip_obj_*`/`trip_alloc_obj` runtime, so the output was string-asserted
  // but never assembled. clang rejects both defects.
  it("emits assemblable LLVM for boxed constructors and case (clang)", async () => {
    const programs: ReadonlyArray<readonly [string, string]> = [
      [
        "nullary constructor",
        String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = Green
`,
      ],
      [
        "case lowers to a switch over the object tag",
        String.raw`module Demo
data Color = | Red | Green | Blue
export main
poly main = \c : Color => match c [U8] { | Red => #u8(10) | Green => #u8(20) | Blue => #u8(30) }
`,
      ],
      // A two-constructor nullary enum must allocate and match uniformly like
      // any other ADT. A removed fast-path emitted these as `i1`, which then
      // fed `inttoptr i64`/`store i64` and produced an i1/i64 type clash.
      [
        "two-constructor enum constructs and matches without an i1/i64 mix",
        String.raw`module Demo
data Two = | A | B
export main
poly main = match A [U8] { | A => #u8(1) | B => #u8(2) }
`,
      ],
      [
        "higher-order function / closure compilation",
        String.raw`module Demo
export main
poly main =
  \x : U8 =>
    let f = (\y : U8 => addU8 x y) in
    f #u8(10)
`,
      ],
      [
        "multiple captured variables in closure environment",
        String.raw`module Demo
export main
poly main =
  \x : U8 =>
    \y : U8 =>
      let f = (\z : U8 => addU8 (addU8 x y) z) in
      f #u8(10)
`,
      ],
      [
        "nested curried closures",
        String.raw`module Demo
export main
poly main =
  \x : U8 =>
    let f = (\y : U8 => \z : U8 => addU8 (addU8 x y) z) in
    let g = f #u8(5) in
    g #u8(10)
`,
      ],
      [
        "passing closure to a higher-order function",
        String.raw`module Demo
export main
poly apply = \f : U8 -> U8 => \x : U8 => f x
poly main =
  \x : U8 =>
    let f = (\y : U8 => addU8 x y) in
    apply f #u8(10)
`,
      ],
    ];
    for (const [label, source] of programs) {
      const llvm = await compileSourceToLlvm(source);
      assert.ok(!llvm.startsWith("ERR:"), `${label}: emitter returned ${llvm}`);
      await assertAssembles(llvm, label);
    }
  });
});
