import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { compileTripAndRun } from "./nativeHarness.ts";

describe("LLVM native harness", () => {
  it("compiles and runs a simple arithmetic Trip program", async () => {
    const source = `
module Main
import Prelude writeOne
import Prelude U8

export main

poly main = writeOne #u8(42) [U8] (\\x : U8 => x)
`;
    const result = await compileTripAndRun(source);

    assert.equal(result.status, 42);
    assert.equal(result.stdout, "*"); // ASCII 42 is '*'
  });

  it("compiles and runs a program that returns a value to the C wrapper", async () => {
    const source = `
    module Main
    import Prelude U8

    export main

    poly main = #u8(123)
    `;
    // The C main wrapper returns the result of Main.main if it's u8
    const result = await compileTripAndRun(source, { emitMainWrapper: true });

    assert.equal(result.status, 123);
  });
});
