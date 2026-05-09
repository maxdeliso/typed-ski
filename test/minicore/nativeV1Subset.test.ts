import assert from "node:assert/strict";
import { describe, it } from "../util/test_shim.ts";
import {
  compileMiniCoreModules,
  emptyMiniCoreMetadata,
  NativeV1SubsetError,
  validateNativeV1Subset,
  type FunctionDef,
  type MiniType,
  type Program,
} from "../../lib/minicore/index.ts";
import { compileTripSourceToLlvm } from "../../lib/compiler/index.ts";

describe("Native-v1 subset validation", () => {
  it("accepts first-order MiniCore programs", () => {
    const program = compileMiniCoreModules(
      [
        {
          name: "Main",
          source: `module Main
export main
poly main = #u8(1)
`,
        },
      ],
      "Main",
    );

    validateNativeV1Subset(program);
  });

  it("rejects runtime function result types", () => {
    const u8: MiniType = { kind: "u8" };
    const fnType: MiniType = { kind: "fn", params: [u8], result: u8 };
    const main: FunctionDef = {
      kind: "function",
      id: 0,
      name: "Main.main",
      arity: 0,
      params: [],
      body: { kind: "lit", value: { kind: "u8", value: 0 } },
    };
    const metadata = emptyMiniCoreMetadata();
    metadata.functions.set(0, {
      symbol: 0,
      paramTypes: [],
      resultType: fnType,
    });
    const program: Program = {
      symbols: [main],
      entry: 0,
      symbolsByName: new Map([["Main.main", 0]]),
      metadata,
    };

    assert.throws(() => validateNativeV1Subset(program), {
      name: NativeV1SubsetError.name,
      message: /runtime result of Main\.main/,
    });
  });

  it("rejects function-typed constructor fields before LLVM emission", () => {
    assert.throws(
      () =>
        compileTripSourceToLlvm(`module Main
data Box = MkBox (U8 -> U8)
export main
poly main = #u8(0)
`),
      {
        name: NativeV1SubsetError.name,
        message: /field 0 of constructor Main\.Box\.MkBox/,
      },
    );
  });
});
