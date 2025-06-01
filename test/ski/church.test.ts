import { expect } from "npm:chai";

import {
  B,
  Car,
  Cdr,
  F,
  False,
  Fst,
  Plus,
  Snd,
  Succ,
  True,
  V,
  Zero,
} from "../../lib/consts/combinators.ts";
import { symbolicEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import {
  ChurchB,
  ChurchN,
  UnChurchBoolean,
  UnChurchNumber,
} from "../../lib/ski/church.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { predLambda } from "../../lib/consts/lambdas.ts";
import { apply } from "../../lib/ski/expression.ts";

// isZero ≡ F True (KF)
const IsZero = apply(F, True, apply(K, False));

/* λp. <Succ (Car p), Car p>  — pair-shifting successor */
const pairShiftSucc = apply(
  S,
  apply(apply(B, apply(B, V, Succ)), apply(B, apply(B, I, Car), I)),
  apply(B, apply(B, I, Car), I),
);

const pairZeroZero = apply(V, ChurchN(0), ChurchN(0));

Deno.test("Church encodings", async (t) => {
  const N = 5;

  await t.step("succ / basic arithmetic", async (t) => {
    await t.step("0 + 1 = 1", () => {
      expect(UnChurchNumber(apply(Succ, ChurchN(0)))).to.equal(1);
    });

    await t.step("1 + 1 = 2", () => {
      expect(
        UnChurchNumber(symbolicEvaluator.reduce(apply(Succ, ChurchN(1)))),
      ).to.equal(2);
    });
  });

  await t.step("boolean logic (AND / OR in Church encoding)", () => {
    [false, true].forEach((p) => {
      [false, true].forEach((q) => {
        const conj = p && q;
        const dis = p || q;

        // AND ≡ λpq.p q p
        expect(
          UnChurchBoolean(
            symbolicEvaluator.reduce(apply(ChurchB(p), ChurchB(q), ChurchB(p))),
          ),
        ).to.equal(conj);

        // OR  ≡ λpq.p p q
        expect(
          UnChurchBoolean(
            symbolicEvaluator.reduce(apply(ChurchB(p), ChurchB(p), ChurchB(q))),
          ),
        ).to.equal(dis);
      });
    });
  });

  await t.step("pairs (make, fst, snd, car, cdr)", () => {
    expect(
      UnChurchNumber(
        symbolicEvaluator.reduce(apply(V, ChurchN(0), ChurchN(1), Fst)),
      ),
    ).to.equal(0);

    expect(
      UnChurchNumber(
        symbolicEvaluator.reduce(apply(V, ChurchN(0), ChurchN(1), Snd)),
      ),
    ).to.equal(1);

    expect(
      UnChurchNumber(
        symbolicEvaluator.reduce(
          apply(Car, apply(V, ChurchN(0), ChurchN(1))),
        ),
      ),
    ).to.equal(0);

    expect(
      UnChurchNumber(
        symbolicEvaluator.reduce(
          apply(Cdr, apply(V, ChurchN(0), ChurchN(1))),
        ),
      ),
    ).to.equal(1);
  });

  await t.step("isZero predicate", () => {
    // definition-style tests
    expect(
      UnChurchBoolean(
        symbolicEvaluator.reduce(apply(ChurchN(0), apply(K, False), True)),
      ),
    ).to.equal(true);

    expect(
      UnChurchBoolean(
        symbolicEvaluator.reduce(apply(ChurchN(1), apply(K, False), True)),
      ),
    ).to.equal(false);

    // IsZero combinator
    expect(
      UnChurchBoolean(symbolicEvaluator.reduce(apply(IsZero, ChurchN(0)))),
    ).to.equal(true);

    expect(
      UnChurchBoolean(symbolicEvaluator.reduce(apply(IsZero, ChurchN(1)))),
    ).to.equal(false);
  });

  await t.step("sums and products (0‥N-1)", () => {
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        // m + n   via λmn.(m succ) n
        expect(
          UnChurchNumber(
            symbolicEvaluator.reduce(apply(ChurchN(m), Succ, ChurchN(n))),
          ),
        ).to.equal(m + n);

        // m + n   via Plus combinator
        expect(
          UnChurchNumber(
            symbolicEvaluator.reduce(apply(Plus, ChurchN(m), ChurchN(n))),
          ),
        ).to.equal(m + n);

        // m * n   via λmn.m (n succ) 0
        expect(
          UnChurchNumber(
            symbolicEvaluator.reduce(
              apply(ChurchN(m), apply(ChurchN(n), Succ), Zero),
            ),
          ),
        ).to.equal(m * n);

        // m * n   via B combinator
        expect(
          UnChurchNumber(
            symbolicEvaluator.reduce(
              apply(B, ChurchN(m), ChurchN(n), Succ, Zero),
            ),
          ),
        ).to.equal(m * n);
      }
    }
  });

  await t.step("predecessor", () => {
    const pred = bracketLambda(predLambda);

    for (let m = 0; m < N; m++) {
      const expected = Math.max(m - 1, 0); // pred(0) = 0

      // Pair-shifting definition
      expect(
        UnChurchNumber(
          symbolicEvaluator.reduce(
            apply(Cdr, apply(ChurchN(m), pairShiftSucc, pairZeroZero)),
          ),
        ),
      ).to.equal(expected);

      // Lambda derived from book definition
      expect(
        UnChurchNumber(
          symbolicEvaluator.reduce(apply(pred, ChurchN(m))),
        ),
      ).to.equal(expected);
    }
  });
});
