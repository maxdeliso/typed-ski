import { assertEquals } from "std/assert";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { UnBinNumber } from "../../lib/ski/bin.ts";
import { evaluateTrip, evaluateTripWithIo } from "../util/tripHarness.ts";
import { loadInput } from "../util/fileLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("prelude scott lists support head/tail", async () => {
  const source = loadInput("preludeListHeadTail.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude scott lists support matchList", async () => {
  const source = loadInput("preludeMatchList.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 42n);
});

Deno.test("string literal length via matchList", async () => {
  const source = loadInput("stringLengthMatchList.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude list combinators map/append/foldl", async () => {
  const source = loadInput("preludeListCombinators.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 8n);
});

Deno.test("prelude list combinators takeWhile/dropWhile", async () => {
  const source = loadInput("preludeListPrefix.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 3n);
});

Deno.test("prelude Result/Pair/ParseError data types", async () => {
  const source = loadInput("preludeDataPrelude.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 5n);
});

Deno.test("trip harness evaluates IO programs", async () => {
  const source = loadInput("echoOne.trip", __dirname);

  const input = new Uint8Array([65]);
  const { result, stdout } = await evaluateTripWithIo(source, {
    stdin: input,
    stdoutMaxBytes: 1,
  });

  assertEquals(stdout.length, 1);
  assertEquals(stdout[0], 65);
  assertEquals(UnBinNumber(result), 65n);
});

Deno.test("trip harness evaluates numeric literal main", async () => {
  const source = loadInput("literalMain.trip", __dirname);

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 13n);
});
