import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import {
  type CompilerTripModuleName,
  loadCompilerTripModule,
} from "../../lib/compiler/bootstrapModules.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { toTopoDagWire } from "../../lib/ski/topoDagWire.ts";

const HARNESS_MODULE_NAMES: readonly CompilerTripModuleName[] = [
  "Prelude",
  "Nat",
  "Bin",
  "Avl",
  "Lexer",
  "Parser",
  "Core",
  "DataEnv",
  "CoreToLower",
  "Unparse",
  "Lowering",
  "Bridge",
  "Llvm",
  "Compiler",
];

type CompilerModules = Map<CompilerTripModuleName, TripCObject>;

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
      const objects = await Promise.all(
        HARNESS_MODULE_NAMES.map((name) => loadCompilerTripModule(name)),
      );
      return new Map(
        HARNESS_MODULE_NAMES.map((name, i) => [name, objects[i]!]),
      );
    })();
  }
  return compilerModulesPromise;
}

function moduleObject(
  modules: CompilerModules,
  name: CompilerTripModuleName,
): TripCObject {
  const object = modules.get(name);
  if (!object) {
    throw new Error(`Harness module '${name}' not loaded`);
  }
  return object;
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
  const get = (name: CompilerTripModuleName) => moduleObject(modules, name);
  const compilerForHarness = compilerCombOnly(get("Compiler"));
  const testObject = compileToObjectFile(source, {
    importedModules: [
      get("Prelude"),
      get("Lexer"),
      get("Unparse"),
      compilerForHarness,
    ],
  });

  const LINKED_MODULE_NAMES: readonly CompilerTripModuleName[] = [
    "Prelude",
    "Bin",
    "Nat",
    "Avl",
    "Lexer",
    "Parser",
    "Core",
    "DataEnv",
    "Unparse",
    "Lowering",
    "CoreToLower",
    "Bridge",
  ];
  const linked = linkModules([
    ...LINKED_MODULE_NAMES.map((name) => ({ name, object: get(name) })),
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
