import { describe, it } from "./util/test_shim.ts";
import assert from "node:assert/strict";
import { createThanatosEvaluator, thanatosAvailable } from "../lib/index.ts";
import { compileToObjectFile } from "../lib/compiler/singleFileCompiler.ts";
import { getBinObject } from "../lib/bin.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { getNatObject } from "../lib/nat.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";

async function runTripWithThanatosEvaluator(
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
  ]);
  const skiExpr = parseSKI(skiExpression);
  const evaluator = await createThanatosEvaluator({ workers: 1 });
  const { result, stdout } = await evaluator.reduceWithIo(
    skiExpr,
    stdin ?? new Uint8Array(0),
  );
  return { result, stdout, evaluator };
}

it("IO Integration - Hello World", { skip: !thanatosAvailable() }, async () => {
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

  const { stdout, evaluator } = await runTripWithThanatosEvaluator(source);
  try {
    const decoder = new TextDecoder();
    assert.deepStrictEqual(decoder.decode(stdout), "A");
  } finally {
    await evaluator.terminate();
  }
});

it(
  "IO Integration - ReadLine and StrLen",
  { skip: !thanatosAvailable() },
  async () => {
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
    const { result, evaluator } = await runTripWithThanatosEvaluator(
      source,
      stdin,
    );

    try {
      const len = await UnChurchNumber(result, evaluator);
      assert.deepStrictEqual(len, 4n);
    } finally {
      await evaluator.terminate();
    }
  },
);
