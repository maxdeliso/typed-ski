import assert from "node:assert/strict";
import { describe, it } from "./util/test_shim.ts";
import { compileTripAndRun } from "./compiler/llvm/nativeHarness.ts";

describe("Trip IO native LLVM execution", () => {
  it("writes bytes through the native runtime", async () => {
    const source = `
module Main
import Prelude writeOne
import Prelude U8

export main

poly main =
  writeOne #u8(65) [U8] (\\x : U8 => x)
`;

    const result = await compileTripAndRun(source);
    assert.equal(result.status, 65);
    assert.equal(result.stdout, "A");
  });

  it("reads stdin through the native runtime", async () => {
    const source = `
module Main
import Prelude readOne
import Prelude writeOne
import Prelude U8

export main

poly main =
  readOne [U8] (\\c : U8 =>
    writeOne c [U8] (\\x : U8 => x))
`;

    const result = await compileTripAndRun(source, { stdin: "Z" });
    assert.equal(result.status, 90);
    assert.equal(result.stdout, "Z");
  });
});
