import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import {
  block,
  fn,
  litU8,
  local,
  moduleOf,
  param,
  u8,
  unit,
} from "./helpers.ts";
import type {
  BlockSymbolDef,
  BlockModule,
} from "../../../lib/minicore/index.ts";
import { emptyMiniCoreMetadata } from "../../../lib/minicore/index.ts";

const box: BlockSymbolDef = {
  kind: "constructor",
  id: 99,
  name: "Main.Box",
  tag: 7,
  arity: 1,
};

describe("LLVM emitter - boxed runtime", () => {
  it("emits constructor allocation and field stores", () => {
    const module = moduleOf([
      box,
      fn(0, "Main.main", [], { kind: "data", id: 0, args: [] }, [
        block(
          "entry",
          [],
          [
            {
              result: param(1, { kind: "data", id: 0, args: [] }),
              resultType: { kind: "data", id: 0, args: [] },
              effects: "alloc",
              op: {
                kind: "construct",
                target: 99,
                name: "Main.Box",
                args: [litU8(65)],
              },
            },
          ],
          {
            kind: "return",
            value: local(1, { kind: "data", id: 0, args: [] }),
          },
        ),
      ]),
    ]);

    assert.equal(
      emitLlvmModule(module, { representation: "boxed-runtime" }),
      [
        "declare noalias ptr @trip_alloc_obj(i64, i64) nounwind",
        "declare void @trip_obj_set_field(ptr, i64, i64) nounwind",
        "declare i64 @trip_obj_tag(ptr) nounwind readonly willreturn",
        "declare i64 @trip_obj_field(ptr, i64) nounwind readonly willreturn",
        "",
        "define ptr @trip_fn_Main_main() local_unnamed_addr nounwind {",
        "entry:",
        "  %v1 = call ptr @trip_alloc_obj(i64 7, i64 1)",
        "  %_v1_field0_word = zext i8 65 to i64",
        "  call void @trip_obj_set_field(ptr %v1, i64 0, i64 %_v1_field0_word)",
        "  ret ptr %v1",
        "}",
      ].join("\n"),
    );
  });

  it("emits ADT case dispatch and field unpacking", () => {
    const data = { kind: "data" as const, id: 0, args: [] };
    const module = moduleOf([
      box,
      fn(0, "Main.main", [param(0, data)], u8, [
        block("entry", [param(0, data)], [], {
          kind: "case",
          scrutinee: local(0, data),
          alts: [
            {
              constructor: 99,
              constructorName: "Main.Box",
              binders: [param(1, u8)],
              target: "box",
              args: [],
            },
          ],
        }),
        block("box", [param(1, u8)], [], {
          kind: "return",
          value: local(1, u8),
        }),
      ]),
    ]);

    assert.equal(
      emitLlvmModule(module, { representation: "boxed-runtime" }),
      [
        "declare noalias ptr @trip_alloc_obj(i64, i64) nounwind",
        "declare void @trip_obj_set_field(ptr, i64, i64) nounwind",
        "declare i64 @trip_obj_tag(ptr) nounwind readonly willreturn",
        "declare i64 @trip_obj_field(ptr, i64) nounwind readonly willreturn",
        "",
        "define i8 @trip_fn_Main_main(ptr %v0) local_unnamed_addr nounwind {",
        "entry:",
        "  %entry_case_tag = call i64 @trip_obj_tag(ptr %v0)",
        "  switch i64 %entry_case_tag, label %entry_case_unreachable [",
        "    i64 7, label %entry_case_0_Box",
        "  ]",
        "entry_case_0_Box:",
        "  %entry_case_0_Box_field0_raw = call i64 @trip_obj_field(ptr %v0, i64 0)",
        "  %entry_case_0_Box_field0 = trunc i64 %entry_case_0_Box_field0_raw to i8",
        "  br label %box",
        "entry_case_unreachable:",
        "  unreachable",
        "box:",
        "  %v1 = phi i8 [ %entry_case_0_Box_field0, %entry_case_0_Box ]",
        "  ret i8 %v1",
        "}",
      ].join("\n"),
    );
  });

  it("emits a stdin List U8 C main wrapper", () => {
    const data = { kind: "data" as const, id: 0, args: [] };
    const module = moduleOf([
      fn(0, "Compiler.main", [param(0, data)], unit, [
        block("entry", [param(0, data)], [], { kind: "return" }),
      ]),
    ]);

    assert.equal(
      emitLlvmModule(module, {
        representation: "boxed-runtime",
        emitMainWrapper: true,
      }),
      [
        "declare noalias ptr @trip_read_stdin_list_u8() nounwind",
        "",
        "define void @trip_fn_Compiler_main(ptr %v0) local_unnamed_addr nounwind {",
        "entry:",
        "  ret void",
        "}",
        "",
        "define i32 @main() {",
        "entry:",
        "  %trip_source = call ptr @trip_read_stdin_list_u8()",
        "  call void @trip_fn_Compiler_main(ptr %trip_source)",
        "  ret i32 0",
        "}",
      ].join("\n"),
    );
  });

  it("emits Bool branches (not object cases) for Bool pattern matching", () => {
    // Bool cases are lowered to branch instructions at the fromAnf stage,
    // ensuring they never reach emitCaseTerminator which would incorrectly
    // try to call @trip_obj_tag(ptr %scrutinee) on an i1 value.
    // This test verifies that Bool branches emit correctly as `br i1`.

    const bool = { kind: "bool" as const };
    const falseConstructor: BlockSymbolDef = {
      kind: "constructor",
      id: 1,
      name: "Prelude.false",
      tag: 0,
      arity: 0,
    };
    const trueConstructor: BlockSymbolDef = {
      kind: "constructor",
      id: 2,
      name: "Prelude.true",
      tag: 1,
      arity: 0,
    };

    const symbols: BlockSymbolDef[] = [
      falseConstructor,
      trueConstructor,
      fn(0, "Main.boolToU8", [param(0, bool)], u8, [
        block("entry", [param(0, bool)], [], {
          kind: "branch",
          condition: local(0, bool),
          thenTarget: "ifTrue",
          thenArgs: [],
          elseTarget: "ifFalse",
          elseArgs: [],
        }),
        block("ifTrue", [], [], {
          kind: "jump",
          target: "join",
          args: [litU8(1)],
        }),
        block("ifFalse", [], [], {
          kind: "jump",
          target: "join",
          args: [litU8(0)],
        }),
        block("join", [param(1, u8)], [], {
          kind: "return",
          value: local(1, u8),
        }),
      ]),
    ];

    // Manually create module with Bool metadata
    const metadata = emptyMiniCoreMetadata();
    metadata.bool = {
      type: bool,
      dataType: 1,
      falseConstructor: 1,
      trueConstructor: 2,
    };
    metadata.dataTypes.set(1, {
      id: 1,
      name: "Prelude.Bool",
      typeParams: [],
      constructors: [1, 2],
    });
    metadata.constructors.set(1, {
      symbol: 1,
      dataType: 1,
      tag: 0,
      fieldTypes: [],
      resultType: bool,
    });
    metadata.constructors.set(2, {
      symbol: 2,
      dataType: 1,
      tag: 1,
      fieldTypes: [],
      resultType: bool,
    });
    metadata.functions.set(0, {
      symbol: 0,
      paramTypes: [bool],
      resultType: u8,
    });

    const module: BlockModule = {
      symbols,
      entry: 0,
      symbolsByName: new Map(symbols.map((s) => [s.name, s.id])),
      metadata,
    };

    // Verify the emitted LLVM uses `br i1`, not object case dispatch
    assert.equal(
      emitLlvmModule(module, { representation: "boxed-runtime" }),
      [
        "define i8 @trip_fn_Main_boolToU8(i1 %v0) local_unnamed_addr nounwind {",
        "entry:",
        "  br i1 %v0, label %ifTrue, label %ifFalse",
        "ifTrue:",
        "  br label %join",
        "ifFalse:",
        "  br label %join",
        "join:",
        "  %v1 = phi i8 [ 1, %ifTrue ], [ 0, %ifFalse ]",
        "  ret i8 %v1",
        "}",
      ].join("\n"),
    );
  });
});
