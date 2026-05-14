import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrappedCompile,
  BootstrappedCompilerError,
  compileToCombinatorString,
} from "../../lib/compiler/combinatorCompiler.ts";
import { loadInput } from "../util/fileLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(__dirname, "../../..");

function loadCompilerInput(fileName: string): string {
  return loadInput(`combinatorCompiler/${fileName}`, join(srcRoot, "test", "compiler"));
}

it("compileToCombinatorString links built-in imports", async () => {
  const source = loadCompilerInput("withPreludeImport.trip");

  assert.strictEqual(await compileToCombinatorString(source), "I");
});

it("compileToCombinatorString preserves a stable exact shape for a K-like term", async () => {
  const source = `module Main
export main
poly main = #X => #Y => \\x : X => \\y : Y => x
`;

  assert.strictEqual(await compileToCombinatorString(source), "((BI)K)");
});

it("bootstrappedCompile matches the TypeScript compiler", async () => {
  const source = loadCompilerInput("literalZero.trip");

  const expected = await compileToCombinatorString(source);
  const actual = await bootstrappedCompile(source);

  assert.strictEqual(actual, expected);
});

it("bootstrappedCompile rejects unsupported top-level imports", async () => {
  const source = loadCompilerInput("withPreludeImport.trip");

  await assert.rejects(() => bootstrappedCompile(source), {
    name: "BootstrappedCompilerError",
    message: /supports only top-level module\/export\/poly\/data declarations/,
  });
});
