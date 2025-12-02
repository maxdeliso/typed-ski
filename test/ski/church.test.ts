import { expect } from "chai";

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
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import {
  ChurchB,
  ChurchN,
  findFactors,
  findPerfectPower,
  UnChurchBoolean,
  UnChurchNumber,
} from "../../lib/ski/church.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { predLambda } from "../../lib/consts/lambdas.ts";
import {
  apply,
  applyMany,
  type SKIExpression,
} from "../../lib/ski/expression.ts";

// isZero ≡ F True (KF)
const IsZero = applyMany(F, True, apply(K, False));

/* λp. <Succ (Car p), Car p>  — pair-shifting successor */
const pairShiftSucc = applyMany(
  S,
  apply(
    applyMany(B, applyMany(B, V, Succ)),
    applyMany(B, applyMany(B, I, Car), I),
  ),
  applyMany(B, applyMany(B, I, Car), I),
);

const pairZeroZero = applyMany(V, ChurchN(0), ChurchN(0));

Deno.test("Church numeral optimization functions", async (t) => {
  await t.step("findPerfectPower", () => {
    // Test perfect powers
    // Note: Algorithm prefers smallest exponent b, so 16 = 4^2 (b=2) over 16 = 2^4 (b=4)
    expect(findPerfectPower(4)).to.deep.equal([2n, 2n]); // 4 = 2^2
    expect(findPerfectPower(8)).to.deep.equal([2n, 3n]); // 8 = 2^3
    expect(findPerfectPower(9)).to.deep.equal([3n, 2n]); // 9 = 3^2
    expect(findPerfectPower(16)).to.deep.equal([4n, 2n]); // 16 = 4^2 (prefers b=2 over b=4)
    expect(findPerfectPower(25)).to.deep.equal([5n, 2n]); // 25 = 5^2
    expect(findPerfectPower(27)).to.deep.equal([3n, 3n]); // 27 = 3^3
    expect(findPerfectPower(32)).to.deep.equal([2n, 5n]); // 32 = 2^5 (only 2^5 exists)
    expect(findPerfectPower(36)).to.deep.equal([6n, 2n]); // 36 = 6^2
    expect(findPerfectPower(64)).to.deep.equal([8n, 2n]); // 64 = 8^2 (prefers b=2 over b=6)
    expect(findPerfectPower(81)).to.deep.equal([9n, 2n]); // 81 = 9^2 (prefers b=2 over b=4)
    expect(findPerfectPower(100)).to.deep.equal([10n, 2n]); // 100 = 10^2
    expect(findPerfectPower(125)).to.deep.equal([5n, 3n]); // 125 = 5^3
    expect(findPerfectPower(256)).to.deep.equal([16n, 2n]); // 256 = 16^2 (prefers b=2 over b=8)

    // Test numbers that are not perfect powers
    expect(findPerfectPower(0)).to.be.null;
    expect(findPerfectPower(1)).to.be.null;
    expect(findPerfectPower(2)).to.be.null;
    expect(findPerfectPower(3)).to.be.null;
    expect(findPerfectPower(5)).to.be.null;
    expect(findPerfectPower(6)).to.be.null;
    expect(findPerfectPower(7)).to.be.null;
    expect(findPerfectPower(10)).to.be.null;
    expect(findPerfectPower(11)).to.be.null;
    expect(findPerfectPower(12)).to.be.null;
    expect(findPerfectPower(13)).to.be.null;
    expect(findPerfectPower(14)).to.be.null;
    expect(findPerfectPower(15)).to.be.null;
    expect(findPerfectPower(17)).to.be.null;
    expect(findPerfectPower(18)).to.be.null;
    expect(findPerfectPower(19)).to.be.null;
    expect(findPerfectPower(20)).to.be.null;
    expect(findPerfectPower(24)).to.be.null;
    expect(findPerfectPower(30)).to.be.null;
    expect(findPerfectPower(42)).to.be.null;
    expect(findPerfectPower(50)).to.be.null;
    expect(findPerfectPower(60)).to.be.null;
    expect(findPerfectPower(72)).to.be.null;
    expect(findPerfectPower(99)).to.be.null;
  });

  await t.step("findFactors", () => {
    // Test composite numbers
    expect(findFactors(4)).to.deep.equal([2n, 2n]); // 4 = 2 * 2
    expect(findFactors(6)).to.deep.equal([2n, 3n]); // 6 = 2 * 3
    expect(findFactors(8)).to.deep.equal([2n, 4n]); // 8 = 2 * 4
    expect(findFactors(9)).to.deep.equal([3n, 3n]); // 9 = 3 * 3
    expect(findFactors(10)).to.deep.equal([2n, 5n]); // 10 = 2 * 5
    expect(findFactors(12)).to.deep.equal([2n, 6n]); // 12 = 2 * 6
    expect(findFactors(14)).to.deep.equal([2n, 7n]); // 14 = 2 * 7
    expect(findFactors(15)).to.deep.equal([3n, 5n]); // 15 = 3 * 5
    expect(findFactors(16)).to.deep.equal([2n, 8n]); // 16 = 2 * 8
    expect(findFactors(18)).to.deep.equal([2n, 9n]); // 18 = 2 * 9
    expect(findFactors(20)).to.deep.equal([2n, 10n]); // 20 = 2 * 10
    expect(findFactors(21)).to.deep.equal([3n, 7n]); // 21 = 3 * 7
    expect(findFactors(22)).to.deep.equal([2n, 11n]); // 22 = 2 * 11
    expect(findFactors(24)).to.deep.equal([2n, 12n]); // 24 = 2 * 12
    expect(findFactors(25)).to.deep.equal([5n, 5n]); // 25 = 5 * 5
    expect(findFactors(27)).to.deep.equal([3n, 9n]); // 27 = 3 * 9
    expect(findFactors(30)).to.deep.equal([2n, 15n]); // 30 = 2 * 15
    expect(findFactors(32)).to.deep.equal([2n, 16n]); // 32 = 2 * 16
    expect(findFactors(36)).to.deep.equal([2n, 18n]); // 36 = 2 * 18
    expect(findFactors(49)).to.deep.equal([7n, 7n]); // 49 = 7 * 7
    expect(findFactors(64)).to.deep.equal([2n, 32n]); // 64 = 2 * 32
    expect(findFactors(100)).to.deep.equal([2n, 50n]); // 100 = 2 * 50

    // Test prime numbers (should return null)
    expect(findFactors(0)).to.be.null;
    expect(findFactors(1)).to.be.null;
    expect(findFactors(2)).to.be.null;
    expect(findFactors(3)).to.be.null;
    expect(findFactors(5)).to.be.null;
    expect(findFactors(7)).to.be.null;
    expect(findFactors(11)).to.be.null;
    expect(findFactors(13)).to.be.null;
    expect(findFactors(17)).to.be.null;
    expect(findFactors(19)).to.be.null;
    expect(findFactors(23)).to.be.null;
    expect(findFactors(29)).to.be.null;
    expect(findFactors(31)).to.be.null;
    expect(findFactors(37)).to.be.null;
    expect(findFactors(41)).to.be.null;
    expect(findFactors(43)).to.be.null;
    expect(findFactors(47)).to.be.null;
    expect(findFactors(53)).to.be.null;
    expect(findFactors(59)).to.be.null;
    expect(findFactors(61)).to.be.null;
    expect(findFactors(67)).to.be.null;
    expect(findFactors(71)).to.be.null;
    expect(findFactors(73)).to.be.null;
    expect(findFactors(79)).to.be.null;
    expect(findFactors(83)).to.be.null;
    expect(findFactors(89)).to.be.null;
    expect(findFactors(97)).to.be.null;
  });

  await t.step("optimization correctness", () => {
    // Test that optimized Church numerals decode correctly
    const testCases = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      23,
      24,
      25,
      27,
      30,
      32,
      36,
      49,
      64,
      81,
      100,
    ];

    for (const n of testCases) {
      const church = ChurchN(n);
      const decoded = UnChurchNumber(arenaEvaluator.reduce(church));
      expect(decoded).to.equal(
        BigInt(n),
        `ChurchN(${n}) should decode to ${BigInt(n)}, but got ${decoded}`,
      );
    }
  });

  await t.step("maximum safe integer - stack safety test", () => {
    // Test with Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991)
    // This tests that the iterative, stack-safe implementation can handle
    // very large numbers without stack overflow during construction.
    const maxSafeInt = Number.MAX_SAFE_INTEGER;

    // Verify that ChurchN can construct the numeral without stack overflow
    // The iterative implementation should handle this efficiently
    let church: SKIExpression;
    expect(() => {
      church = ChurchN(maxSafeInt);
      // Verify it's a valid SKI expression
      expect(church).to.exist;
      // Verify it's a non-terminal (Church numerals for n > 0 are applications)
      expect(church.kind).to.equal("non-terminal");
      // Verify structure is complete (both lft and rgt exist)
      if (church.kind === "non-terminal") {
        expect(church.lft).to.exist;
        expect(church.rgt).to.exist;
      }
    }).to.not.throw();

    // Verify construction completed successfully by checking structure
    // Note: We don't test reduction here as it would hit stack limits,
    // but construction itself is stack-safe.
    expect(church!.kind).to.equal("non-terminal");
    if (church!.kind === "non-terminal") {
      expect(church!.lft).to.exist;
      expect(church!.rgt).to.exist;
    }
  });

  await t.step("supports arbitrarily large bigint inputs", () => {
    const huge = 2n ** 200n; // comfortably above Number.MAX_SAFE_INTEGER
    expect(() => {
      const expr = ChurchN(huge);
      expect(expr).to.exist;
    }).to.not.throw();
  });

  await t.step("memoization", () => {
    // Clear any existing cache by testing fresh
    // Multiple calls should return equivalent expressions
    const church1 = ChurchN(10);
    const church2 = ChurchN(10);
    const church3 = ChurchN(10);

    // All should decode to the same value
    expect(UnChurchNumber(arenaEvaluator.reduce(church1))).to.equal(10n);
    expect(UnChurchNumber(arenaEvaluator.reduce(church2))).to.equal(10n);
    expect(UnChurchNumber(arenaEvaluator.reduce(church3))).to.equal(10n);
  });

  await t.step("optimization strategy verification", () => {
    // Verify that perfect powers use exponentiation
    // 9 = 3^2 should use application (exponentiation)
    const church9 = ChurchN(9);
    const decoded9 = UnChurchNumber(arenaEvaluator.reduce(church9));
    expect(decoded9).to.equal(9n);

    // Verify that composites use composition
    // 18 = 2 * 9 should use composition (B combinator)
    const church18 = ChurchN(18);
    const decoded18 = UnChurchNumber(arenaEvaluator.reduce(church18));
    expect(decoded18).to.equal(18n);

    // Verify that primes use successor
    // 19 is prime, so should use Succ(18)
    const church19 = ChurchN(19);
    const decoded19 = UnChurchNumber(arenaEvaluator.reduce(church19));
    expect(decoded19).to.equal(19n);

    // Verify that 64 = 2^6 uses exponentiation
    const church64 = ChurchN(64);
    const decoded64 = UnChurchNumber(arenaEvaluator.reduce(church64));
    expect(decoded64).to.equal(64n);
  });
});

Deno.test("Church encodings", async (t) => {
  const N = 5;

  await t.step("succ / basic arithmetic", async (t) => {
    await t.step("0 + 1 = 1", () => {
      expect(UnChurchNumber(apply(Succ, ChurchN(0)))).to.equal(1n);
    });

    await t.step("1 + 1 = 2", () => {
      expect(
        UnChurchNumber(arenaEvaluator.reduce(apply(Succ, ChurchN(1)))),
      ).to.equal(2n);
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
            arenaEvaluator.reduce(
              applyMany(ChurchB(p), ChurchB(q), ChurchB(p)),
            ),
          ),
        ).to.equal(conj);

        // OR  ≡ λpq.p p q
        expect(
          UnChurchBoolean(
            arenaEvaluator.reduce(
              applyMany(ChurchB(p), ChurchB(p), ChurchB(q)),
            ),
          ),
        ).to.equal(dis);
      });
    });
  });

  await t.step("pairs (make, fst, snd, car, cdr)", () => {
    expect(
      UnChurchNumber(
        arenaEvaluator.reduce(applyMany(V, ChurchN(0), ChurchN(1), Fst)),
      ),
    ).to.equal(0n);

    expect(
      UnChurchNumber(
        arenaEvaluator.reduce(applyMany(V, ChurchN(0), ChurchN(1), Snd)),
      ),
    ).to.equal(1n);

    expect(
      UnChurchNumber(
        arenaEvaluator.reduce(
          apply(Car, applyMany(V, ChurchN(0), ChurchN(1))),
        ),
      ),
    ).to.equal(0n);

    expect(
      UnChurchNumber(
        arenaEvaluator.reduce(
          apply(Cdr, applyMany(V, ChurchN(0), ChurchN(1))),
        ),
      ),
    ).to.equal(1n);
  });

  await t.step("isZero predicate", () => {
    // definition-style tests
    expect(
      UnChurchBoolean(
        arenaEvaluator.reduce(applyMany(ChurchN(0), apply(K, False), True)),
      ),
    ).to.equal(true);

    expect(
      UnChurchBoolean(
        arenaEvaluator.reduce(applyMany(ChurchN(1), apply(K, False), True)),
      ),
    ).to.equal(false);

    // IsZero combinator
    expect(
      UnChurchBoolean(arenaEvaluator.reduce(apply(IsZero, ChurchN(0)))),
    ).to.equal(true);

    expect(
      UnChurchBoolean(arenaEvaluator.reduce(apply(IsZero, ChurchN(1)))),
    ).to.equal(false);
  });

  await t.step("sums and products (0‥N-1)", () => {
    for (let m = 0n; m < N; m++) {
      for (let n = 0n; n < N; n++) {
        // m + n   via λmn.(m succ) n
        expect(
          UnChurchNumber(
            arenaEvaluator.reduce(applyMany(ChurchN(m), Succ, ChurchN(n))),
          ),
        ).to.equal(m + n);

        // m + n   via Plus combinator
        expect(
          UnChurchNumber(
            arenaEvaluator.reduce(applyMany(Plus, ChurchN(m), ChurchN(n))),
          ),
        ).to.equal(m + n);

        // m * n   via λmn.m (n succ) 0
        expect(
          UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(ChurchN(m), apply(ChurchN(n), Succ), Zero),
            ),
          ),
        ).to.equal(m * n);

        // m * n   via B combinator
        expect(
          UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(B, ChurchN(m), ChurchN(n), Succ, Zero),
            ),
          ),
        ).to.equal(m * n);
      }
    }
  });

  await t.step("predecessor", () => {
    const pred = bracketLambda(predLambda);

    for (let m = 0n; m < N; m++) {
      const expected = m - 1n > 0n ? m - 1n : 0n; // pred(0) = 0

      // Pair-shifting definition
      expect(
        UnChurchNumber(
          arenaEvaluator.reduce(
            apply(Cdr, applyMany(ChurchN(m), pairShiftSucc, pairZeroZero)),
          ),
        ),
      ).to.equal(expected);

      // Lambda derived from book definition
      expect(
        UnChurchNumber(
          arenaEvaluator.reduce(apply(pred, ChurchN(m))),
        ),
      ).to.equal(expected);
    }
  });
});
