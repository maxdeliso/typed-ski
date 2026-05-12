import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import {
  block,
  bool,
  fn,
  litU8,
  local,
  moduleOf,
  param,
  prim,
  u8,
} from "./helpers.ts";

describe("LLVM emitter - branch and phi", () => {
  it("emits a phi for a branch target with one block param", () => {
    const module = moduleOf([
      fn(0, "Main.choose", [param(0, bool)], u8, [
        block("entry", [param(0, bool)], [], {
          kind: "branch",
          condition: local(0, bool),
          thenTarget: "then0",
          thenArgs: [],
          elseTarget: "else0",
          elseArgs: [],
        }),
        block("then0", [], [], {
          kind: "jump",
          target: "join0",
          args: [litU8(1)],
        }),
        block("else0", [], [], {
          kind: "jump",
          target: "join0",
          args: [litU8(2)],
        }),
        block("join0", [param(1)], [], {
          kind: "return",
          value: local(1),
        }),
      ]),
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i8 @trip_fn_Main_choose(i1 %v0) local_unnamed_addr nounwind {",
        "entry:",
        "  br i1 %v0, label %then0, label %else0",
        "then0:",
        "  br label %join0",
        "else0:",
        "  br label %join0",
        "join0:",
        "  %v1 = phi i8 [ 1, %then0 ], [ 2, %else0 ]",
        "  ret i8 %v1",
        "}",
      ].join("\n"),
    );
  });

  it("emits multiple phis with incoming literals and locals", () => {
    const sub = prim(1, "Prelude.subU8");
    const module = moduleOf([
      fn(0, "Main.joinTwo", [param(0, bool), param(1)], u8, [
        block("entry", [param(0, bool), param(1)], [], {
          kind: "branch",
          condition: local(0, bool),
          thenTarget: "then0",
          thenArgs: [local(1), local(0, bool)],
          elseTarget: "else0",
          elseArgs: [local(1), local(0, bool)],
        }),
        block("then0", [param(5), param(6, bool)], [], {
          kind: "jump",
          target: "join0",
          args: [local(5), local(6, bool)],
        }),
        block(
          "else0",
          [param(7), param(8, bool)],
          [
            {
              result: param(2),
              resultType: u8,
              effects: "pure",
              op: {
                kind: "prim",
                target: sub.id,
                name: sub.name,
                args: [local(7), litU8(1)],
              },
            },
          ],
          {
            kind: "jump",
            target: "join0",
            args: [local(2), local(8, bool)],
          },
        ),
        block("join0", [param(3), param(4, bool)], [], {
          kind: "return",
          value: local(3),
        }),
      ]),
      sub,
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i8 @trip_fn_Main_joinTwo(i1 %v0, i8 %v1) local_unnamed_addr nounwind {",
        "entry:",
        "  br i1 %v0, label %then0, label %else0",
        "then0:",
        "  %v5 = phi i8 [ %v1, %entry ]",
        "  %v6 = phi i1 [ %v0, %entry ]",
        "  br label %join0",
        "else0:",
        "  %v7 = phi i8 [ %v1, %entry ]",
        "  %v8 = phi i1 [ %v0, %entry ]",
        "  %v2 = sub i8 %v7, 1",
        "  br label %join0",
        "join0:",
        "  %v3 = phi i8 [ %v5, %then0 ], [ %v2, %else0 ]",
        "  %v4 = phi i1 [ %v6, %then0 ], [ %v8, %else0 ]",
        "  ret i8 %v3",
        "}",
      ].join("\n"),
    );
  });
});
