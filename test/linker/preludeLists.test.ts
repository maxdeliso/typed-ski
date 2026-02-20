import { assertEquals } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { UnBinNumber } from "../../lib/ski/bin.ts";
import { evaluateTrip, evaluateTripWithIo } from "../util/tripHarness.ts";
import { loadInput } from "../util/fileLoader.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("prelude scott lists support head/tail", async () => {
  const source = loadInput("preludeListHeadTail.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 2n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("prelude scott lists support matchList", async () => {
  const source = loadInput("preludeMatchList.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 42n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("string literal length via matchList", async () => {
  const source = loadInput("stringLengthMatchList.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 2n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("prelude list combinators map/append/foldl", async () => {
  const source = loadInput("preludeListCombinators.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 8n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("prelude list combinators takeWhile/dropWhile", async () => {
  const source = loadInput("preludeListPrefix.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 3n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("prelude Result/Pair/ParseError data types", async () => {
  const source = loadInput("preludeDataPrelude.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 5n);
  } finally {
    evaluator.terminate();
  }
});

Deno.test("trip harness evaluates IO programs", async () => {
  const source = loadInput("echoOne.trip", __dirname);

  const input = new Uint8Array([65]);
  const { result, stdout, evaluator } = await evaluateTripWithIo(source, {
    stdin: input,
    stdoutMaxBytes: 1,
  });

  try {
    assertEquals(stdout.length, 1);
    assertEquals(stdout[0], 65);
    assertEquals(UnBinNumber(result), 65n);
  } finally {
    (evaluator as ParallelArenaEvaluatorWasm).terminate();
  }
});

Deno.test("trip harness evaluates numeric literal main", async () => {
  const source = loadInput("literalMain.trip", __dirname);
  const evaluator = await ParallelArenaEvaluatorWasm.create();
  try {
    const result = await evaluateTrip(source, { evaluator });
    assertEquals(await UnChurchNumber(result, evaluator), 13n);
  } finally {
    evaluator.terminate();
  }
});
