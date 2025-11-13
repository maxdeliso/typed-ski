import { assertEquals } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { symbolicEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("links prelude with basic arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  // Create a test module that uses prelude functions
  const testSource = `module TestArithmetic

import zero Prelude
import succ Prelude
import add Prelude
import mul Prelude
import Nat Prelude

export main

poly one = succ zero
poly two = succ one
poly three = succ two

poly main = mul two three`;

  // Write test source to file
  const testFileName = "test-arithmetic.trip";
  const testFilePath = `${__dirname}/${testFileName}`;
  await Deno.writeTextFile(testFilePath, testSource);

  // Compile the test module
  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      testFileName,
      testFileName.replace(".trip", ".tripc"),
    ],
    cwd: __dirname,
  });

  const { code: compileCode } = await compileCommand.output();
  assertEquals(compileCode, 0, "Test module should compile successfully");

  try {
    // Load test module
    const testContent = await Deno.readTextFile(
      `${__dirname}/test-arithmetic.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    // Link modules
    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "TestArithmetic", object: testObject },
    ], true);

    // Parse the SKI expression string and evaluate it
    const skiExpr = parseSKI(skiExpression);
    const evaluated = symbolicEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 6, "mul two three should equal 6");
  } finally {
    // Cleanup
    try {
      await Deno.remove(`${__dirname}/test-arithmetic.trip`);
      await Deno.remove(`${__dirname}/test-arithmetic.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links prelude with simple arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  const testSource = `module TestSimple

import zero Prelude
import succ Prelude
import add Prelude
import Nat Prelude

export main

poly one = succ zero
poly two = succ one

poly main = add one one`;

  // Write test source to file
  const testFileName = "test-simple.trip";
  const testFilePath = `${__dirname}/${testFileName}`;
  await Deno.writeTextFile(testFilePath, testSource);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      testFileName,
      testFileName.replace(".trip", ".tripc"),
    ],
    cwd: __dirname,
  });

  const { code: compileCode } = await compileCommand.output();
  assertEquals(
    compileCode,
    0,
    "Simple test module should compile successfully",
  );

  try {
    const testContent = await Deno.readTextFile(
      `${__dirname}/test-simple.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "TestSimple", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = symbolicEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 2, "add one one should equal 2");
  } finally {
    try {
      await Deno.remove(`${__dirname}/test-simple.trip`);
      await Deno.remove(`${__dirname}/test-simple.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links prelude with multiplication", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  const testSource = `module TestMultiplication

import zero Prelude
import succ Prelude
import mul Prelude
import Nat Prelude

export main

poly one = succ zero
poly two = succ one
poly three = succ two

poly main = mul two three`;

  // Write test source to file
  const testFileName = "test-mult.trip";
  const testFilePath = `${__dirname}/${testFileName}`;
  await Deno.writeTextFile(testFilePath, testSource);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      testFileName,
      testFileName.replace(".trip", ".tripc"),
    ],
    cwd: __dirname,
  });

  const { code: compileCode } = await compileCommand.output();
  assertEquals(
    compileCode,
    0,
    "Multiplication test module should compile successfully",
  );

  try {
    const testContent = await Deno.readTextFile(`${__dirname}/test-mult.tripc`);
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "TestMultiplication", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = symbolicEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 6, "mul two three should equal 6");
  } finally {
    try {
      await Deno.remove(`${__dirname}/test-mult.trip`);
      await Deno.remove(`${__dirname}/test-mult.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links prelude with complex arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  const testSource = `module TestComplexArithmetic

import zero Prelude
import succ Prelude
import add Prelude
import mul Prelude
import Nat Prelude

export main

poly one = succ zero
poly two = succ one
poly three = succ two
poly four = succ three
poly five = succ four

poly main = add (mul two three) (mul one four)`;

  // Write test source to file
  const testFileName = "test-complex.trip";
  const testFilePath = `${__dirname}/${testFileName}`;
  await Deno.writeTextFile(testFilePath, testSource);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      testFileName,
      testFileName.replace(".trip", ".tripc"),
    ],
    cwd: __dirname,
  });

  const { code: compileCode } = await compileCommand.output();
  assertEquals(
    compileCode,
    0,
    "Complex arithmetic test module should compile successfully",
  );

  try {
    const testContent = await Deno.readTextFile(
      `${__dirname}/test-complex.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "TestComplexArithmetic", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = symbolicEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    // (2 * 3) + (1 * 4) = 6 + 4 = 10
    assertEquals(decoded, 10, "Complex arithmetic should equal 10");
  } finally {
    try {
      await Deno.remove(`${__dirname}/test-complex.trip`);
      await Deno.remove(`${__dirname}/test-complex.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});
