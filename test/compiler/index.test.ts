import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { toTopoDagWire } from "../../lib/ski/topoDagWire.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const LEXER_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "lexer.trip");
const PARSER_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "parser.trip",
);
const CORE_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "core.trip");
const DATA_ENV_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "dataEnv.trip",
);
const UNPARSE_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "unparse.trip",
);
const LOWERING_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "lowering.trip",
);
const BRIDGE_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "bridge.trip",
);
const CORE_TO_LOWER_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "coreToLower.trip",
);
const COMPILER_SOURCE_FILE = join(
  workspaceRoot,
  "lib",
  "compiler",
  "index.trip",
);
const LLVM_SOURCE_FILE = join(workspaceRoot, "lib", "compiler", "llvm.trip");
const AVL_SOURCE_FILE = join(workspaceRoot, "lib", "avl.trip");
const BIN_SOURCE_FILE = join(workspaceRoot, "lib", "bin.trip");
const NAT_SOURCE_FILE = join(workspaceRoot, "lib", "nat.trip");

interface CompilerModules {
  prelude: TripCObject;
  lexer: TripCObject;
  parser: TripCObject;
  core: TripCObject;
  dataEnv: TripCObject;
  unparse: TripCObject;
  lowering: TripCObject;
  coreToLower: TripCObject;
  bridge: TripCObject;
  llvm: TripCObject;
  compiler: TripCObject;
  avl: TripCObject;
  bin: TripCObject;
  nat: TripCObject;
}

let compilerModulesPromise: Promise<CompilerModules> | null = null;

function tripStringLiteral(text: string): string {
  return JSON.stringify(text);
}

function compilerCombOnly(object: TripCObject): TripCObject {
  const omittedDefinitions = new Set([
    "main",
    "compileToLlvm",
    "compileBundleToLlvm",
    "findModuleSource",
    "writeAll",
  ]);
  return {
    ...object,
    exports: object.exports.filter((name) => !omittedDefinitions.has(name)),
    imports: object.imports.filter(
      (imp) => imp.from !== "Llvm" && imp.from !== "BundleSummary",
    ),
    definitions: Object.fromEntries(
      Object.entries(object.definitions).filter(
        ([name]) => !omittedDefinitions.has(name),
      ),
    ),
  };
}

async function getCompilerModules(): Promise<CompilerModules> {
  if (!compilerModulesPromise) {
    compilerModulesPromise = (async () => {
      const [
        prelude,
        lexer,
        parser,
        core,
        dataEnv,
        unparse,
        lowering,
        coreToLower,
        bridge,
        llvm,
        compiler,
        avl,
        bin,
        nat,
      ] = await Promise.all([
        getPreludeObject(),
        loadTripModuleObject(LEXER_SOURCE_FILE),
        loadTripModuleObject(PARSER_SOURCE_FILE),
        loadTripModuleObject(CORE_SOURCE_FILE),
        loadTripModuleObject(DATA_ENV_SOURCE_FILE),
        loadTripModuleObject(UNPARSE_SOURCE_FILE),
        loadTripModuleObject(LOWERING_SOURCE_FILE),
        loadTripModuleObject(CORE_TO_LOWER_SOURCE_FILE),
        loadTripModuleObject(BRIDGE_SOURCE_FILE),
        loadTripModuleObject(LLVM_SOURCE_FILE),
        loadTripModuleObject(COMPILER_SOURCE_FILE),
        loadTripModuleObject(AVL_SOURCE_FILE),
        loadTripModuleObject(BIN_SOURCE_FILE),
        loadTripModuleObject(NAT_SOURCE_FILE),
      ]);

      return {
        prelude,
        lexer,
        parser,
        core,
        dataEnv,
        unparse,
        lowering,
        coreToLower,
        bridge,
        llvm,
        compiler,
        avl,
        bin,
        nat,
      };
    })();
  }
  return await compilerModulesPromise;
}

function makeParityHarness(source: string, expected: string): string {
  return `module Test
import Prelude Bool
import Prelude true
import Prelude false
import Prelude if
import Prelude List
import Prelude matchList
import Prelude Pair
import Prelude fst
import Prelude snd
import Prelude Result
import Prelude Ok
import Prelude Err
import Prelude U8
import Prelude eqListU8
import Compiler compileToComb
import Unparse Comb
import Unparse unparseCombinator

export main

poly matchesSingleMain = \\expected : List U8 => \\results : List (Pair (List U8) Comb) =>
  matchList [Pair (List U8) Comb] [Bool] results false
    (\\h : Pair (List U8) Comb => \\t : List (Pair (List U8) Comb) =>
      if [Bool] (eqListU8 (fst [List U8] [Comb] h) "main")
        (\\u : U8 =>
          if [Bool] (eqListU8 (unparseCombinator (snd [List U8] [Comb] h)) expected)
            (\\u : U8 =>
              matchList [Pair (List U8) Comb] [Bool] t true
                (\\extra : Pair (List U8) Comb => \\rest : List (Pair (List U8) Comb) => false))
            (\\u : U8 => false))
        (\\u : U8 => false))

poly main =
  match (compileToComb ${tripStringLiteral(source)}) [Bool] {
    | Err e => false
    | Ok results => matchesSingleMain ${tripStringLiteral(expected)} results
  }
`;
}

async function buildCompilerHarnessExpression(source: string) {
  const modules = await getCompilerModules();
  const compilerForHarness = compilerCombOnly(modules.compiler);
  const testObject = compileToObjectFile(source, {
    importedModules: [
      modules.prelude,
      modules.lexer,
      modules.unparse,
      compilerForHarness,
    ],
  });

  const linked = linkModules([
    { name: "Prelude", object: modules.prelude },
    { name: "Bin", object: modules.bin },
    { name: "Nat", object: modules.nat },
    { name: "Avl", object: modules.avl },
    { name: "Lexer", object: modules.lexer },
    { name: "Parser", object: modules.parser },
    { name: "Core", object: modules.core },
    { name: "DataEnv", object: modules.dataEnv },
    { name: "Unparse", object: modules.unparse },
    { name: "Lowering", object: modules.lowering },
    { name: "CoreToLower", object: modules.coreToLower },
    { name: "Bridge", object: modules.bridge },
    { name: "Compiler", object: compilerForHarness },
    { name: "Test", object: testObject },
  ]);

  return parseSKI(linked);
}

function countDagNodes(dag: string): number {
  let count = 0;
  for (let i = 0; i < dag.length; i++) {
    if (dag.charCodeAt(i) === 0x20) count++;
  }
  return dag.length === 0 ? 0 : count + 1;
}

it("Self-hosted compileToComb links a data/match elaboration harness", async () => {
  const source = `module M
export main
data List = Nil | Cons h t
poly main = match Cons 1 Nil {
  | Nil => 0
  | Cons h t => h
}
`;
  const dag = toTopoDagWire(
    await buildCompilerHarnessExpression(makeParityHarness(source, "#u8(1)")),
  );
  assert.ok(
    !dag.includes("undefined"),
    "Expected the self-hosted compiler harness DAG to be well-formed",
  );
  assert.ok(
    countDagNodes(dag) <= 1 << 21,
    "Expected the self-hosted compiler data/match harness to stay within the DAG size budget",
  );
});
