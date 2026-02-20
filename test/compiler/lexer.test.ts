/**
 * Unit tests for the bootstrapped lexer (lib/compiler/lexer.trip)
 *
 * Tests are organized bottom-up, testing each function in the order
 * they appear in the lexer module.
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
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);

// Cache compiled objects
let lexerObject: TripCObject | null = null;
let preludeObject: TripCObject | null = null;
let natObject: TripCObject | null = null;
let sharedEvaluator: ParallelArenaEvaluatorWasm | null = null;

async function getSharedEvaluator() {
  if (!sharedEvaluator) {
    sharedEvaluator = await ParallelArenaEvaluatorWasm.create(
      undefined,
      false,
      {
        maxResubmits: 0,
      },
    );
  }
  return sharedEvaluator;
}

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

  // Step 2: Link modules
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

async function runTriplangPredicateTest(
  inputFileName: string,
): Promise<boolean> {
  const evaluator = await getSharedEvaluator();
  const program = await compileAndValidateTestProgram(inputFileName);
  const nf = await evaluator.reduceAsync(program);
  return await UnChurchBoolean(nf, evaluator);
}

Deno.test("Lexer unit tests - optimized", async (t) => {
  const evaluator = await getSharedEvaluator();

  try {
    await t.step("isSpace - structure validation", async () => {
      const program = await compileAndValidateTestProgram("testIsSpace.trip");
      const nf = await evaluator.reduceAsync(program);
      assert.equal(await UnChurchBoolean(nf, evaluator), false);
    });

    await t.step("isSpace - character code iteration", async () => {
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

      const lexerObj = await getLexerObject();
      const preludeObj = await getPreludeObjectCached();
      const natObj = await getNatObjectCached();

      for (const [charCode, expected] of testCases) {
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
        const nf = await evaluator.reduceAsync(parseSKI(skiExpression));
        expect(
          await UnChurchBoolean(nf, evaluator),
          `isSpace(${charCode}) should be ${expected}`,
        ).to.equal(expected);
      }
    });

    await t.step("tokenize - verify token count", async () => {
      const preludeObj = await getPreludeObjectCached();
      const natObj = await getNatObjectCached();
      const lexerObj = await getLexerObject();
      const testObj = await loadTripModuleObject(
        join(__dirname, "inputs", "testTokenizeLength.trip"),
      );
      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObj },
        { name: "Nat", object: natObj },
        { name: "Lexer", object: lexerObj },
        { name: "Test", object: testObj },
      ]);
      const nf = await evaluator.reduceAsync(parseSKI(skiExpression));
      assert.equal(await UnChurchNumber(nf, evaluator), 3n);
    });

    await t.step("structural lexer validations", async () => {
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

      for (const t of structuralTests) {
        const result = await runTriplangPredicateTest(t.file);
        assert.isTrue(result, t.msg);
      }
    });
  } finally {
    if (sharedEvaluator) {
      sharedEvaluator.terminate();
      sharedEvaluator = null;
    }
  }
});
