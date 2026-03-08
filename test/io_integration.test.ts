import { assertEquals } from "std/assert";
import { ParallelArenaEvaluatorWasm } from "../lib/evaluator/parallelArenaEvaluator.ts";
import { compileToObjectFile } from "../lib/compiler/singleFileCompiler.ts";
import { getBinObject } from "../lib/bin.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { getNatObject } from "../lib/nat.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";

async function runTripWithParallelEvaluator(
  source: string,
  stdin?: Uint8Array,
) {
  const moduleObject = compileToObjectFile(source);
  const prelude = await getPreludeObject();
  const bin = await getBinObject();
  const nat = await getNatObject();
  const skiExpression = linkModules([
    { name: "Prelude", object: prelude },
    { name: "Bin", object: bin },
    { name: "Nat", object: nat },
    { name: "Main", object: moduleObject },
  ]).expression;
  const skiExpr = parseSKI(skiExpression);
  const evaluator = await ParallelArenaEvaluatorWasm.create(1);

  if (stdin) {
    await evaluator.writeStdin(stdin);
  }

  const resultExpr = await evaluator.reduceAsync(skiExpr);
  const stdout = await evaluator.readStdout(4096);

  return { result: resultExpr, stdout, evaluator };
}

Deno.test("IO Integration - Hello World", async () => {
  const source = `
module Main
import Prelude writeOne
import Prelude U8
import Prelude List
import Prelude nil
import Prelude cons
import Prelude id

export main

poly main =
  writeOne #u8(65) [U8] (\\x : U8 => x)
  `;

  const { stdout, evaluator } = await runTripWithParallelEvaluator(source);
  try {
    const decoder = new TextDecoder();
    assertEquals(decoder.decode(stdout), "A");
  } finally {
    evaluator.terminate();
  }
});

Deno.test("IO Integration - ReadLine and StrLen", async () => {
  const source = `
module Main
import Prelude readOne
import Prelude writeOne
import Prelude eqU8
import Prelude U8
import Prelude List
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude if
import Nat Nat
import Nat zero
import Nat succ

export main

poly rec readLine = #R => \\k : List U8 -> R =>
  readOne [R] (\\c : U8 =>
    if [R] (eqU8 c #u8(10))
      (\\u : U8 => k (nil [U8]))
      (\\u : U8 => readLine [R] (\\rest : List U8 => k (cons [U8] c rest)))
  )

poly rec length = #A => \\l : List A =>
  match l [Nat] {
    | nil => zero
    | cons _ t => succ (length [A] t)
  }

poly main =
  readLine [Nat] (\\line : List U8 => length [U8] line)
  `;

  const stdin = new TextEncoder().encode("trip\n");
  const { result, evaluator } = await runTripWithParallelEvaluator(
    source,
    stdin,
  );

  try {
    const len = await UnChurchNumber(result, evaluator);
    assertEquals(len, 4n);
  } finally {
    evaluator.terminate();
  }
});
