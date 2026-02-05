import { expect } from "chai";

import { parseLambda } from "../../lib/parser/untyped.ts";
import { makeUntypedChurchNumeral } from "../../lib/consts/nat.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { ChurchN, UnChurchNumber } from "../../lib/ski/church.ts";
import {
  apply,
  applyMany,
  type SKIExpression,
} from "../../lib/ski/expression.ts";
import { B, C, I, K, S } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { ConversionError } from "../../lib/conversion/conversionError.ts";
import {
  createApplication,
  mkUntypedAbs,
  mkVar,
} from "../../lib/terms/lambda.ts";
import type { UntypedLambda } from "../../lib/terms/lambda.ts";
import {
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFTerm,
} from "../../lib/terms/systemF.ts";
import { mkTypeVariable, typeApp } from "../../lib/types/types.ts";

Deno.test("Lambda conversion", async (t) => {
  const N = 5;
  const id = mkUntypedAbs("x", mkVar("x"));
  const konst = mkUntypedAbs("x", mkUntypedAbs("y", mkVar("x")));
  const flip = mkUntypedAbs(
    "x",
    mkUntypedAbs("y", createApplication(mkVar("y"), mkVar("x"))),
  );
  const lambdaB = mkUntypedAbs(
    "x",
    mkUntypedAbs(
      "y",
      mkUntypedAbs(
        "z",
        createApplication(
          mkVar("x"),
          createApplication(mkVar("y"), mkVar("z")),
        ),
      ),
    ),
  );
  const lambdaC = mkUntypedAbs(
    "x",
    mkUntypedAbs(
      "y",
      mkUntypedAbs(
        "z",
        createApplication(
          createApplication(mkVar("x"), mkVar("z")),
          mkVar("y"),
        ),
      ),
    ),
  );
  const lambdaS = mkUntypedAbs(
    "x",
    mkUntypedAbs(
      "y",
      mkUntypedAbs(
        "z",
        createApplication(
          createApplication(mkVar("x"), mkVar("z")),
          createApplication(mkVar("y"), mkVar("z")),
        ),
      ),
    ),
  );
  const selfApply = mkUntypedAbs(
    "x",
    createApplication(mkVar("x"), mkVar("x")),
  );

  const reduceToKey = (...exps: Parameters<typeof applyMany>) =>
    arenaEvaluator.reduce(applyMany(...exps));

  await t.step("basic combinators", async (t) => {
    await t.step("converts identity function (λx.x) to I combinator", () => {
      expect(bracketLambda(id)).to.deep.equal(I);
    });

    await t.step(
      "converts K-like function (λx.λy.x) to equivalent SKI term",
      () => {
        // The K combinator should return its first argument.
        for (let a = 0; a < N; a++) {
          for (let b = 0; b < N; b++) {
            const result = UnChurchNumber(
              arenaEvaluator.reduce(
                applyMany(bracketLambda(konst), ChurchN(a), ChurchN(b)),
              ),
            );
            expect(result).to.equal(BigInt(a));
          }
        }
      },
    );
  });

  await t.step("combinator equivalences", async (t) => {
    await t.step("lambda B behaves like B", () => {
      const args = [I, K, S];
      const reducedLambda = reduceToKey(
        bracketLambda(lambdaB),
        ...args,
      );
      const reducedB = reduceToKey(B, ...args);
      expect(reducedLambda).to.deep.equal(reducedB);
    });

    await t.step("lambda C behaves like C", () => {
      const args = [K, S, I];
      const reducedLambda = reduceToKey(
        bracketLambda(lambdaC),
        ...args,
      );
      const reducedC = reduceToKey(C, ...args);
      expect(reducedLambda).to.deep.equal(reducedC);
    });

    await t.step("lambda S behaves like S", () => {
      const args = [B, C, K];
      const reducedLambda = reduceToKey(
        bracketLambda(lambdaS),
        ...args,
      );
      const reducedS = reduceToKey(S, ...args);
      expect(reducedLambda).to.deep.equal(reducedS);
    });

    await t.step("self-application matches S I I", () => {
      const reducedLambda = reduceToKey(
        bracketLambda(selfApply),
        K,
      );
      const reducedExpected = reduceToKey(applyMany(S, I, I), K);
      expect(reducedLambda).to.deep.equal(reducedExpected);
    });
  });

  await t.step("arithmetic operations", async (t) => {
    await t.step("computes exponentiation using flip combinator", () => {
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
          const result = UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(bracketLambda(flip), ChurchN(a), ChurchN(b)),
            ),
          );
          expect(result).to.equal(BigInt(expected));
        }
      }
    });

    await t.step("converts predecessor function to equivalent SKI term", () => {
      const [, predLambda] = parseLambda(
        "\\n=>\\f=>\\x=>n(\\g=>\\h=>h(g f))(\\u=>x)(\\u=>u)",
      );
      for (let n = 0; n < N; n++) {
        const expected = Math.max(n - 1, 0); // pred(0) is defined as 0.
        const result = UnChurchNumber(
          arenaEvaluator.reduce(
            apply(bracketLambda(predLambda), ChurchN(n)),
          ),
        );
        expect(result).to.equal(BigInt(expected));
      }
    });
  });

  await t.step("nat literal lowers via church encoder", () => {
    const literal: UntypedLambda = makeUntypedChurchNumeral(8n);
    const ski = bracketLambda(literal);
    const result = UnChurchNumber(arenaEvaluator.reduce(ski));
    expect(result).to.equal(8n);
  });

  await t.step("toCore conversion errors on unsupported constructs", () => {
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
