import { test } from "node:test";
import { expect } from "../util/assertions.ts";
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

test("Lambda conversion", async (t) => {
  let arenaEvaluator = await createArenaEvaluator();

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

  await t.test("basic combinators", async (t) => {
    await t.test("converts identity function (λx.x) to I combinator", () => {
      expect(bracketLambda(id)).to.deep.equal(I);
    });

    await t.test(
      "converts K-like function (λx.λy.x) to equivalent SKI term",
      async () => {
        // The K combinator should return its first argument.
        for (let a = 0; a < N; a++) {
          for (let b = 0; b < N; b++) {
            const result = await UnChurchNumber(
              arenaEvaluator.reduce(
                applyMany(bracketLambda(konst), ChurchN(a), ChurchN(b)),
              ),
              arenaEvaluator,
            );
            expect(result).to.equal(BigInt(a));
          }
        }
      },
    );
  });

  await t.test("combinator equivalences", async (t) => {
    await t.test("lambda B behaves like B", () => {
      const args = [I, K, S];
      const reducedLambda = reduceToKey(bracketLambda(lambdaB), ...args);
      const reducedB = reduceToKey(B, ...args);
      expect(reducedLambda).to.deep.equal(reducedB);
    });

    await t.test("lambda C behaves like C", () => {
      const args = [K, S, I];
      const reducedLambda = reduceToKey(bracketLambda(lambdaC), ...args);
      const reducedC = reduceToKey(C, ...args);
      expect(reducedLambda).to.deep.equal(reducedC);
    });

    await t.test("lambda S behaves like S", () => {
      const args = [B, C, K];
      const reducedLambda = reduceToKey(bracketLambda(lambdaS), ...args);
      const reducedS = reduceToKey(S, ...args);
      expect(reducedLambda).to.deep.equal(reducedS);
    });

    await t.test("self-application matches S I I", () => {
      const reducedLambda = reduceToKey(bracketLambda(selfApply), K);
      const reducedExpected = reduceToKey(applyMany(S, I, I), K);
      expect(reducedLambda).to.deep.equal(reducedExpected);
    });
  });

  await t.test("arithmetic operations", async (t) => {
    await t.test("computes exponentiation using flip combinator", async () => {
      /**
       * flip is defined as:    flip ≡ λx.λy. y x
       *
       * When applied to Church numerals a and b:
       *   flip a b = (λx.λy. y x) a b
       *           = (λy. y a) b
       *           = b a
       *
       * In Church encoding, numeral b represents: λf.λx. fᵇ(x)
       * so "b a" means applying the function a b times,
       * i.e. computing aᵇ (a raised to the power of b).
       *
       * Therefore, semantically, flip a b should evaluate to aᵇ.
       */
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const expected = a ** b; // exponentiation: a^b
          const result = await UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(bracketLambda(flip), ChurchN(a), ChurchN(b)),
            ),
            arenaEvaluator,
          );
          expect(result).to.equal(BigInt(expected));
        }
      }
    });
  });

  await t.test("toCore conversion errors on unsupported constructs", () => {
    expect(() => bracketLambda(mkVar("x"))).to.throw(
      ConversionError,
      /free variable detected: x/,
    );

    expect(() => bracketLambda(mkTypeVariable("X"))).to.throw(
      ConversionError,
      /free type variable detected: X/,
    );

    const typeAbs = mkSystemFTAbs("X", mkSystemFVar("x"));
    expect(() => bracketLambda(typeAbs)).to.throw(
      ConversionError,
      /type-level constructs present/,
    );

    const typeAppTerm = mkSystemFTypeApp(
      mkSystemFVar("f"),
      mkTypeVariable("X"),
    );
    expect(() => bracketLambda(typeAppTerm)).to.throw(
      ConversionError,
      /type-level constructs present/,
    );

    const forallType = {
      kind: "forall",
      typeVar: "X",
      body: mkTypeVariable("X"),
    } as const;
    expect(() => bracketLambda(forallType)).to.throw(
      ConversionError,
      /type-level constructs present/,
    );

    const typeApplication = typeApp(mkTypeVariable("F"), mkTypeVariable("X"));
    expect(() => bracketLambda(typeApplication)).to.throw(
      ConversionError,
      /type-level constructs present/,
    );

    const matchTerm: SystemFTerm = {
      kind: "systemF-match",
      scrutinee: mkSystemFVar("x"),
      returnType: mkTypeVariable("R"),
      arms: [],
    };
    expect(() => bracketLambda(matchTerm)).to.throw(
      ConversionError,
      /match expressions are not supported/,
    );

    // Create an object that structurally matches a terminal but has an invalid symbol
    const invalidTerminal = {
      kind: "terminal",
      sym: "Z",
    } as unknown as SKIExpression;

    expect(() => bracketLambda(invalidTerminal)).to.throw(
      ConversionError,
      /unknown SKI terminal: Z/,
    );
  });
});
