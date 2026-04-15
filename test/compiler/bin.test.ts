/**
 * Unit test for Bin operations (Prelude)
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/index.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testSourcePath = join(__dirname, "inputs", "testBinOps.trip");

let preludeObject: Awaited<ReturnType<typeof getPreludeObject>> | null = null;
let binObject: Awaited<ReturnType<typeof getBinObject>> | null = null;

async function getPreludeObjectCached() {
  if (!preludeObject) {
    preludeObject = await getPreludeObject();
  }
  return preludeObject;
}

async function getBinObjectCached() {
  if (!binObject) {
    binObject = await getBinObject();
  }
  return binObject;
}

async function compileTestProgram() {
  return await loadTripModuleObject(testSourcePath);
}

it("Bin operations - add/mul/sub round trip", async () => {
  const testObj = await compileTestProgram();
  const preludeObj = await getPreludeObjectCached();
  const binObj = await getBinObjectCached();

  const skiExpression = linkModules(
    [
      { name: "Prelude", object: preludeObj },
      { name: "Bin", object: binObj },
      { name: "Test", object: testObj },
    ],
    false,
  );

  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const nf = await evaluator.reduceAsync(parseSKI(skiExpression));
    const value = await UnChurchNumber(nf, evaluator);
    assert.strictEqual(value, 9n);
  } finally {
    evaluator.terminate();
  }
});
