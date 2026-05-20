import assert from "node:assert/strict";
import { describe, it } from "./util/test_shim.ts";
import { compileTripAndRun } from "./compiler/llvm/nativeHarness.ts";

describe("Prelude native LLVM execution", () => {
  it("runs boolean and U8 prelude operations", async () => {
    const source = `
module Main
import Prelude Bool
import Prelude true
import Prelude false
import Prelude not
import Prelude and
import Prelude or
import Prelude if
import Prelude addU8
import Prelude subU8
import Prelude U8

export main

poly bit = \\b : Bool => if [U8] b (\\u : U8 => #u8(1)) (\\u : U8 => #u8(0))

poly main =
  let a = bit (not false) in
  let b = bit (and true true) in
  let c = bit (or false true) in
  addU8 (addU8 a b) (addU8 c (subU8 #u8(10) #u8(5)))
`;

    const result = await compileTripAndRun(source);
    assert.equal(result.status, 8);
  });

  it("runs primitive subtraction", async () => {
    const source = `
module Main
import Prelude subU8
import Prelude U8

export main

poly main = subU8 #u8(10) #u8(2)
`;

    const result = await compileTripAndRun(source);
    assert.equal(result.status, 8);
  });
});
