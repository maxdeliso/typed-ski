import { assert } from "chai";
import { dirname, fromFileUrl, join } from "std/path";
import {
  fromDagWire,
  getThanatosSession,
  passthroughEvaluator,
  thanatosAvailable,
  toDagWire,
} from "../thanatosHarness.test.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getNatObject } from "../../lib/nat.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const PARSER_SOURCE_FILE = join(
  __dirname,
  "../../lib/compiler/parser.trip",
);
const LEXER_SOURCE_FILE = join(
  __dirname,
  "../../lib/compiler/lexer.trip",
);

let parserObj: TripCObject | null = null;
let lexerObj: TripCObject | null = null;
let preludeObj: TripCObject | null = null;
let natObj: TripCObject | null = null;
let binObj: TripCObject | null = null;

async function getParserObjectCached() {
  if (!parserObj) {
    parserObj = await loadTripModuleObject(PARSER_SOURCE_FILE);
  }
  return parserObj;
}

async function getLexerObjectCached() {
  if (!lexerObj) {
    lexerObj = await loadTripModuleObject(LEXER_SOURCE_FILE);
  }
  return lexerObj;
}

async function getPreludeObjectCached() {
  if (!preludeObj) {
    preludeObj = await getPreludeObject();
  }
  return preludeObj;
}

async function getNatObjectCached() {
  if (!natObj) {
    natObj = await getNatObject();
  }
  return natObj;
}

async function getBinObjectCached() {
  if (!binObj) {
    binObj = await getBinObject();
  }
  return binObj;
}

async function compileTestProgram(fileName: string) {
  const source = await Deno.readTextFile(join(__dirname, "inputs", fileName));
  return compileToObjectFile(source);
}

const PARSER_TEST_REDUCE_TIMEOUT_MS = 60_000;

Deno.test({
  name: "Parser unit tests",
  ignore: !thanatosAvailable(),
}, async () => {
  const tests = [
    {
      name: "Parser stage 1 - parseAtom parses identifiers",
      file: "testParseAtom.trip",
      assertion: 'Expected parseAtom([T_Ident "x", T_EOF]) to return E_Var "x"',
    },
    {
      name: "Parser stage 2 - parseApp parses left-associated application",
      file: "testParseApp.trip",
      assertion:
        'Expected parseApp([T_Ident "x", T_Ident "y", T_Ident "z", T_EOF]) to return ((x y) z)',
    },
    {
      name: "Parser stage 3 - parseLam parses lambdas",
      file: "testParseExprLambdaTyped.trip",
      assertion: 'Expected parseLam(["\\\\", "x", ":", "T", "=>", "x"])',
    },
    {
      name: "Parser stage 4 - parseType parses T_App with right associativity",
      file: "testParseExprTypeApplication.trip",
      assertion: 'Expected parseType("A B C") to return (A (B C))',
    },
    {
      name: "Parser stage 5 - parseMatch parses match expressions",
      file: "testParseExprMatchTyped.trip",
      assertion: 'Expected parseMatch("match x with | C1 => y | C2 => z")',
    },
    {
      name: "Parser stage 6 - parseLet parses let expressions",
      file: "testParseExprLetTyped.trip",
      assertion: 'Expected parseLet("let x : T = y in z")',
    },
    {
      name: "Parser stage 7 - parseDecl parses top-level declarations",
      file: "testParseDefinitionKinds.trip",
      assertion: 'Expected parseDecl("poly x : T = y")',
    },
    {
      name: "Parser stage 8 - full module parsing",
      file: "testParseProgramForms.trip",
      assertion: "Expected full module with imports and multiple declarations",
    },
  ];

  const parserObj = await getParserObjectCached();
  const lexerObj = await getLexerObjectCached();
  const preludeObj = await getPreludeObjectCached();
  const natObj = await getNatObjectCached();
  const binObj = await getBinObjectCached();

  for (const t of tests) {
    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              `Parser test ${t.name} timed out after ${PARSER_TEST_REDUCE_TIMEOUT_MS}ms`,
            ),
          ),
        PARSER_TEST_REDUCE_TIMEOUT_MS,
      );
    });

    const runOne = async () => {
      const testObj = await compileTestProgram(t.file);
      const linked = linkModules([
        { name: "Prelude", object: preludeObj },
        { name: "Nat", object: natObj },
        { name: "Bin", object: binObj },
        { name: "Lexer", object: lexerObj },
        { name: "Parser", object: parserObj },
        { name: "Test", object: testObj },
      ]);
      const expr = parseSKI(linked);
      const dag = toDagWire(expr);
      const session = await getThanatosSession();
      try {
        const resultDag = await session.reduceDag(dag);
        const resultExpr = fromDagWire(resultDag);
        const ok = await UnChurchBoolean(
          resultExpr,
          passthroughEvaluator,
        );
        assert.isTrue(ok, t.assertion);
      } finally {
        await session.close();
      }
    };
    try {
      await Promise.race([runOne(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
});

Deno.test({
  name: "Parser rejects constructor type nesting beyond U8 depth",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const parserSource = await Deno.readTextFile(PARSER_SOURCE_FILE);
    assert.include(
      parserSource,
      "match (checkedIncrementU8 depth)",
      "Expected skipBalanced to use checkedIncrementU8 for nested type tracking",
    );
    const ok = await runInlineParserHarness(
      makeCheckedIncrementOverflowHarness(),
    );
    assert.isTrue(
      ok,
      "Expected checkedIncrementU8 to reject U8 overflow while tracking parser nesting depth",
    );
  },
});

Deno.test({
  name: "Parser rejects constructor arity beyond U8 range",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const parserSource = await Deno.readTextFile(PARSER_SOURCE_FILE);
    assert.include(
      parserSource,
      "match (checkedIncrementU8 acc)",
      "Expected parseCtorArity to use checkedIncrementU8 for arity tracking",
    );
    const ok = await runInlineParserHarness(
      makeParseCtorArityOverflowHarness(),
    );
    assert.isTrue(
      ok,
      "Expected parseCtorArity to reject constructor arity overflow at #u8(255)",
    );
  },
});

function makeCheckedIncrementOverflowHarness(): string {
  return `module Test
import Prelude U8
import Prelude Result
import Prelude Ok
import Prelude Err
import Parser checkedIncrementU8

export main
poly main =
  match checkedIncrementU8 #u8(255) [U8] {
    | Err e => #u8(1)
    | Ok res => #u8(0)
  }
`;
}

function makeParseCtorArityOverflowHarness(): string {
  return `module Test
import Prelude U8
import Prelude List
import Prelude nil
import Prelude cons
import Prelude Result
import Prelude Ok
import Prelude Err
import Parser parseCtorArity
import Lexer Token
import Lexer T_Ident
import Lexer T_EOF

export main
poly main =
  let tokens = cons [Token] (T_Ident "A") (cons [Token] T_EOF (nil [Token])) in
  match parseCtorArity tokens #u8(255) [U8] {
    | Err e => #u8(1)
    | Ok res => #u8(0)
  }
`;
}

async function runInlineParserHarness(source: string): Promise<boolean> {
  const parserObj = await getParserObjectCached();
  const lexerObj = await getLexerObjectCached();
  const preludeObj = await getPreludeObjectCached();
  const testObj = compileToObjectFile(source);
  const linked = linkModules([
    { name: "Prelude", object: preludeObj },
    { name: "Lexer", object: lexerObj },
    { name: "Parser", object: parserObj },
    { name: "Test", object: testObj },
  ]);
  const expr = parseSKI(linked);
  const session = await getThanatosSession();
  try {
    const resultDag = await session.reduceDag(toDagWire(expr));
    const resultExpr = fromDagWire(resultDag);
    // resultExpr should be church 1 (#u8(1)) for success
    const result = unparseSKI(resultExpr);
    return result.includes("U01") || result.includes("1");
  } finally {
    await session.close();
  }
}
