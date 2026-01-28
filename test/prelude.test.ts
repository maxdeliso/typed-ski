import { assertEquals } from "std/assert";
import { compileToObjectFileString } from "../lib/compiler/index.ts";
import { deserializeTripCObject } from "../lib/compiler/objectFile.ts";
import { arenaEvaluator } from "../lib/evaluator/skiEvaluator.ts";
import { linkModules } from "../lib/linker/moduleLinker.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { getPreludeObject } from "../lib/prelude.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";

const PRELUDE_TEST = `module TestPrelude

import Prelude zero
import Prelude succ
import Prelude add
import Prelude not
import Prelude and
import Prelude or
import Prelude pair
import Prelude fst
import Prelude snd
import Prelude pred
import Prelude sub
import Prelude isZero
import Prelude lte
import Prelude gte
import Prelude true
import Prelude false
import Prelude Nat

export main

poly main =
  let a = (not false) [Nat] (succ zero) zero in
  let b = add a ((and true true) [Nat] (succ zero) zero) in
  let c = add b ((or false true) [Nat] (succ zero) zero) in
  let d = add c (pred (succ (succ zero))) in
  let e = add d (sub (succ (succ (succ zero))) (succ zero)) in
  let f = add e ((lte (succ zero) (succ (succ zero))) [Nat] (succ zero) zero) in
  add f ((gte (succ (succ zero)) (succ zero)) [Nat] (succ zero) zero)
`;

Deno.test("links prelude with not, and, or, pred, sub, lte, gte", async () => {
  const preludeObject = await getPreludeObject();
  const serialized = compileToObjectFileString(PRELUDE_TEST);
  const testObject = deserializeTripCObject(serialized);

  const skiExpression = linkModules([
    { name: "Prelude", object: preludeObject },
    { name: "TestPrelude", object: testObject },
  ], true);

  const skiExpr = parseSKI(skiExpression);
  const evaluated = arenaEvaluator.reduce(skiExpr);
  const decoded = UnChurchNumber(evaluated);
  assertEquals(
    decoded,
    8n,
    "not/and/or/pred/sub/lte/gte expressions should sum to 8",
  );
});
