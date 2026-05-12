import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import { block, fn, local, moduleOf, param, u8, unit } from "./helpers.ts";

describe("LLVM emitter - runtime calls", () => {
  it("emits runtime declarations once and runtime calls", () => {
    const module = moduleOf([
      fn(0, "Main.echo", [], unit, [
        block(
          "entry",
          [],
          [
            {
              result: param(0),
              resultType: u8,
              effects: "io",
              op: { kind: "runtimeCall", name: "trip_read_one", args: [] },
            },
            {
              resultType: unit,
              effects: "io",
              op: {
                kind: "runtimeCall",
                name: "trip_write_one",
                args: [local(0)],
              },
            },
            {
              resultType: unit,
              effects: "io",
              op: {
                kind: "runtimeCall",
                name: "trip_write_one",
                args: [local(0)],
              },
            },
          ],
          { kind: "return" },
        ),
      ]),
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "declare i8 @trip_read_one() nounwind",
        "declare void @trip_write_one(i8) nounwind",
        "",
        "define void @trip_fn_Main_echo() local_unnamed_addr nounwind {",
        "entry:",
        "  %v0 = call i8 @trip_read_one()",
        "  call void @trip_write_one(i8 %v0)",
        "  call void @trip_write_one(i8 %v0)",
        "  ret void",
        "}",
      ].join("\n"),
    );
  });
});
