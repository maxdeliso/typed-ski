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
  unit,
} from "./helpers.ts";

describe("LLVM emitter - straight-line code", () => {
  it("emits a void function return", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], unit, [
        block("entry", [], [], { kind: "return" }),
      ]),
    ]);

    assert.strictEqual(
      emitLlvmModule(module, { target: { kind: "generic" } }),
      ["define void @trip_fn_Main_main() {", "entry:", "  ret void", "}"].join(
        "\n",
      ),
    );
  });

  it("emits a U8 literal return", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], u8, [
        block("entry", [], [], { kind: "return", value: litU8(42) }),
      ]),
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      ["define i8 @trip_fn_Main_main() {", "entry:", "  ret i8 42", "}"].join(
        "\n",
      ),
    );
  });

  it("emits primitive U8 arithmetic", () => {
    const add = prim(1, "Prelude.addU8");
    const module = moduleOf([
      fn(0, "Main.add", [param(0), param(1)], u8, [
        block(
          "entry",
          [param(0), param(1)],
          [
            {
              result: param(2),
              resultType: u8,
              effects: "pure",
              op: {
                kind: "prim",
                target: add.id,
                name: add.name,
                args: [local(0), local(1)],
              },
            },
          ],
          { kind: "return", value: local(2) },
        ),
      ]),
      add,
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i8 @trip_fn_Main_add(i8 %v0, i8 %v1) {",
        "entry:",
        "  %v2 = add i8 %v0, %v1",
        "  ret i8 %v2",
        "}",
      ].join("\n"),
    );
  });

  it("emits primitive comparisons as i1", () => {
    const lt = prim(1, "Prelude.ltU8");
    const module = moduleOf([
      fn(0, "Main.less", [param(0), param(1)], bool, [
        block(
          "entry",
          [param(0), param(1)],
          [
            {
              result: param(2, bool),
              resultType: bool,
              effects: "pure",
              op: {
                kind: "prim",
                target: lt.id,
                name: lt.name,
                args: [local(0), local(1)],
              },
            },
          ],
          { kind: "return", value: local(2, bool) },
        ),
      ]),
      lt,
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i1 @trip_fn_Main_less(i8 %v0, i8 %v1) {",
        "entry:",
        "  %v2 = icmp ult i8 %v0, %v1",
        "  ret i1 %v2",
        "}",
      ].join("\n"),
    );
  });

  it("lowers move instructions through aliases", () => {
    const module = moduleOf([
      fn(0, "Main.id", [param(0)], u8, [
        block(
          "entry",
          [param(0)],
          [
            {
              result: param(1),
              resultType: u8,
              effects: "pure",
              op: { kind: "move", value: local(0) },
            },
          ],
          { kind: "return", value: local(1) },
        ),
      ]),
    ]);

    assert.strictEqual(
      emitLlvmModule(module),
      [
        "define i8 @trip_fn_Main_id(i8 %v0) {",
        "entry:",
        "  ret i8 %v0",
        "}",
      ].join("\n"),
    );
  });
});
