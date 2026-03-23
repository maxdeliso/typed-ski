import { assertEquals, assertRejects } from "std/assert";
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

Deno.test("compileToCombinatorString links built-in imports", async () => {
  const source = loadCompilerInput("withPreludeImport.trip");

  assertEquals(await compileToCombinatorString(source), "I");
});

Deno.test("bootstrappedCompile matches the TypeScript compiler", async () => {
  const source = loadCompilerInput("literalZero.trip");

  const expected = await compileToCombinatorString(source);
  const actual = await bootstrappedCompile(source);

  assertEquals(actual, expected);
});

Deno.test("bootstrappedCompile rejects unsupported top-level imports", async () => {
  const source = loadCompilerInput("withPreludeImport.trip");

  await assertRejects(
    () => bootstrappedCompile(source),
    BootstrappedCompilerError,
    "supports only top-level module/export/poly/data declarations",
  );
});
