/**
 * Unit test for Bin operations (Prelude)
 */

import { assert } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testSourcePath = join(__dirname, "inputs", "testBinOps.trip");

let preludeObject: Awaited<ReturnType<typeof getPreludeObject>> | null = null;

async function getPreludeObjectCached() {
  if (!preludeObject) {
    preludeObject = await getPreludeObject();
  }
  return preludeObject;
}

async function compileTestProgram() {
  const testObjectFileName = "testBinOps.tripc";
  const testObjectFilePath = join(__dirname, "inputs", testObjectFileName);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      join(__dirname, "..", "..", "bin", "tripc.ts"),
      testSourcePath,
      testObjectFilePath,
    ],
  });

  const { code, stderr } = await compileCommand.output();
  if (code !== 0) {
    const errorMsg = new TextDecoder().decode(stderr);
    throw new Error(
      `Failed to compile test program ${testSourcePath}: exit code ${code}\n${errorMsg}`,
    );
  }

  const testContent = await Deno.readTextFile(testObjectFilePath);
  return deserializeTripCObject(testContent);
}

Deno.test("Bin operations - add/mul/sub round trip", async () => {
  const testObj = await compileTestProgram();
  const preludeObj = await getPreludeObjectCached();

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObj },
    { name: "Test", object: testObj },
  ], true);

  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const nf = await evaluator.reduceAsync(parseSKI(skiExpression));
    const value = UnChurchNumber(nf);
    assert.equal(value, 9n);
  } finally {
    evaluator.terminate();
  }
});
