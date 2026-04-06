/**
 * Unit tests for the bootstrapped lexer (lib/compiler/lexer.trip)
 *
 * Tests are organized bottom-up, testing each function in the order
 * they appear in the lexer module. Thanatos-backed cases share the
 * batch-scoped harness session so we keep startup costs down while
 * still resetting the arena between logical test runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { fromDagWire, toDagWire } from "../../lib/ski/dagWire.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import {
  closeBatchThanatosSessions,
  passthroughEvaluator,
  runThanatosBatch,
  thanatosAvailable,
  withBatchThanatosSession,
} from "../thanatosHarness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);

// Cache compiled objects
let lexerObject: TripCObject | null = null;
let preludeObject: TripCObject | null = null;

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

async function compileAndValidateTestProgram(
  inputFileName: string,
): Promise<SKIExpression> {
  const testFilePath = join(__dirname, "inputs", inputFileName);
  const testObj = await loadTripModuleObject(testFilePath);

  const lexerObj = await getLexerObject();
  const preludeObj = await getPreludeObjectCached();

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObj },
    { name: "Lexer", object: lexerObj },
    { name: "Test", object: testObj },
  ]);

  return parseSKI(skiExpression);
}

test(
  "Lexer thanatos suite",
  {
    skip: !thanatosAvailable(),
  },
  async (t) => {
    try {
      await t.test("Lexer - isSpace structure validation", async () => {
        const program = await compileAndValidateTestProgram("testIsSpace.trip");
        const lines = await runThanatosBatch([unparseSKI(program)]);
        const line = lines[0];
        assert.ok(line && line.length > 0, "thanatos should return a result");
        assert.strictEqual(
          await UnChurchBoolean(parseSKI(line!), passthroughEvaluator),
          false,
          "isSpace structure validation",
        );
      });

      await t.test("Lexer - isSpace character codes", async () => {
        const lexerObj = await getLexerObject();
        const preludeObj = await getPreludeObjectCached();

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
import Lexer isSpaceU8
import Prelude Bool
export main
poly main = (isSpaceU8 #u8(${charCode})) [U8] #u8(1) #u8(0)
`;
          const testObj = compileToObjectFile(testSource);
          const skiExpression = linkModules([
            { name: "Prelude", object: preludeObj },
            { name: "Lexer", object: lexerObj },
            { name: "Test", object: testObj },
          ]);
          inputs.push(unparseSKI(parseSKI(skiExpression)));
        }

        const results = await runThanatosBatch(inputs);
        assert.strictEqual(results.length, inputs.length);
        for (let i = 0; i < testCases.length; i++) {
          const tc = testCases[i];
          if (tc === undefined) continue;
          const [charCode, expected] = tc;
          const line = results[i] ?? "";
          assert.ok(
            line && line.length > 0,
            `thanatos should return result for isSpace(${charCode})`,
          );
          const decoded = await UnChurchNumber(
            parseSKI(line),
            passthroughEvaluator,
          );
          assert.strictEqual(
            decoded,
            expected ? 1n : 0n,
            `isSpace(${charCode}) should be ${expected} (got ${decoded}n)`,
          );
        }
      });

      await t.test(
        'Lexer - tokenize "1 2" => T_Nat "1", T_Nat "2", T_EOF',
        async () => {
          const lexerObj = await getLexerObject();
          const preludeObj = await getPreludeObjectCached();

          const testObj = await loadTripModuleObject(
            join(__dirname, "inputs", "testTokenize1Space2.trip"),
          );
          const skiExpression = linkModules([
            { name: "Prelude", object: preludeObj },
            { name: "Lexer", object: lexerObj },
            { name: "Test", object: testObj },
          ]);
          const input = unparseSKI(parseSKI(skiExpression));

          const lines = await runThanatosBatch([input]);
          const line = lines[0];
          assert.ok(line && line.length > 0, "thanatos should return a result");
          assert.ok(
            await UnChurchBoolean(parseSKI(line!), passthroughEvaluator),
            'tokenize "1 2" should yield T_Nat "1", T_Nat "2", T_EOF',
          );
        },
      );

      await t.test("Lexer - structural validations", async () => {
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
          {
            file: "testLexRecKeyword.trip",
            msg: "Expected `rec` in source text to tokenize as T_KwRec",
          },
        ];
        await withBatchThanatosSession(async (session) => {
          for (const tc of structuralTests) {
            const program = await compileAndValidateTestProgram(tc.file);
            const dag = toDagWire(program);
            const resultDag = await session.reduceDag(dag);
            const resultExpr = fromDagWire(resultDag);
            const ok = await UnChurchBoolean(resultExpr, passthroughEvaluator);
            assert.ok(ok, tc.msg);
          }
        });
      });
    } finally {
      await closeBatchThanatosSessions();
    }
  },
);
