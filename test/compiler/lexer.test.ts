/**
 * Unit tests for the bootstrapped lexer (lib/compiler/lexer.trip)
 *
 * Tests are organized bottom-up, testing each function in the order
 * they appear in the lexer module. Each test runs its own thanatos
 * process to avoid long-running single batches.
 */

import { assert, expect } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import {
  passthroughEvaluator,
  runThanatosBatch,
  runThanatosOne,
  thanatosAvailable,
} from "../thanatosHarness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);

// Cache compiled objects
let lexerObject: TripCObject | null = null;
let preludeObject: TripCObject | null = null;
let natObject: TripCObject | null = null;

async function getLexerObject() {
  if (!lexerObject) {
    lexerObject = await loadTripModuleObject(LEXER_SOURCE_FILE);
  }
  return lexerObject;
}

async function getPreludeObjectCached() {
  if (!preludeObject) {
    preludeObject = await getPreludeObject();
  }
  return preludeObject;
}

async function getNatObjectCached() {
  if (!natObject) {
    natObject = await getNatObject();
  }
  return natObject;
}

async function compileAndValidateTestProgram(
  inputFileName: string,
): Promise<SKIExpression> {
  const testFilePath = join(__dirname, "inputs", inputFileName);
  const testObj = await loadTripModuleObject(testFilePath);

  const lexerObj = await getLexerObject();
  const preludeObj = await getPreludeObjectCached();
  const natObj = await getNatObjectCached();

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObj },
    { name: "Nat", object: natObj },
    { name: "Lexer", object: lexerObj },
    { name: "Test", object: testObj },
  ]);

  return parseSKI(skiExpression);
}

Deno.test({
  name: "Lexer - isSpace structure validation",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const program = await compileAndValidateTestProgram("testIsSpace.trip");
    const line = await runThanatosOne(unparseSKI(program));
    assert.isNotEmpty(line, "thanatos should return a result");
    assert.equal(
      await UnChurchBoolean(parseSKI(line), passthroughEvaluator),
      false,
      "isSpace structure validation",
    );
  },
});

Deno.test({
  name: "Lexer - isSpace character codes",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const lexerObj = await getLexerObject();
    const preludeObj = await getPreludeObjectCached();
    const natObj = await getNatObjectCached();

    const testCases: Array<[number, boolean]> = [
      [32, true],
      [10, true],
      [13, true],
      [9, true],
      [0, false],
      [65, false],
      [97, false],
      [48, false],
    ];
    const inputs: string[] = [];
    for (const [charCode] of testCases) {
      const testSource = `module Test
import Lexer isSpaceBin
export main
poly main = isSpaceBin ${charCode}
`;
      const testObj = compileToObjectFile(testSource);
      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObj },
        { name: "Nat", object: natObj },
        { name: "Lexer", object: lexerObj },
        { name: "Test", object: testObj },
      ]);
      inputs.push(unparseSKI(parseSKI(skiExpression)));
    }

    const results = await runThanatosBatch(inputs);
    assert.equal(results.length, inputs.length);
    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      if (tc === undefined) continue;
      const [charCode, expected] = tc;
      const line = results[i] ?? "";
      assert.isNotEmpty(
        line,
        `thanatos should return result for isSpace(${charCode})`,
      );
      expect(
        await UnChurchBoolean(parseSKI(line), passthroughEvaluator),
        `isSpace(${charCode}) should be ${expected}`,
      ).to.equal(expected);
    }
  },
});

Deno.test({
  name: "Lexer - tokenize count",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const lexerObj = await getLexerObject();
    const preludeObj = await getPreludeObjectCached();
    const natObj = await getNatObjectCached();

    const testObj = await loadTripModuleObject(
      join(__dirname, "inputs", "testTokenizeLength.trip"),
    );
    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObj },
      { name: "Nat", object: natObj },
      { name: "Lexer", object: lexerObj },
      { name: "Test", object: testObj },
    ]);
    const input = unparseSKI(parseSKI(skiExpression));

    const line = await runThanatosOne(input);
    assert.isNotEmpty(line, "thanatos should return a result");
    assert.equal(
      await UnChurchNumber(parseSKI(line), passthroughEvaluator),
      3n,
      "tokenize count",
    );
  },
});

Deno.test({
  name: "Lexer - structural validations",
  ignore: true, // TODO: still too slow
  fn: async () => {
    const inputs: string[] = [];
    for (
      const file of [
        "testLexIdentVsKw.trip",
        "testLexNat.trip",
        "testLexArrows.trip",
        "testLexCoreKeywords.trip",
      ]
    ) {
      const program = await compileAndValidateTestProgram(file);
      inputs.push(unparseSKI(program));
    }

    const results = await runThanatosBatch(inputs);
    assert.equal(results.length, inputs.length);

    const structuralTests = [
      {
        file: "testLexIdentVsKw.trip",
        msg: "Expected `abc` => T_Ident and `poly` => T_KwPoly",
      },
      {
        file: "testLexNat.trip",
        msg: "Expected `123` => T_Nat 123 followed by T_EOF",
      },
      {
        file: "testLexArrows.trip",
        msg: "Expected `->` => T_Arrow, `=>` => T_FatArrow, and `=` => T_Eq",
      },
      {
        file: "testLexCoreKeywords.trip",
        msg: "Expected let/match/in to tokenize as dedicated keyword tokens",
      },
    ];
    for (let i = 0; i < structuralTests.length; i++) {
      const tc = structuralTests[i];
      if (tc === undefined) continue;
      const line = results[i] ?? "";
      const ok = line !== "" &&
        await UnChurchBoolean(parseSKI(line), passthroughEvaluator).catch(() =>
          false
        );
      assert.isTrue(ok, tc.msg);
    }
  },
});
