import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compileTripAndRun } from "./nativeHarness.ts";

describe("LLVM Tail Call Optimization", () => {
  it("executes a tail-recursive function with deep recursion (10M iterations)", async () => {
    // We use Nat.add and Nat.lte which are mapped to i64 primitives in the compiler.
    // 10M iterations will definitely crash the stack without TCO.
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

poly rec loop : Nat -> Nat -> Nat = \\n : Nat => \\limit : Nat =>
  if [Nat] (lte limit n)
    (\\u : U8 => n)
    (\\u : U8 => loop (succ n) limit)

export main
poly main = loop 1000 10001000
`;
    const result = await compileTripAndRun(mainSource, {
      moduleSources: [{ name: "Nat", source: natSource }],
    });
    assert.equal(result.status, 10001000, result.stderr);
  });
});
