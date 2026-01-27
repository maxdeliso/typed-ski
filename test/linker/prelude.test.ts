import { assertEquals, assertThrows } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("links prelude with basic arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  // Create a test module that uses prelude functions
  const testSource = `module TestArithmetic

import Prelude zero
import Prelude succ
import Prelude add
import Prelude mul
import Prelude Nat

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
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 6n, "mul two three should equal 6");
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

import Prelude zero
import Prelude succ
import Prelude add
import Prelude Nat

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
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 2n, "add one one should equal 2");
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

import Prelude zero
import Prelude succ
import Prelude mul
import Prelude Nat

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
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 6n, "mul two three should equal 6");
  } finally {
    try {
      await Deno.remove(`${__dirname}/test-mult.trip`);
      await Deno.remove(`${__dirname}/test-mult.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links numeric literals across modules without leaking Nat", async () => {
  const preludeObject = await getPreludeObject();

  const providerSource = `module LiteralProvider

import Prelude Nat

export lit

poly lit = 3
`;

  const consumerSource = `module LiteralConsumer

import LiteralProvider lit

export main

poly main = lit
`;

  const providerFileName = "literal-provider.trip";
  const consumerFileName = "literal-consumer.trip";

  await Deno.writeTextFile(`${__dirname}/${providerFileName}`, providerSource);
  await Deno.writeTextFile(`${__dirname}/${consumerFileName}`, consumerSource);

  const compile = async (fileName: string) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        fileName,
        fileName.replace(".trip", ".tripc"),
      ],
      cwd: __dirname,
    });
    const { code } = await command.output();
    assertEquals(code, 0, `${fileName} should compile successfully`);
  };

  try {
    await compile(providerFileName);
    await compile(consumerFileName);

    const providerBytes = await Deno.readTextFile(
      `${__dirname}/literal-provider.tripc`,
    );
    const consumerBytes = await Deno.readTextFile(
      `${__dirname}/literal-consumer.tripc`,
    );
    const providerObject = deserializeTripCObject(providerBytes);
    const consumerObject = deserializeTripCObject(consumerBytes);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "LiteralProvider", object: providerObject },
      { name: "LiteralConsumer", object: consumerObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 3n, "linked literal should evaluate to 3");
  } finally {
    for (
      const file of [
        "literal-provider.trip",
        "literal-provider.tripc",
        "literal-consumer.trip",
        "literal-consumer.tripc",
      ]
    ) {
      try {
        await Deno.remove(`${__dirname}/${file}`);
      } catch {
        // ignore
      }
    }
  }
});

Deno.test("fails to link when module exports Nat conflicting with Prelude", async () => {
  const preludeObject = await getPreludeObject();

  const conflictingSource = `module ConflictingNat

export Nat

type Nat = #X -> (X -> X) -> X -> X

poly main = 3
`;

  const conflictingFileName = "conflicting-nat.trip";

  await Deno.writeTextFile(
    `${__dirname}/${conflictingFileName}`,
    conflictingSource,
  );

  const compile = async (fileName: string) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "../../bin/tripc.ts",
        fileName,
        fileName.replace(".trip", ".tripc"),
      ],
      cwd: __dirname,
    });
    const { code } = await command.output();
    assertEquals(code, 0, `${fileName} should compile successfully`);
  };

  try {
    await compile(conflictingFileName);

    const conflictingBytes = await Deno.readTextFile(
      `${__dirname}/conflicting-nat.tripc`,
    );
    const conflictingObject = deserializeTripCObject(conflictingBytes);

    assertThrows(
      () => {
        linkModules([
          { name: "Prelude", object: preludeObject },
          { name: "ConflictingNat", object: conflictingObject },
        ], true);
      },
      Error,
      "Ambiguous export 'Nat' found in multiple modules",
    );
  } finally {
    for (const file of ["conflicting-nat.trip", "conflicting-nat.tripc"]) {
      try {
        await Deno.remove(`${__dirname}/${file}`);
      } catch {
        // ignore
      }
    }
  }
});

Deno.test("links prelude with complex arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();

  const testSource = `module TestComplexArithmetic

import Prelude zero
import Prelude succ
import Prelude add
import Prelude mul
import Prelude Nat

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
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    // (2 * 3) + (1 * 4) = 6 + 4 = 10
    assertEquals(decoded, 10n, "Complex arithmetic should equal 10");
  } finally {
    try {
      await Deno.remove(`${__dirname}/test-complex.trip`);
      await Deno.remove(`${__dirname}/test-complex.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});
