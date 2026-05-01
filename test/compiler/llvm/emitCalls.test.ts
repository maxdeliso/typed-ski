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
  prim,
  u8,
} from "./helpers.ts";

describe("LLVM emitter - direct calls", () => {
  it("emits a call to a function defined later", () => {
    const add = prim(2, "Prelude.addU8");
    const module = moduleOf([
      fn(0, "Main.main", [], u8, [
        block(
          "entry",
          [],
          [
            {
              result: param(0),
              resultType: u8,
              effects: "unknown",
              op: {
                kind: "call",
                target: 1,
                name: "Main.inc",
                args: [litU8(41)],
              },
            },
          ],
          { kind: "return", value: local(0) },
        ),
      ]),
      fn(1, "Main.inc", [param(0)], u8, [
        block(
          "entry",
          [param(0)],
          [
            {
              result: param(1),
              resultType: u8,
              effects: "pure",
              op: {
                kind: "prim",
                target: add.id,
                name: add.name,
                args: [local(0), litU8(1)],
              },
            },
          ],
          { kind: "return", value: local(1) },
        ),
      ]),
      add,
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i8 @trip_fn_Main_main() {",
        "entry:",
        "  %v0 = call i8 @trip_fn_Main_inc(i8 41)",
        "  ret i8 %v0",
        "}",
        "",
        "define i8 @trip_fn_Main_inc(i8 %v0) {",
        "entry:",
        "  %v1 = add i8 %v0, 1",
        "  ret i8 %v1",
        "}",
      ].join("\n"),
    );
  });
});
