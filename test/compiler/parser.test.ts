import { assert } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
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
  const testObjectFileName = inputFileName.replace(/\.trip$/, ".tripc");
  const testObjectFilePath = join(__dirname, "inputs", testObjectFileName);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      join(__dirname, "..", "..", "bin", "tripc.ts"),
      inputFileName,
      testObjectFileName,
    ],
    cwd: join(__dirname, "inputs"),
  });

  const { code, stderr } = await compileCommand.output();
  if (code !== 0) {
    const errorMsg = new TextDecoder().decode(stderr);
    throw new Error(
      `Failed to compile test program ${inputFileName}: exit code ${code}\n${errorMsg}`,
    );
  }

  const testContent = await Deno.readTextFile(testObjectFilePath);
  return deserializeTripCObject(testContent);
}

async function runTriplangPredicateTest(
  inputFileName: string,
): Promise<boolean> {
  const evaluator = await ParallelArenaEvaluatorWasm.create(1, false, {
    maxResubmits: 0,
  });
  const testFilePath = join(__dirname, "inputs", inputFileName);
  const testObjectPath = testFilePath.replace(/\.trip$/, ".tripc");

  try {
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

    const nf = await evaluator.reduceAsync(parseSKI(skiExpression));
    return UnChurchBoolean(nf);
  } finally {
    evaluator.terminate();
    try {
      await Deno.remove(testObjectPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

Deno.test("Parser stage 1 - parseAtom parses identifiers", async () => {
  const result = await runTriplangPredicateTest("testParseAtom.trip");
  assert.isTrue(
    result,
    'Expected parseAtom([T_Ident "x", T_EOF]) to return E_Var "x"',
  );
});

Deno.test("Parser stage 2 - parseApp parses left-associated application", async () => {
  const result = await runTriplangPredicateTest("testParseApp.trip");
  assert.isTrue(
    result,
    "Expected parseApp([f, x, y, EOF]) to return E_App(E_App(f, x), y)",
  );
});

Deno.test("Parser stage 3 - parseExpr parses typed lambda", async () => {
  const result = await runTriplangPredicateTest(
    "testParseExprLambdaTyped.trip",
  );
  assert.isTrue(
    result,
    "Expected parseExpr to skip lambda type annotation and build E_Lam",
  );
});

Deno.test("Parser stage 3 - parseExpr parses typed let", async () => {
  const result = await runTriplangPredicateTest("testParseExprLetTyped.trip");
  assert.isTrue(
    result,
    "Expected parseExpr to skip let type annotation and build E_Let",
  );
});

Deno.test("Parser stage 3 - parseExpr parses match with typed scrutinee", async () => {
  const result = await runTriplangPredicateTest("testParseExprMatchTyped.trip");
  assert.isTrue(
    result,
    "Expected parseExpr to parse match arms and skip scrutinee type annotation",
  );
});

Deno.test("Parser gap close - parseExpr erases type abstraction", async () => {
  const result = await runTriplangPredicateTest(
    "testParseExprTypeAbstraction.trip",
  );
  assert.isTrue(
    result,
    "Expected #X => body to parse by erasing type abstraction",
  );
});

Deno.test("Parser gap close - parseExpr skips type applications", async () => {
  const result = await runTriplangPredicateTest(
    "testParseExprTypeApplication.trip",
  );
  assert.isTrue(
    result,
    "Expected term [Type] applications to be skipped during parsing",
  );
});

Deno.test("Parser gap close - parseExpr supports combinator punctuation", async () => {
  const result = await runTriplangPredicateTest(
    "testParseExprCombinatorTokens.trip",
  );
  assert.isTrue(
    result,
    "Expected comma/dot combinator tokens to parse as atomic terms",
  );
});

Deno.test("Parser gap close - parseProgram handles top-level forms", async () => {
  const result = await runTriplangPredicateTest("testParseProgramForms.trip");
  assert.isTrue(
    result,
    "Expected parseProgram to parse module/import/export and definitions",
  );
});
