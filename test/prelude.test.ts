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
import Prelude cond
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
  add
    (cond [Nat] (not false) 1 0)
    (add
      (cond [Nat] (and true true) 1 0)
      (add
        (cond [Nat] (or false true) 1 0)
        (add
          (pred 2)
          (add
            (sub 3 1)
            (add
              (cond [Nat] (lte 1 2) 1 0)
              (cond [Nat] (gte 2 1) 1 0))))))
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
