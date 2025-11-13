import { assert, assertEquals } from "std/assert";
import rsexport, { type RandomSeed } from "random-seed";
const { create } = rsexport;

import {
  type ArenaEvaluatorWasm,
  createArenaEvaluator,
} from "../../lib/evaluator/arenaEvaluator.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { prettyPrint } from "../../lib/ski/expression.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";

let arenaEval: ArenaEvaluatorWasm;

async function setupEvaluator() {
  arenaEval = await createArenaEvaluator();
}

// Setup before all tests
await setupEvaluator();

Deno.test("stepOnce", async (t) => {
  const e1 = parseSKI("III");
  const e2 = parseSKI("II");
  const e3 = parseSKI("I");
  const e4 = parseSKI("KIS");
  const e5 = parseSKI("SKKI");
  const e6 = parseSKI("SKKII");
  const e7 = parseSKI("KI(KI)");

  await t.step(`${prettyPrint(e2)} ⇒ ${prettyPrint(e3)}`, () => {
    const r = arenaEval.stepOnce(e2);
    assertEquals(r.altered, true);
    assertEquals(prettyPrint(r.expr), prettyPrint(e3));
  });

  await t.step(`${prettyPrint(e1)} ⇒ ${prettyPrint(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e1);
    const r2 = arenaEval.stepOnce(r1.expr);

    assert(r1.altered && r2.altered);
    assertEquals(prettyPrint(r2.expr), prettyPrint(e3));
  });

  await t.step(`${prettyPrint(e4)} ⇒ ${prettyPrint(e3)}`, () => {
    const r = arenaEval.stepOnce(e4);
    assert(r.altered);
    assertEquals(prettyPrint(r.expr), prettyPrint(e3));
  });

  await t.step(`${prettyPrint(e5)} ⇒ ${prettyPrint(e7)}`, () => {
    const r = arenaEval.stepOnce(e5);
    assert(r.altered);
    assertEquals(prettyPrint(r.expr), prettyPrint(e7));
  });

  await t.step(`${prettyPrint(e6)} ⇒ ${prettyPrint(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e6);
    const r2 = arenaEval.stepOnce(r1.expr);
    const r3 = arenaEval.stepOnce(r2.expr);

    assert(r1.altered && r2.altered && r3.altered);
    assertEquals(prettyPrint(r3.expr), prettyPrint(e3));
  });
});

Deno.test("singleton and fresh arena reduction equivalence", async (t) => {
  const seed = "df394b";
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  const rs: RandomSeed = create(seed);

  await t.step("runs random-expression normalisation checks", () => {
    for (let testIdx = 0; testIdx < normalizeTests; ++testIdx) {
      const len = rs.intBetween(minLength, maxLength);
      const input = randExpression(rs, len);

      const arenaNormal = arenaEval.reduce(input);
      const symNormal = arenaEvaluator.reduce(input);

      assertEquals(
        prettyPrint(arenaNormal),
        prettyPrint(symNormal),
        `Mismatch in test #${testIdx + 1}:\nexpected: ${
          prettyPrint(symNormal)
        }\ngot: ${prettyPrint(arenaNormal)}`,
      );
    }
  });
});
