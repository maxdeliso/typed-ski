import { describe, it, before } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { ChurchN, UnChurchNumber } from "../../lib/ski/church.ts";
import { applyMany, type SKIExpression } from "../../lib/ski/expression.ts";
import { B, C, I, K, S } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { ConversionError } from "../../lib/conversion/conversionError.ts";
import { untypedApp, untypedAbs, mkVar } from "../../lib/terms/lambda.ts";
import {
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../lib/terms/systemF.ts";
import { mkTypeVariable, typeApp } from "../../lib/types/types.ts";
import { createArenaEvaluator } from "../../lib/index.ts";

describe("Lambda conversion", () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  const N = 5;
  const id = untypedAbs("x", mkVar("x"));
  const konst = untypedAbs("x", untypedAbs("y", mkVar("x")));
  const flip = untypedAbs(
    "x",
    untypedAbs("y", untypedApp(mkVar("y"), mkVar("x"))),
  );
  const lambdaB = untypedAbs(
    "x",
    untypedAbs(
      "y",
      untypedAbs(
        "z",
        untypedApp(mkVar("x"), untypedApp(mkVar("y"), mkVar("z"))),
      ),
    ),
  );
  const lambdaC = untypedAbs(
    "x",
    untypedAbs(
      "y",
      untypedAbs(
        "z",
        untypedApp(untypedApp(mkVar("x"), mkVar("z")), mkVar("y")),
      ),
    ),
  );
  const lambdaS = untypedAbs(
    "x",
    untypedAbs(
      "y",
      untypedAbs(
        "z",
        untypedApp(
          untypedApp(mkVar("x"), mkVar("z")),
          untypedApp(mkVar("y"), mkVar("z")),
        ),
      ),
    ),
  );
  const selfApply = untypedAbs("x", untypedApp(mkVar("x"), mkVar("x")));

  const reduceToKey = (...exps: Parameters<typeof applyMany>) =>
    arenaEvaluator.reduce(applyMany(...exps));

  describe("basic combinators", () => {
    it("converts identity function (λx.x) to I combinator", () => {
      assert.deepStrictEqual(bracketLambda(id), I);
    });

    it("converts K-like function (λx.λy.x) to equivalent SKI term", async () => {
      // The K combinator should return its first argument.
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const result = await UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(bracketLambda(konst), ChurchN(a), ChurchN(b)),
            ),
            arenaEvaluator,
          );
          assert.strictEqual(result, BigInt(a));
        }
      }
    });
  });

  describe("combinator equivalences", () => {
    it("lambda B behaves like B", () => {
      const args = [I, K, S];
      const reducedLambda = reduceToKey(bracketLambda(lambdaB), ...args);
      const reducedB = reduceToKey(B, ...args);
      assert.deepStrictEqual(reducedLambda, reducedB);
    });

    it("lambda C behaves like C", () => {
      const args = [K, S, I];
      const reducedLambda = reduceToKey(bracketLambda(lambdaC), ...args);
      const reducedC = reduceToKey(C, ...args);
      assert.deepStrictEqual(reducedLambda, reducedC);
    });

    it("lambda S behaves like S", () => {
      const args = [B, C, K];
      const reducedLambda = reduceToKey(bracketLambda(lambdaS), ...args);
      const reducedS = reduceToKey(S, ...args);
      assert.deepStrictEqual(reducedLambda, reducedS);
    });

    it("self-application matches S I I", () => {
      const reducedLambda = reduceToKey(bracketLambda(selfApply), K);
      const reducedExpected = reduceToKey(applyMany(S, I, I), K);
      assert.deepStrictEqual(reducedLambda, reducedExpected);
    });
  });

  describe("arithmetic operations", () => {
    it("computes exponentiation using flip combinator", async () => {
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const expected = BigInt(a) ** BigInt(b);
          const result = await UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(bracketLambda(flip), ChurchN(a), ChurchN(b)),
            ),
            arenaEvaluator,
          );
          assert.strictEqual(result, expected);
        }
      }
    });
  });

  it("toCore conversion errors on unsupported constructs", () => {
    assert.throws(() => bracketLambda(mkVar("x")), {
      message: /free variable detected: x/,
    });

    assert.throws(() => bracketLambda(mkTypeVariable("X") as any), {
      message: /free type variable detected: X/,
    });

    const typeAbs = mkSystemFTAbs("X", mkSystemFVar("x"));
    assert.throws(() => bracketLambda(typeAbs as any), {
      message: /type-level constructs present/,
    });

    const typeAppTerm = mkSystemFTypeApp(
      mkSystemFVar("f"),
      mkTypeVariable("X"),
    );
    assert.throws(() => bracketLambda(typeAppTerm as any), {
      message: /type-level constructs present/,
    });

    const forallType = {
      kind: "forall",
      typeVar: "X",
      body: mkTypeVariable("X"),
    } as const;
    assert.throws(() => bracketLambda(forallType as any), {
      message: /type-level constructs present/,
    });

    const typeApplication = typeApp(mkTypeVariable("F"), mkTypeVariable("X"));
    assert.throws(() => bracketLambda(typeApplication as any), {
      message: /type-level constructs present/,
    });

    const matchTerm: SystemFTerm = {
      kind: "systemF-match",
      scrutinee: mkSystemFVar("x"),
      returnType: mkTypeVariable("R"),
      arms: [],
    };
    assert.throws(() => bracketLambda(matchTerm as any), {
      message: /match expressions are not supported/,
    });

    // Create an object that structurally matches a terminal but has an invalid symbol
    const invalidTerminal = {
      kind: "terminal",
      sym: "Z",
    } as unknown as SKIExpression;

    assert.throws(() => bracketLambda(invalidTerminal), {
      message: /unknown SKI terminal: Z/,
    });
  });
});
