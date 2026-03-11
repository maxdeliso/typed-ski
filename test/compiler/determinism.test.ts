import { assertEquals } from "std/assert";
import { fromFileUrl } from "std/path";
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

const DENO_CONFIG_FILE = new URL("../../deno.jsonc", import.meta.url);
const decoder = new TextDecoder();

async function runFreshCompilerCorpusBuildInSubprocess(): Promise<Uint8Array> {
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      fromFileUrl(DENO_CONFIG_FILE),
      "--allow-read",
      fromFileUrl(new URL("./freshCompilerCorpusBuild.ts", import.meta.url)),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await proc.output();
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

Deno.test("fresh compiler corpus builds emit byte-identical SKI and object output", async () => {
  const baseline = await getBaselineRun();
  const current = await runFreshCompilerCorpusBuild();

  assertEquals(
    Array.from(current.finalBytes),
    Array.from(baseline.finalBytes),
  );
  assertEquals(current.finalOutputs, baseline.finalOutputs);
  assertEquals(
    Array.from(current.objectBytes.lexer),
    Array.from(baseline.objectBytes.lexer),
  );
  assertEquals(
    Array.from(current.objectBytes.parser),
    Array.from(baseline.objectBytes.parser),
  );
  assertEquals(
    Array.from(current.objectBytes.bin),
    Array.from(baseline.objectBytes.bin),
  );
});

Deno.test("fresh compiler corpus subprocess build matches the in-process baseline", async () => {
  const baseline = decoder.decode(
    (await getBaselineRun()).finalBytes,
  );
  const subprocessRun = decoder.decode(
    await runFreshCompilerCorpusBuildInSubprocess(),
  );

  assertEquals(subprocessRun, baseline);
});

Deno.test("compileToObjectFile normalizes imported module metadata order", async () => {
  const prelude = await getPreludeObject();
  const nat = await getNatObject();
  const lexer = await compileFreshObject(LEXER_SOURCE_FILE, [prelude]);
  const parserSource = await Deno.readTextFile(PARSER_SOURCE_FILE);

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

  assertEquals(reversed, ordered);
});
