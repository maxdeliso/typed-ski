import { assertEquals } from "std/assert";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import { UnBinNumber } from "../../lib/ski/bin.ts";
import { evaluateTrip, evaluateTripWithIo } from "../util/tripHarness.ts";

Deno.test("prelude scott lists support head/tail", async () => {
  const source = `module TestList

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude nil
import Prelude cons
import Prelude head
import Prelude tail
import Prelude error
import Prelude List

export main

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly list = cons [Bin] 1 (cons [Bin] 2 (nil [Bin]))

poly main = binToChurch (head [Bin] (tail [Bin] list))`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude scott lists support matchList", async () => {
  const source = `module TestMatchList

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude List

export main

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly emptyResult = matchList [Bin] [Bin] (nil [Bin]) 0 (\\h : Bin => \\t : List => h)
poly consResult = matchList [Bin] [Bin] (cons [Bin] 42 (nil [Bin])) 0
  (\\h : Bin => \\t : List => h)

poly main = binToChurch consResult`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 42n);
});

Deno.test("string literal length via matchList", async () => {
  const source = `module TestStringLength

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude incBin
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude List

export main

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly length2 = \\xs : List =>
  matchList [Bin] [Bin] xs 0
    (\\h : Bin => \\t : List =>
      incBin (matchList [Bin] [Bin] t 0
        (\\h2 : Bin => \\t2 : List => incBin 0)))

poly main = binToChurch (length2 "hi")`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 2n);
});

Deno.test("prelude list combinators map/append/foldl", async () => {
  const source = `module TestListCombinators

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude addBin
import Prelude incBin
import Prelude nil
import Prelude cons
import Prelude List
import Prelude map
import Prelude append
import Prelude foldl
import Prelude matchList

export main

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly list1 = cons [Bin] 1 (cons [Bin] 2 (nil [Bin]))
poly list2 = cons [Bin] 3 (nil [Bin])
poly mapped = map [Bin] [Bin] incBin list1
poly combined = append [Bin] mapped list2
poly main = binToChurch (foldl [Bin] [Bin] addBin 0 combined)`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 8n);
});

Deno.test("prelude list combinators takeWhile/dropWhile", async () => {
  const source = `module TestListPrefix

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude addBin
import Prelude incBin
import Prelude isZeroBin
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

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly isLeadingZero = \\n : Bin => isZeroBin n
poly sample = cons [Bin] 0 (cons [Bin] 0 (cons [Bin] 1 (nil [Bin])))
poly taken = takeWhile [Bin] isLeadingZero sample
poly dropped = dropWhile [Bin] isLeadingZero sample
poly count = foldl [Bin] [Bin] (\\acc : Bin => \\_ : Bin => incBin acc) 0 taken
poly main = binToChurch (addBin count (head [Bin] dropped))`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 3n);
});

Deno.test("prelude Result/Pair/ParseError data types", async () => {
  const source = `module TestDataPrelude

import Prelude List
import Prelude nil
import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1
import Prelude addBin
import Prelude Pair
import Prelude ParseError
import Prelude MkParseError
import Prelude Err
import Prelude Ok
import Prelude MkPair

export main

poly parseErr = MkParseError 0 (nil [Bin])
poly okVal = Ok [ParseError] [Bin] 2
poly errVal = Err [ParseError] [Bin] parseErr
poly pair : Pair Bin Bin = MkPair [Bin] [Bin] 1 2

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly fromResult = \\r : #R -> (ParseError -> R) -> (Bin -> R) -> R =>
  r [Bin] (\\e : ParseError => 0) (\\v : Bin => v)

poly sumPair = pair [Bin] (\\a : Bin => \\b : Bin => addBin a b)

poly main = binToChurch (addBin sumPair (addBin (fromResult okVal) (fromResult errVal)))`;

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
  assertEquals(UnBinNumber(result), 65n);
});

Deno.test("trip harness evaluates numeric literal main", async () => {
  const source = `module LiteralMain

export main

import Prelude Bin
import Prelude BZ
import Prelude B0
import Prelude B1

type Church = #X -> (X -> X) -> X -> X

poly zero : Church = #X => \\s : X -> X => \\z : X => z
poly succ : Church = \\n : Church => #X => \\s : X -> X => \\z : X => s (n [X] s z)
poly dbl : Church = \\n : Church => #X => \\s : X -> X => \\z : X => n [X] s (n [X] s z)

poly rec binToChurch = \\b : Bin =>
  match b [Church] {
    | BZ => zero
    | B0 rest => dbl (binToChurch rest)
    | B1 rest => succ (dbl (binToChurch rest))
  }

poly main = binToChurch 13`;

  const result = await evaluateTrip(source);
  assertEquals(UnChurchNumber(result), 13n);
});
