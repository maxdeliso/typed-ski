import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import {
  serializeTripCObject,
  type TripCObject,
} from "../../lib/compiler/objectFile.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getNatObject } from "../../lib/nat.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";

export const LEXER_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "lexer.trip");
export const PARSER_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "parser.trip");
const BIN_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "bin.trip");
const PARSER_DRIVER_FILE = join(workspaceRoot, "test", "compiler", "inputs", "testParseDefinitionKinds.trip");
const BIN_DRIVER_SOURCE = `module Test
import Bin addBin
import Nat fromBin
import Nat toBin
export main
poly main = fromBin (addBin (toBin 2) (toBin 7))
`;

const encoder = new TextEncoder();

export interface DeterminismRun {
  objectBytes: {
    lexer: Uint8Array;
    parser: Uint8Array;
    bin: Uint8Array;
  };
  finalBytes: Uint8Array;
  finalOutputs: {
    parser: string;
    bin: string;
  };
}

export async function compileFreshObject(
  sourceFile: string,
  importedModules: ReadonlyArray<TripCObject>,
): Promise<TripCObject> {
  const source = await readFile(sourceFile, "utf8");
  return compileToObjectFile(source, { importedModules });
}

export async function runFreshCompilerCorpusBuild(): Promise<DeterminismRun> {
  const prelude = await getPreludeObject();
  const nat = await getNatObject();
  const lexer = await compileFreshObject(LEXER_SOURCE_FILE, [prelude]);
  const parser = await compileFreshObject(PARSER_SOURCE_FILE, [
    prelude,
    lexer,
    nat,
  ]);
  const bin = await compileFreshObject(BIN_SOURCE_FILE, [prelude, nat]);
  const binForLink: TripCObject = {
    ...bin,
    exports: ["addBin", "incBin"],
  };
  const parserDriver = await compileFreshObject(PARSER_DRIVER_FILE, [
    prelude,
    lexer,
    parser,
  ]);
  const binDriver = compileToObjectFile(BIN_DRIVER_SOURCE, {
    importedModules: [prelude, nat, binForLink],
  });

  const parserOutput = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Bin", object: binForLink },
    { name: "Nat", object: nat },
    { name: "Lexer", object: lexer },
    { name: "Parser", object: parser },
    { name: "Test", object: parserDriver },
  ]);
  const binOutput = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Nat", object: nat },
    { name: "Bin", object: binForLink },
    { name: "Test", object: binDriver },
  ]);

  if (unparseSKI(parseSKI(parserOutput)) !== parserOutput) {
    throw new Error("parserOutput is not canonical");
  }
  if (unparseSKI(parseSKI(binOutput)) !== binOutput) {
    throw new Error("binOutput is not canonical");
  }

  return {
    objectBytes: {
      lexer: encoder.encode(serializeTripCObject(lexer)),
      parser: encoder.encode(serializeTripCObject(parser)),
      bin: encoder.encode(serializeTripCObject(bin)),
    },
    finalBytes: encoder.encode(`${parserOutput}\n%%\n${binOutput}`),
    finalOutputs: {
      parser: parserOutput,
      bin: binOutput,
    },
  };
}

function writeFully(bytes: Uint8Array): void {
  process.stdout.write(bytes);
}

function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(importMetaUrl))
    );
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const { finalBytes } = await runFreshCompilerCorpusBuild();
  writeFully(finalBytes);
}
