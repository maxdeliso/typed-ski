import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { serializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { getNatObject } from "../../lib/nat.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import {
  compileFreshObject,
  type DeterminismRun,
  LEXER_SOURCE_FILE,
  PARSER_SOURCE_FILE,
  runFreshCompilerCorpusBuild,
} from "./freshCompilerCorpusBuild.ts";

const decoder = new TextDecoder();

async function runFreshCompilerCorpusBuildInSubprocess(): Promise<Uint8Array> {
  const {
    status: code,
    stdout,
    stderr,
  } = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      fileURLToPath(new URL("./freshCompilerCorpusBuild.ts", import.meta.url)),
    ],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (code !== 0) {
    throw new Error(
      `subprocess oracle build failed: ${decoder.decode(stderr)}`,
    );
  }
  return stdout;
}

let baselineRunPromise: Promise<DeterminismRun> | null = null;

function getBaselineRun(): Promise<DeterminismRun> {
  if (baselineRunPromise === null) {
    baselineRunPromise = runFreshCompilerCorpusBuild();
  }
  return baselineRunPromise;
}

it("fresh compiler corpus builds emit byte-identical SKI and object output", async () => {
  const baseline = await getBaselineRun();
  const current = await runFreshCompilerCorpusBuild();

  assert.deepStrictEqual(
    Array.from(current.finalBytes),
    Array.from(baseline.finalBytes),
  );
  assert.deepStrictEqual(current.finalOutputs, baseline.finalOutputs);
  assert.deepStrictEqual(
    Array.from(current.objectBytes.lexer),
    Array.from(baseline.objectBytes.lexer),
  );
  assert.deepStrictEqual(
    Array.from(current.objectBytes.parser),
    Array.from(baseline.objectBytes.parser),
  );
  assert.deepStrictEqual(
    Array.from(current.objectBytes.bin),
    Array.from(baseline.objectBytes.bin),
  );
});

it("fresh compiler corpus subprocess build matches the in-process baseline", async () => {
  const baseline = decoder.decode((await getBaselineRun()).finalBytes);
  const subprocessRun = decoder.decode(
    await runFreshCompilerCorpusBuildInSubprocess(),
  );

  assert.strictEqual(subprocessRun, baseline);
});

it("compileToObjectFile normalizes imported module metadata order", async () => {
  const prelude = await getPreludeObject();
  const nat = await getNatObject();
  const lexer = await compileFreshObject(LEXER_SOURCE_FILE, [prelude]);
  const parserSource = await readFile(
    fileURLToPath(PARSER_SOURCE_FILE),
    "utf8",
  );

  const ordered = serializeTripCObject(
    compileToObjectFile(parserSource, {
      importedModules: [prelude, lexer, nat],
    }),
  );
  const reversed = serializeTripCObject(
    compileToObjectFile(parserSource, {
      importedModules: [nat, lexer, prelude],
    }),
  );

  assert.strictEqual(reversed, ordered);
});
