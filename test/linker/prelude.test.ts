import { assertEquals, assertThrows } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ArithmeticCase {
  key: string;
  testFileName: string;
  moduleName: string;
}

const ARITHMETIC_CASES: ArithmeticCase[] = [
  {
    key: "basic",
    testFileName: "inputs/prelude_arithmetic.trip",
    moduleName: "TestArithmetic",
  },
  {
    key: "simple",
    testFileName: "inputs/prelude_simple.trip",
    moduleName: "TestSimple",
  },
  {
    key: "multiplication",
    testFileName: "inputs/prelude_mult.trip",
    moduleName: "TestMultiplication",
  },
  {
    key: "complex",
    testFileName: "inputs/prelude_complex.trip",
    moduleName: "TestComplexArithmetic",
  },
];

async function compileTripFile(fileName: string): Promise<void> {
  const compileCommand = new Deno.Command(Deno.execPath(), {
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
  const { code } = await compileCommand.output();
  assertEquals(code, 0, `${fileName} should compile successfully`);
}

async function evaluateExpressionsBatch(
  items: Array<{ key: string; expr: SKIExpression }>,
): Promise<Map<string, bigint>> {
  const reduced = await Promise.all(
    items.map(async ({ key, expr }) => {
      const evaluator = await ParallelArenaEvaluatorWasm.create();
      try {
        const arenaMode = (evaluator as unknown as {
          $?: { getArenaMode?: () => number };
        }).$?.getArenaMode?.();
        assertEquals(
          arenaMode,
          1,
          "Prelude linker batch tests must run in shared-memory (multithreaded) arena mode",
        );
        const evaluated = await evaluator.reduceAsync(expr);
        return [key, UnChurchNumber(evaluated)] as const;
      } finally {
        evaluator.terminate();
      }
    }),
  );
  return new Map(reduced);
}

async function runArithmeticBatch(): Promise<Map<string, bigint>> {
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();
  const compiledFiles: string[] = [];

  try {
    for (const testCase of ARITHMETIC_CASES) {
      await compileTripFile(testCase.testFileName);
      compiledFiles.push(testCase.testFileName.replace(".trip", ".tripc"));
    }

    const expressions: Array<{ key: string; expr: SKIExpression }> = [];
    for (const testCase of ARITHMETIC_CASES) {
      const testContent = await Deno.readTextFile(
        `${__dirname}/${testCase.testFileName.replace(".trip", ".tripc")}`,
      );
      const testObject = deserializeTripCObject(testContent);
      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObject },
        { name: "Nat", object: natObject },
        { name: testCase.moduleName, object: testObject },
      ], false);
      expressions.push({ key: testCase.key, expr: parseSKI(skiExpression) });
    }

    return await evaluateExpressionsBatch(expressions);
  } finally {
    for (const file of compiledFiles) {
      try {
        await Deno.remove(`${__dirname}/${file}`);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

Deno.test("links prelude arithmetic cases (batched)", async () => {
  const results = await runArithmeticBatch();

  const basic = results.get("basic");
  const simple = results.get("simple");
  const multiplication = results.get("multiplication");
  const complex = results.get("complex");

  assertEquals(basic, 6n, "mul two three should equal 6");
  assertEquals(simple, 2n, "add one one should equal 2");
  assertEquals(multiplication, 6n, "mul two three should equal 6");
  // (2 * 3) + (1 * 4) = 6 + 4 = 10
  assertEquals(complex, 10n, "Complex arithmetic should equal 10");
});

Deno.test("links numeric literals across modules without leaking Nat", async () => {
  const preludeObject = await getPreludeObject();
  const natObject = await getNatObject();

  const providerFileName = "inputs/prelude_literal_provider.trip";
  const consumerFileName = "inputs/prelude_literal_consumer.trip";

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
      `${__dirname}/inputs/prelude_literal_provider.tripc`,
    );
    const consumerBytes = await Deno.readTextFile(
      `${__dirname}/inputs/prelude_literal_consumer.tripc`,
    );
    const providerObject = deserializeTripCObject(providerBytes);
    const consumerObject = deserializeTripCObject(consumerBytes);

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Nat", object: natObject },
      { name: "LiteralProvider", object: providerObject },
      { name: "LiteralConsumer", object: consumerObject },
    ], false);

    const skiExpr = parseSKI(skiExpression);
    const decoded = await (async () => {
      const evaluator = await ParallelArenaEvaluatorWasm.create();
      try {
        const arenaMode = (evaluator as unknown as {
          $?: { getArenaMode?: () => number };
        }).$?.getArenaMode?.();
        assertEquals(
          arenaMode,
          1,
          "Prelude linker tests must run in shared-memory (multithreaded) arena mode",
        );
        const evaluated = await evaluator.reduceAsync(skiExpr);
        return UnChurchNumber(evaluated);
      } finally {
        evaluator.terminate();
      }
    })();
    assertEquals(decoded, 3n, "linked literal should evaluate to 3");
  } finally {
    for (
      const file of [
        "inputs/prelude_literal_provider.tripc",
        "inputs/prelude_literal_consumer.tripc",
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

  const conflictingFileName = "inputs/prelude_conflicting_nat.trip";

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
      `${__dirname}/inputs/prelude_conflicting_nat.tripc`,
    );
    const conflictingObject = deserializeTripCObject(conflictingBytes);

    assertThrows(
      () => {
        linkModules([
          { name: "Prelude", object: preludeObject },
          { name: "Nat", object: natObject },
          { name: "ConflictingNat", object: conflictingObject },
        ], false);
      },
      Error,
      "Ambiguous export 'Nat' found in multiple modules",
    );
  } finally {
    for (
      const file of [
        "inputs/prelude_conflicting_nat.tripc",
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
