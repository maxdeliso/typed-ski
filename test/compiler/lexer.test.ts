/**
 * Unit tests for the bootstrapped lexer (lib/compiler/lexer.trip)
 *
 * Tests are organized bottom-up, testing each function in the order
 * they appear in the lexer module.
 */

import { assert, expect } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { type SKIExpression, toSKIKey } from "../../lib/ski/expression.ts";
import { UnChurchBoolean } from "../../lib/ski/church.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lexerObjectPath = join(
  __dirname,
  "..",
  "..",
  "lib",
  "compiler",
  "lexer.tripc",
);
const lexerSourcePath = join(
  __dirname,
  "..",
  "..",
  "lib",
  "compiler",
  "lexer.trip",
);

// Cache compiled objects
let lexerObject: ReturnType<typeof deserializeTripCObject> | null = null;
let preludeObject: Awaited<ReturnType<typeof getPreludeObject>> | null = null;

async function getLexerObject() {
  if (!lexerObject) {
    // Load the pre-compiled lexer object file, or generate it if missing (CI).
    // The repo may not include build artifacts like `lexer.tripc`.
    try {
      await Deno.stat(lexerObjectPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        const compileCommand = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-read",
            "--allow-write",
            join(__dirname, "..", "..", "bin", "tripc.ts"),
            lexerSourcePath,
            lexerObjectPath,
          ],
        });

        const { code, stderr } = await compileCommand.output();
        if (code !== 0) {
          const errorMsg = new TextDecoder().decode(stderr);
          throw new Error(
            `Failed to compile lexer module (${lexerSourcePath}) into (${lexerObjectPath}): exit code ${code}\n${errorMsg}`,
          );
        }
      } else {
        throw e;
      }
    }

    const lexerContent = await Deno.readTextFile(lexerObjectPath);
    lexerObject = deserializeTripCObject(lexerContent);
  }
  return lexerObject;
}

async function getPreludeObjectCached() {
  if (!preludeObject) {
    preludeObject = await getPreludeObject();
  }
  return preludeObject;
}

// Helper to compile a test program from an input file using CLI compiler
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

async function compileAndValidateTestProgram(
  inputFileName: string,
): Promise<SKIExpression> {
  // Step 1: Compile the test program
  const testObj = await compileTestProgram(inputFileName);

  // Validate compiled object structure
  expect(testObj).to.not.be.null;
  expect(testObj.module).to.equal("Test");
  expect(testObj.exports).to.be.an("array");
  expect(testObj.exports).to.include("main");
  expect(testObj.definitions).to.be.an("object");
  expect(testObj.definitions).to.have.property("main");

  // Step 2: Link modules
  const lexerObj = await getLexerObject();
  const preludeObj = await getPreludeObjectCached();

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObj },
    { name: "Lexer", object: lexerObj },
    { name: "Test", object: testObj },
  ], true);

  expect(skiExpression).to.be.a("string");
  expect(skiExpression.length).to.be.greaterThan(0);
  return parseSKI(skiExpression);
}

Deno.test("Lexer unit tests - bottom up", async (t) => {
  await t.step(
    "isSpace - structure validation",
    async () => {
      const program = await compileAndValidateTestProgram("testIsSpace.trip");
      const evaluator = await ParallelArenaEvaluatorWasm.create();

      try {
        const nf = await evaluator.reduceAsync(program);
        const decodedResult = UnChurchBoolean(nf);
        assert.equal(decodedResult, false);
      } finally {
        evaluator.terminate();
      }
    },
  );

  await t.step(
    "isSpace - iterates over character codes and validates results",
    async () => {
      // Test cases: [characterCode, expectedResult]
      const testCases: Array<[number, boolean]> = [
        [32, true], // space
        [10, true], // newline '\n'
        [13, true], // carriage return
        [9, true], // tab
        [0, false], // null
        [65, false], // 'A'
        [97, false], // 'a'
        [48, false], // '0'
      ];

      const lexerObj = await getLexerObject();
      const preludeObj = await getPreludeObjectCached();

      for (const [charCode, expected] of testCases) {
        // Create test source for this character code
        const testSource = `module Test

import Lexer isSpace
import Prelude eq
import Prelude or
import Prelude true
import Prelude false
import Prelude Nat
import Prelude Bool

export main

poly main = isSpace ${charCode}
`;

        try {
          // Compile using CLI compiler to handle Prelude dependencies
          const testFileName = `test_isSpace_${charCode}.trip`;
          const testObjectFileName = `test_isSpace_${charCode}.tripc`;
          const testFilePath = join(__dirname, testFileName);
          const testObjectFilePath = join(__dirname, testObjectFileName);

          const evaluator = await ParallelArenaEvaluatorWasm.create();

          try {
            await Deno.writeTextFile(testFilePath, testSource);

            const compileCommand = new Deno.Command(Deno.execPath(), {
              args: [
                "run",
                "--allow-read",
                "--allow-write",
                "../../bin/tripc.ts",
                testFileName,
                testObjectFileName,
              ],
              cwd: __dirname,
            });

            const { code, stderr } = await compileCommand.output();
            if (code !== 0) {
              const errorMsg = new TextDecoder().decode(stderr);
              throw new Error(
                `Failed to compile test program ${testFileName}: exit code ${code}\n${errorMsg}`,
              );
            }

            const testContent = await Deno.readTextFile(testObjectFilePath);
            const testObj = deserializeTripCObject(testContent);

            const skiExpression = linkModules([
              { name: "Prelude", object: preludeObj },
              { name: "Lexer", object: lexerObj },
              { name: "Test", object: testObj },
            ], true); // Enable verbose mode to debug type resolution

            // Parse and evaluate
            const skiExpr = parseSKI(skiExpression);
            const nf = await evaluator.reduceAsync(skiExpr);
            const decodedResult = UnChurchBoolean(nf);

            expect(
              decodedResult,
              `isSpace(${charCode}) should be ${expected}, but got ${decodedResult}`,
            ).to.equal(expected);
          } finally {
            evaluator.terminate();

            // Cleanup temp files
            try {
              await Deno.remove(testFilePath);
              await Deno.remove(testObjectFilePath);
            } catch {
              // Ignore cleanup errors
            }
          }
        } catch (error) {
          throw new Error(
            `Failed to test isSpace(${charCode}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  );
});

Deno.test("tokenize - verify token count for lexer.trip input", async () => {
  const testSource = `module Test

import Lexer tokenize
import Lexer tokenizeAcc
import Lexer Token
import Lexer reverse
import Prelude Nat
import Prelude zero
import Prelude succ
import Prelude nil
import Prelude cons
import Prelude foldl
import Prelude Result
import Prelude Err
import Prelude Ok
import Prelude ParseError
import Prelude List

export main

poly rec length = \\xs : List Token =>
  foldl [Token] [Nat]
    (\\acc : Nat => \\_ : Token => succ acc)
    zero
    xs

poly main =
  match (tokenize "1 2") [Nat] {
    | Err _ => zero
    | Ok tokens => length tokens
  }`;

  const evaluator = await ParallelArenaEvaluatorWasm.create();
  const testFileName = "testTokenizeLength.trip";
  const testFilePath = join(__dirname, "inputs", testFileName);

  await Deno.writeTextFile(testFilePath, testSource);

  try {
    const testObj = await compileTestProgram(testFileName);
    const lexerObj = await getLexerObject();
    const preludeObj = await getPreludeObjectCached();

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObj },
      { name: "Lexer", object: lexerObj },
      { name: "Test", object: testObj },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const key = toSKIKey(skiExpr);

    console.log("Evaluating program with ", key.length, " terminals");

    const nf = arenaEvaluator.reduce(skiExpr);
    const tokenCount = UnChurchNumber(nf);

    console.log(`Token count: ${tokenCount}`);

    assert.equal(tokenCount, 2n);
  } finally {
    evaluator.terminate();

    try {
      await Deno.remove(testFilePath);
      const testObjectPath = testFilePath.replace(/\.trip$/, ".tripc");
      await Deno.remove(testObjectPath);
    } catch {
      // Ignore cleanup errors
    }
  }
});
