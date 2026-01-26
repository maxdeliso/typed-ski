import { assertEquals } from "std/assert";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { evaluateTrip, evaluateTripWithIo } from "../util/tripHarness.ts";

Deno.test("prelude scott lists support head/tail", async () => {
  const source = `module TestList

import Nat Prelude
import nil Prelude
import cons Prelude
import head Prelude
import tail Prelude
import error Prelude
import List Prelude

export main

poly list = cons [Nat] 1 (cons [Nat] 2 (nil [Nat]))

poly main = head [Nat] (tail [Nat] list)`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude scott lists support matchList", async () => {
  const source = `module TestMatchList

import Nat Prelude
import nil Prelude
import cons Prelude
import matchList Prelude
import List Prelude

export main

poly emptyResult = matchList [Nat] [Nat] (nil [Nat]) 0 (\\h : Nat => \\t : List => h)
poly consResult = matchList [Nat] [Nat] (cons [Nat] 42 (nil [Nat])) 0
  (\\h : Nat => \\t : List => h)

poly main = consResult`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 42n);
});

Deno.test("trip harness evaluates IO programs", async () => {
  const source = `module EchoOne

import readOne Prelude
import writeOne Prelude

export main

combinator main = , .`;

  const input = new Uint8Array([65]);
  const { result, stdout } = await evaluateTripWithIo(source, {
    stdin: input,
    stdoutMaxBytes: 1,
  });

  assertEquals(stdout.length, 1);
  assertEquals(stdout[0], 65);
  assertEquals(UnChurchNumber(result), 65n);
});

Deno.test("trip harness evaluates numeric literal main", async () => {
  const source = `module LiteralMain

export main

poly main = 65`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 65n);
});
