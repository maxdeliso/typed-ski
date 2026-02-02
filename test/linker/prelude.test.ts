import { assertEquals, assertThrows } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("links prelude with basic arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  // Create a test module that uses prelude functions
  const testSource = `module TestArithmetic

import Nat zero
import Nat succ
import Nat add
import Nat mul
import Nat Nat

export main

poly one = succ zero
poly two = succ one
poly three = succ two

poly main = mul two three`;

  // Write test source to file (prelude_ prefix for parallel-safe distinct names)
  const testFileName = "prelude_arithmetic.trip";
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
      `${__dirname}/prelude_arithmetic.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    // Link modules
    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
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
      await Deno.remove(`${__dirname}/prelude_arithmetic.trip`);
      await Deno.remove(`${__dirname}/prelude_arithmetic.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links prelude with simple arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  const testSource = `module TestSimple

import Nat zero
import Nat succ
import Nat add
import Nat Nat

export main

poly one = succ zero
poly two = succ one

poly main = add one one`;

  // Write test source to file (prelude_ prefix for parallel-safe distinct names)
  const testFileName = "prelude_simple.trip";
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
      `${__dirname}/prelude_simple.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
      { name: "TestSimple", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 2n, "add one one should equal 2");
  } finally {
    try {
      await Deno.remove(`${__dirname}/prelude_simple.trip`);
      await Deno.remove(`${__dirname}/prelude_simple.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links prelude with multiplication", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  const testSource = `module TestMultiplication

import Nat zero
import Nat succ
import Nat mul
import Nat Nat

export main

poly one = succ zero
poly two = succ one
poly three = succ two

poly main = mul two three`;

  // Write test source to file (prelude_ prefix for parallel-safe distinct names)
  const testFileName = "prelude_mult.trip";
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
    const testContent = await Deno.readTextFile(
      `${__dirname}/prelude_mult.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
      { name: "TestMultiplication", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    assertEquals(decoded, 6n, "mul two three should equal 6");
  } finally {
    try {
      await Deno.remove(`${__dirname}/prelude_mult.trip`);
      await Deno.remove(`${__dirname}/prelude_mult.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("links numeric literals across modules without leaking Nat", async () => {
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  const providerSource = `module LiteralProvider

import Nat Nat
import Nat fromBin

export lit

poly lit = fromBin 3
`;

  const consumerSource = `module LiteralConsumer

import LiteralProvider lit

export main

poly main = lit
`;

  const providerFileName = "prelude_literal_provider.trip";
  const consumerFileName = "prelude_literal_consumer.trip";

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
      `${__dirname}/prelude_literal_provider.tripc`,
    );
    const consumerBytes = await Deno.readTextFile(
      `${__dirname}/prelude_literal_consumer.tripc`,
    );
    const providerObject = deserializeTripCObject(providerBytes);
    const consumerObject = deserializeTripCObject(consumerBytes);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
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
        "prelude_literal_provider.trip",
        "prelude_literal_provider.tripc",
        "prelude_literal_consumer.trip",
        "prelude_literal_consumer.tripc",
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
  const natObject = await getNatObject();

  const conflictingSource = `module ConflictingNat

export Nat

type Nat = #X -> (X -> X) -> X -> X

poly main = 3
`;

  const conflictingFileName = "prelude_conflicting_nat.trip";

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
      `${__dirname}/prelude_conflicting_nat.tripc`,
    );
    const conflictingObject = deserializeTripCObject(conflictingBytes);

    assertThrows(
      () => {
        linkModules([
          { name: "Prelude", object: preludeObject },
          { name: "Nat", object: natObject },
          { name: "ConflictingNat", object: conflictingObject },
        ], true);
      },
      Error,
      "Ambiguous export 'Nat' found in multiple modules",
    );
  } finally {
    for (
      const file of [
        "prelude_conflicting_nat.trip",
        "prelude_conflicting_nat.tripc",
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

Deno.test("links prelude with complex arithmetic", async () => {
  // Get the bundled prelude object
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  const testSource = `module TestComplexArithmetic

import Nat zero
import Nat succ
import Nat add
import Nat mul
import Nat Nat

export main

poly one = succ zero
poly two = succ one
poly three = succ two
poly four = succ three
poly five = succ four

poly main = add (mul two three) (mul one four)`;

  // Write test source to file (prelude_ prefix for parallel-safe distinct names)
  const testFileName = "prelude_complex.trip";
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
      `${__dirname}/prelude_complex.tripc`,
    );
    const testObject = deserializeTripCObject(testContent);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
      { name: "TestComplexArithmetic", object: testObject },
    ], true);

    const skiExpr = parseSKI(skiExpression);
    const evaluated = arenaEvaluator.reduce(skiExpr);
    const decoded = UnChurchNumber(evaluated);
    // (2 * 3) + (1 * 4) = 6 + 4 = 10
    assertEquals(decoded, 10n, "Complex arithmetic should equal 10");
  } finally {
    try {
      await Deno.remove(`${__dirname}/prelude_complex.trip`);
      await Deno.remove(`${__dirname}/prelude_complex.tripc`);
    } catch {
      // Ignore cleanup errors
    }
  }
});
