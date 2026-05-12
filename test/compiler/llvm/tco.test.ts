import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compileTripAndRun } from "./nativeHarness.ts";

describe("LLVM Tail Call Optimization", () => {
  it("executes a tail-recursive function with deep recursion (10M iterations)", async () => {
    const natSource = `module Nat
export add
export lte
export succ
native add : Nat -> Nat -> Nat
native lte : Nat -> Nat -> Bool
native succ : Nat -> Nat
`;

    const mainSource = `module Main
import Nat add
import Nat lte
import Nat succ
import Prelude if
import Prelude U8

poly rec loop : Nat -> Nat -> U8 = \\n : Nat => \\limit : Nat =>
  if [U8] (lte limit n)
    (\\u : U8 => 42)
    (\\u : U8 => loop (succ n) limit)

export main
poly main = loop 1000 11000000
`;
    const result = await compileTripAndRun(mainSource, {
      moduleSources: [{ name: "Nat", source: natSource }],
    });
    assert.equal(result.status, 42, result.stderr);
  });
});
