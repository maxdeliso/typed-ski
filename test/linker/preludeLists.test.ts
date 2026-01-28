import { assertEquals } from "std/assert";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { evaluateTrip, evaluateTripWithIo } from "../util/tripHarness.ts";

Deno.test("prelude scott lists support head/tail", async () => {
  const source = `module TestList

import Prelude Nat
import Prelude nil
import Prelude cons
import Prelude head
import Prelude tail
import Prelude error
import Prelude List

export main

poly list = cons [Nat] 1 (cons [Nat] 2 (nil [Nat]))

poly main = head [Nat] (tail [Nat] list)`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude scott lists support matchList", async () => {
  const source = `module TestMatchList

import Prelude Nat
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude List

export main

poly emptyResult = matchList [Nat] [Nat] (nil [Nat]) 0 (\\h : Nat => \\t : List => h)
poly consResult = matchList [Nat] [Nat] (cons [Nat] 42 (nil [Nat])) 0
  (\\h : Nat => \\t : List => h)

poly main = consResult`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 42n);
});

Deno.test("string literal length via matchList", async () => {
  const source = `module TestStringLength

import Prelude Nat
import Prelude zero
import Prelude succ
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude List

export main

poly length2 = \\xs : List =>
  matchList [Nat] [Nat] xs zero
    (\\h : Nat => \\t : List =>
      succ (matchList [Nat] [Nat] t zero
        (\\h2 : Nat => \\t2 : List => succ zero)))

poly main = length2 "hi"`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude list combinators map/append/foldl", async () => {
  const source = `module TestListCombinators

import Prelude Nat
import Prelude add
import Prelude succ
import Prelude nil
import Prelude cons
import Prelude List
import Prelude map
import Prelude append
import Prelude foldl
import Prelude matchList

export main

poly list1 = cons [Nat] 1 (cons [Nat] 2 (nil [Nat]))
poly list2 = cons [Nat] 3 (nil [Nat])
poly mapped = map [Nat] [Nat] succ list1
poly combined = append [Nat] mapped list2
poly main = foldl [Nat] [Nat] add 0 combined`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 8n);
});

Deno.test("prelude list combinators takeWhile/dropWhile", async () => {
  const source = `module TestListPrefix

import Prelude Nat
import Prelude add
import Prelude succ
import Prelude isZero
import Prelude true
import Prelude false
import Prelude nil
import Prelude cons
import Prelude List
import Prelude takeWhile
import Prelude dropWhile
import Prelude foldl
import Prelude head
import Prelude if
import Prelude error
import Prelude matchList

export main

poly isLeadingZero = \\n : Nat => isZero n
poly sample = cons [Nat] 0 (cons [Nat] 0 (cons [Nat] 1 (nil [Nat])))
poly taken = takeWhile [Nat] isLeadingZero sample
poly dropped = dropWhile [Nat] isLeadingZero sample
poly count = foldl [Nat] [Nat] (\\acc : Nat => \\_ : Nat => succ acc) 0 taken
poly main = add count (head [Nat] dropped)`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 3n);
});

Deno.test("prelude Result/Pair/ParseError data types", async () => {
  const source = `module TestDataPrelude

import Prelude Nat
import Prelude add
import Prelude List
import Prelude nil
import Prelude Pair
import Prelude ParseError
import Prelude MkParseError
import Prelude Err
import Prelude Ok
import Prelude MkPair

export main

poly parseErr = MkParseError 0 (nil [Nat])
poly okVal = Ok [ParseError] [Nat] 2
poly errVal = Err [ParseError] [Nat] parseErr
poly pair : Pair Nat Nat = MkPair [Nat] [Nat] 1 2

poly fromResult = \\r : #R -> (ParseError -> R) -> (Nat -> R) -> R =>
  r [Nat] (\\e : ParseError => 0) (\\v : Nat => v)

poly sumPair = pair [Nat] (\\a : Nat => \\b : Nat => add a b)

poly main = add sumPair (add (fromResult okVal) (fromResult errVal))`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 5n);
});

Deno.test("trip harness evaluates IO programs", async () => {
  const source = `module EchoOne

import Prelude readOne
import Prelude writeOne

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
