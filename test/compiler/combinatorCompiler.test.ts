import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrappedCompile,
  BootstrappedCompilerError,
  compileToCombinatorString,
} from "../../lib/compiler/index.ts";
import { loadInput } from "../util/fileLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCompilerInput(fileName: string): string {
  return loadInput(`combinatorCompiler/${fileName}`, __dirname);
}

it("compileToCombinatorString links built-in imports", async () => {
  const source = loadCompilerInput("withPreludeImport.trip");

  assert.strictEqual(await compileToCombinatorString(source), "I");
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
