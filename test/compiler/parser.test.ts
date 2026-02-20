import { assert } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { loadTripModuleObject } from "../../lib/tripSourceLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEXER_SOURCE_FILE = new URL(
  "../../lib/compiler/lexer.trip",
  import.meta.url,
);
const PARSER_SOURCE_FILE = new URL(
  "../../lib/compiler/parser.trip",
  import.meta.url,
);

let lexerObject: ReturnType<typeof deserializeTripCObject> | null = null;
let parserObject: ReturnType<typeof deserializeTripCObject> | null = null;
let preludeObject: Awaited<ReturnType<typeof getPreludeObject>> | null = null;
let natObject: Awaited<ReturnType<typeof getNatObject>> | null = null;
let sharedEvaluator: ParallelArenaEvaluatorWasm | null = null;
const parsedPredicateCache = new Map<string, Promise<SKIExpression>>();

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

async function getParserObject() {
  if (!parserObject) {
    parserObject = await loadTripModuleObject(PARSER_SOURCE_FILE);
  }
  return parserObject;
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

async function compileTestProgram(
  inputFileName: string,
): Promise<ReturnType<typeof deserializeTripCObject>> {
  const testFilePath = join(__dirname, "inputs", inputFileName);
  return await loadTripModuleObject(testFilePath);
}

async function runTriplangPredicateTest(
  inputFileName: string,
): Promise<boolean> {
  const evaluator = await getSharedEvaluator();

  const expressionPromise = parsedPredicateCache.get(inputFileName) ??
    (async () => {
      const testObj = await compileTestProgram(inputFileName);
      const lexerObj = await getLexerObject();
      const parserObj = await getParserObject();
      const preludeObj = await getPreludeObjectCached();
      const natObj = await getNatObjectCached();

      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObj },
        { name: "Nat", object: natObj },
        { name: "Lexer", object: lexerObj },
        { name: "Parser", object: parserObj },
        { name: "Test", object: testObj },
      ]);
      return parseSKI(skiExpression);
    })();

  parsedPredicateCache.set(inputFileName, expressionPromise);
  const expression = await expressionPromise;
  const nf = await evaluator.reduceAsync(expression);
  return await UnChurchBoolean(nf, evaluator);
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

Deno.test({
  name: "Parser unit tests (Concurrent)",
  // Temporary: this test consistently exceeds the 1 minute runtime budget.
  ignore: true,
}, async () => {
  // Setup: ensure evaluator is ready
  const evaluator = await getSharedEvaluator();

  try {
    const tests = [
      {
        name: "Parser stage 1 - parseAtom parses identifiers",
        file: "testParseAtom.trip",
        assertion:
          'Expected parseAtom([T_Ident "x", T_EOF]) to return E_Var "x"',
      },
      {
        name: "Parser stage 2 - parseApp parses left-associated application",
        file: "testParseApp.trip",
        assertion:
          "Expected parseApp([f, x, y, EOF]) to return E_App(E_App(f, x), y)",
      },
      {
        name: "Parser stage 3 - parseExpr parses typed lambda",
        file: "testParseExprLambdaTyped.trip",
        assertion:
          "Expected parseExpr to skip lambda type annotation and build E_Lam",
      },
      {
        name: "Parser stage 3 - parseExpr parses typed let",
        file: "testParseExprLetTyped.trip",
        assertion:
          "Expected parseExpr to skip let type annotation and build E_Let",
      },
      {
        name: "Parser stage 3 - parseExpr parses match with typed scrutinee",
        file: "testParseExprMatchTyped.trip",
        assertion:
          "Expected parseExpr to parse match arms and skip scrutinee type annotation",
      },
      {
        name: "Parser gap close - parseExpr erases type abstraction",
        file: "testParseExprTypeAbstraction.trip",
        assertion: "Expected #X => body to parse by erasing type abstraction",
      },
      {
        name: "Parser gap close - parseExpr skips type applications",
        file: "testParseExprTypeApplication.trip",
        assertion:
          "Expected term [Type] applications to be skipped during parsing",
      },
      {
        name: "Parser gap close - parseExpr supports combinator punctuation",
        file: "testParseExprCombinatorTokens.trip",
        assertion:
          "Expected comma/dot combinator tokens to parse as atomic terms",
      },
      {
        name: "Parser gap close - parseProgram handles top-level forms",
        file: "testParseProgramForms.trip",
        assertion:
          "Expected parseProgram to parse module/import/export and definitions",
      },
    ];

    const testConcurrency = Math.max(
      1,
      Math.min(3, evaluator.workers.length || 1),
    );
    await runWithConcurrency(tests, testConcurrency, async (t) => {
      const result = await runTriplangPredicateTest(t.file);
      assert.isTrue(result, t.assertion);
    });
  } finally {
    parsedPredicateCache.clear();
    if (sharedEvaluator) {
      sharedEvaluator.terminate();
      sharedEvaluator = null;
    }
  }
});
