import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "../../util/test_shim.ts";
import { workspaceRoot } from "../../../lib/shared/workspaceRoot.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import {
  anfToBlockModule,
  compileMiniCoreModules,
  toAnfProgram,
  type BlockFunctionDef,
  type BlockModule,
} from "../../../lib/minicore/index.ts";

const preludeSource = readFileSync(
  join(workspaceRoot, "lib", "prelude.trip"),
  "utf8",
);

describe("LLVM source lowering - runtime IO", () => {
  it("lowers Prelude.writeOne to the Trip runtime ABI", () => {
    const block = lowerMainToBlock(`
module Main
import Prelude writeOne
import Prelude U8

export main

poly main = writeOne #u8(65) [U8] (\\x : U8 => x)
`);

    assert.deepEqual(runtimeCallNames(mainFunction(block)), ["trip_write_one"]);
    assert.equal(
      emitLlvmModule(block),
      [
        "declare void @trip_write_one(i8) nounwind",
        "",
        "define i8 @trip_fn_Main_main() local_unnamed_addr nounwind {",
        "entry:",
        "  call void @trip_write_one(i8 65)",
        "  ret i8 65",
        "}",
      ].join("\n"),
    );
  });

  it("lowers Prelude.readOne followed by writeOne to runtime calls", () => {
    const block = lowerMainToBlock(`
module Main
import Prelude readOne
import Prelude writeOne
import Prelude U8

export main

poly main =
  readOne [U8] (\\c : U8 =>
    writeOne c [U8] (\\x : U8 => x))
`);

    assert.deepEqual(runtimeCallNames(mainFunction(block)), [
      "trip_read_one",
      "trip_write_one",
    ]);
    assert.equal(
      emitLlvmModule(block),
      [
        "declare i8 @trip_read_one() nounwind",
        "declare void @trip_write_one(i8) nounwind",
        "",
        "define i8 @trip_fn_Main_main() local_unnamed_addr nounwind {",
        "entry:",
        "  %v0 = call i8 @trip_read_one()",
        "  call void @trip_write_one(i8 %v0)",
        "  ret i8 %v0",
        "}",
      ].join("\n"),
    );
  });
});

function lowerMainToBlock(source: string): BlockModule {
  return anfToBlockModule(
    toAnfProgram(
      compileMiniCoreModules(
        [
          { name: "Prelude", source: preludeSource },
          { name: "Main", source },
        ],
        "Main",
      ),
    ),
  );
}

function mainFunction(module: BlockModule): BlockFunctionDef {
  const main = module.symbols.find(
    (symbol): symbol is BlockFunctionDef =>
      symbol.kind === "function" && symbol.name === "Main.main",
  );
  assert.ok(main, "Main.main was not lowered to a Block function");
  return main;
}

function runtimeCallNames(fn: BlockFunctionDef): string[] {
  return fn.blocks.flatMap((block) =>
    block.instructions.flatMap((instruction) =>
      instruction.op.kind === "runtimeCall" ? [instruction.op.name] : [],
    ),
  );
}
