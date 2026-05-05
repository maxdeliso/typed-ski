import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import { block, fn, litU8, moduleOf, u8, unit } from "./helpers.ts";

describe("LLVM emitter - executable wrapper", () => {
  it("emits a Windows target triple and C main wrapper", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], u8, [
        block("entry", [], [], { kind: "return", value: litU8(0) }),
      ]),
    ]);

    assert.equal(
      emitLlvmModule(module, {
        target: { kind: "x86_64-pc-windows-msvc" },
        emitMainWrapper: true,
      }),
      [
        'target triple = "x86_64-pc-windows-msvc"',
        "",
        "define i8 @trip_fn_Main_main() {",
        "entry:",
        "  ret i8 0",
        "}",
        "",
        "define i32 @main() {",
        "entry:",
        "  %trip_result = call i8 @trip_fn_Main_main()",
        "  ret i32 0",
        "}",
      ].join("\n"),
    );
  });

  it("emits a void entry call in the C main wrapper", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], unit, [
        block("entry", [], [], { kind: "return" }),
      ]),
    ]);

    assert.equal(
      emitLlvmModule(module, { emitMainWrapper: true }),
      [
        "define void @trip_fn_Main_main() {",
        "entry:",
        "  ret void",
        "}",
        "",
        "define i32 @main() {",
        "entry:",
        "  call void @trip_fn_Main_main()",
        "  ret i32 0",
        "}",
      ].join("\n"),
    );
  });
});
