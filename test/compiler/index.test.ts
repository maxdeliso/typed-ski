import { assert } from "chai";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import {
  fromDagWire,
  getThanatosSession,
  passthroughEvaluator,
  thanatosAvailable,
  toDagWire,
} from "../thanatosHarness.ts";

const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);
const PARSER_SOURCE_FILE = new URL(
  "../../lib/compiler/parser.trip",
  import.meta.url,
);
const UNPARSE_SOURCE_FILE = new URL(
  "../../lib/compiler/unparse.trip",
  import.meta.url,
);
const LOWERING_SOURCE_FILE = new URL(
  "../../lib/compiler/lowering.trip",
  import.meta.url,
);
const BRIDGE_SOURCE_FILE = new URL(
  "../../lib/compiler/bridge.trip",
  import.meta.url,
);
const COMPILER_SOURCE_FILE = new URL(
  "../../lib/compiler/index.trip",
  import.meta.url,
);
const AVL_SOURCE_FILE = new URL(
  "../../lib/avl.trip",
  import.meta.url,
);
const BIN_SOURCE_FILE = new URL(
  "../../lib/bin.trip",
  import.meta.url,
);
const NAT_SOURCE_FILE = new URL(
  "../../lib/nat.trip",
  import.meta.url,
);

interface CompilerModules {
  prelude: TripCObject;
  lexer: TripCObject;
  parser: TripCObject;
  unparse: TripCObject;
  lowering: TripCObject;
  bridge: TripCObject;
  compiler: TripCObject;
  avl: TripCObject;
  bin: TripCObject;
  nat: TripCObject;
}

let compilerModulesPromise: Promise<CompilerModules> | null = null;

function tripStringLiteral(text: string): string {
  return JSON.stringify(text);
}

async function getCompilerModules(): Promise<CompilerModules> {
  if (!compilerModulesPromise) {
    compilerModulesPromise = (async () => {
      const [
        prelude,
        lexer,
        parser,
        unparse,
        lowering,
        bridge,
        compiler,
        avl,
        bin,
        nat,
      ] = await Promise.all([
        getPreludeObject(),
        loadTripModuleObject(LEXER_SOURCE_FILE),
        loadTripModuleObject(PARSER_SOURCE_FILE),
        loadTripModuleObject(UNPARSE_SOURCE_FILE),
        loadTripModuleObject(LOWERING_SOURCE_FILE),
        loadTripModuleObject(BRIDGE_SOURCE_FILE),
        loadTripModuleObject(COMPILER_SOURCE_FILE),
        loadTripModuleObject(AVL_SOURCE_FILE),
        loadTripModuleObject(BIN_SOURCE_FILE),
        loadTripModuleObject(NAT_SOURCE_FILE),
      ]);

      return {
        prelude,
        lexer,
        parser,
        unparse,
        lowering,
        bridge,
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
import Lexer eqListU8
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

function makeNonStubNatHarness(source: string): string {
  return `module Test
import Prelude Bool
import Prelude true
import Prelude false
import Prelude if
import Prelude not
import Prelude List
import Prelude matchList
import Prelude Pair
import Prelude fst
import Prelude snd
import Prelude Result
import Prelude Ok
import Prelude Err
import Prelude U8
import Lexer eqListU8
import Compiler compileToComb
import Unparse Comb
import Unparse unparseCombinator

export main

poly notStub = \\results : List (Pair (List U8) Comb) =>
  matchList [Pair (List U8) Comb] [Bool] results false
    (\\h : Pair (List U8) Comb => \\t : List (Pair (List U8) Comb) =>
      if [Bool] (eqListU8 (fst [List U8] [Comb] h) "main")
        (\\u : U8 =>
          if [Bool] (not (eqListU8 (unparseCombinator (snd [List U8] [Comb] h)) "#u8(0)"))
            (\\u : U8 =>
              matchList [Pair (List U8) Comb] [Bool] t true
                (\\extra : Pair (List U8) Comb => \\rest : List (Pair (List U8) Comb) => false))
            (\\u : U8 => false))
        (\\u : U8 => false))

poly main =
  match (compileToComb ${tripStringLiteral(source)}) [Bool] {
    | Err e => false
    | Ok results => notStub results
  }
`;
}

async function runCompilerHarness(source: string): Promise<boolean> {
  const modules = await getCompilerModules();
  const compilerForHarness: TripCObject = {
    ...modules.compiler,
    exports: modules.compiler.exports.filter((name) => name !== "main"),
  };
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
    { name: "Unparse", object: modules.unparse },
    { name: "Lowering", object: modules.lowering },
    { name: "Bridge", object: modules.bridge },
    { name: "Compiler", object: compilerForHarness },
    { name: "Test", object: testObject },
  ]);

  const expr = parseSKI(linked);
  const session = await getThanatosSession();
  const resultDag = await session.reduceDag(toDagWire(expr));
  const resultExpr = fromDagWire(resultDag);
  return await UnChurchBoolean(resultExpr, passthroughEvaluator);
}

Deno.test({
  name: "Self-hosted compileToComb matches TS for byte nat literals",
  ignore: !thanatosAvailable(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const source = `module M
export main
poly main = 65
`;
    const expected = linkModules([
      { name: "Prelude", object: await getPreludeObject() },
      { name: "M", object: compileToObjectFile(source) },
    ]).trim();

    const ok = await runCompilerHarness(makeParityHarness(source, expected));
    assert.isTrue(
      ok,
      "Expected self-hosted compileToComb to match TS output for 65",
    );
  },
});

Deno.test({
  name:
    "Self-hosted compileToComb lowers non-byte nat literals through a non-stub path",
  ignore: !thanatosAvailable(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const source = `module M
export main
poly main = 256
`;
    const ok = await runCompilerHarness(makeNonStubNatHarness(source));
    assert.isTrue(
      ok,
      "Expected self-hosted compileToComb to lower 256 without falling back to #u8(0)",
    );
  },
});
