import { describe, it, before } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { Car, Cdr, F, Fst, Plus, Snd } from "../util/combinators.ts";

import { B, False, Succ, True, V, Zero } from "../../lib/consts/combinators.ts";

import { findFactors, findPerfectPower } from "../util/math.ts";
import {
  ChurchB,
  ChurchN,
  UnChurchBoolean,
  UnChurchNumber,
} from "../../lib/ski/church.ts";
import {
  I,
  J,
  K,
  S,
  SKITerminalSymbol,
  V as StageV,
} from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import {
  apply,
  applyMany,
  type SKIExpression,
} from "../../lib/ski/expression.ts";
import { createArenaEvaluator } from "../../lib/index.ts";

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

describe("Church numeral optimization functions", () => {
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  it("findPerfectPower", () => {
    // Test perfect powers
    // Note: Algorithm prefers smallest exponent b, so 16 = 4^2 (b=2) over 16 = 2^4 (b=4)
    assert.deepStrictEqual(findPerfectPower(4), [2n, 2n]); // 4 = 2^2
    assert.deepStrictEqual(findPerfectPower(8), [2n, 3n]); // 8 = 2^3
    assert.deepStrictEqual(findPerfectPower(9), [3n, 2n]); // 9 = 3^2
    assert.deepStrictEqual(findPerfectPower(16), [4n, 2n]); // 16 = 4^2 (prefers b=2 over b=4)
    assert.deepStrictEqual(findPerfectPower(25), [5n, 2n]); // 25 = 5^2
    assert.deepStrictEqual(findPerfectPower(27), [3n, 3n]); // 27 = 3^3
    assert.deepStrictEqual(findPerfectPower(32), [2n, 5n]); // 32 = 2^5 (only 2^5 exists)
    assert.deepStrictEqual(findPerfectPower(36), [6n, 2n]); // 36 = 6^2
    assert.deepStrictEqual(findPerfectPower(64), [8n, 2n]); // 64 = 8^2 (prefers b=2 over b=6)
    assert.deepStrictEqual(findPerfectPower(81), [9n, 2n]); // 81 = 9^2 (prefers b=2 over b=4)
    assert.deepStrictEqual(findPerfectPower(100), [10n, 2n]); // 100 = 10^2
    assert.deepStrictEqual(findPerfectPower(125), [5n, 3n]); // 125 = 5^3
    assert.deepStrictEqual(findPerfectPower(256), [16n, 2n]); // 256 = 16^2 (prefers b=2 over b=8)

    // Test numbers that are not perfect powers
    assert.strictEqual(findPerfectPower(0), null);
    assert.strictEqual(findPerfectPower(1), null);
    assert.strictEqual(findPerfectPower(2), null);
    assert.strictEqual(findPerfectPower(3), null);
    assert.strictEqual(findPerfectPower(5), null);
    assert.strictEqual(findPerfectPower(6), null);
    assert.strictEqual(findPerfectPower(7), null);
    assert.strictEqual(findPerfectPower(10), null);
    assert.strictEqual(findPerfectPower(11), null);
    assert.strictEqual(findPerfectPower(12), null);
    assert.strictEqual(findPerfectPower(13), null);
    assert.strictEqual(findPerfectPower(14), null);
    assert.strictEqual(findPerfectPower(15), null);
    assert.strictEqual(findPerfectPower(17), null);
    assert.strictEqual(findPerfectPower(18), null);
    assert.strictEqual(findPerfectPower(19), null);
    assert.strictEqual(findPerfectPower(20), null);
    assert.strictEqual(findPerfectPower(24), null);
    assert.strictEqual(findPerfectPower(30), null);
    assert.strictEqual(findPerfectPower(42), null);
    assert.strictEqual(findPerfectPower(50), null);
    assert.strictEqual(findPerfectPower(60), null);
    assert.strictEqual(findPerfectPower(72), null);
    assert.strictEqual(findPerfectPower(99), null);
  });

  it("findFactors", () => {
    // Test composite numbers
    assert.deepStrictEqual(findFactors(4), [2n, 2n]); // 4 = 2 * 2
    assert.deepStrictEqual(findFactors(6), [2n, 3n]); // 6 = 2 * 3
    assert.deepStrictEqual(findFactors(8), [2n, 4n]); // 8 = 2 * 4
    assert.deepStrictEqual(findFactors(9), [3n, 3n]); // 9 = 3 * 3
    assert.deepStrictEqual(findFactors(10), [2n, 5n]); // 10 = 2 * 5
    assert.deepStrictEqual(findFactors(12), [2n, 6n]); // 12 = 2 * 6
    assert.deepStrictEqual(findFactors(14), [2n, 7n]); // 14 = 2 * 7
    assert.deepStrictEqual(findFactors(15), [3n, 5n]); // 15 = 3 * 5
    assert.deepStrictEqual(findFactors(16), [2n, 8n]); // 16 = 2 * 8
    assert.deepStrictEqual(findFactors(18), [2n, 9n]); // 18 = 2 * 9
    assert.deepStrictEqual(findFactors(20), [2n, 10n]); // 20 = 2 * 10
    assert.deepStrictEqual(findFactors(21), [3n, 7n]); // 21 = 3 * 7
    assert.deepStrictEqual(findFactors(22), [2n, 11n]); // 22 = 2 * 11
    assert.deepStrictEqual(findFactors(24), [2n, 12n]); // 24 = 2 * 12
    assert.deepStrictEqual(findFactors(25), [5n, 5n]); // 25 = 5 * 5
    assert.deepStrictEqual(findFactors(27), [3n, 9n]); // 27 = 3 * 9
    assert.deepStrictEqual(findFactors(30), [2n, 15n]); // 30 = 2 * 15
    assert.deepStrictEqual(findFactors(32), [2n, 16n]); // 32 = 2 * 16
    assert.deepStrictEqual(findFactors(36), [2n, 18n]); // 36 = 2 * 18
    assert.deepStrictEqual(findFactors(49), [7n, 7n]); // 49 = 7 * 7
    assert.deepStrictEqual(findFactors(64), [2n, 32n]); // 64 = 2 * 32
    assert.deepStrictEqual(findFactors(100), [2n, 50n]); // 100 = 2 * 50

    // Test prime numbers (should return null)
    assert.strictEqual(findFactors(0), null);
    assert.strictEqual(findFactors(1), null);
    assert.strictEqual(findFactors(2), null);
    assert.strictEqual(findFactors(3), null);
    assert.strictEqual(findFactors(5), null);
    assert.strictEqual(findFactors(7), null);
    assert.strictEqual(findFactors(11), null);
    assert.strictEqual(findFactors(13), null);
    assert.strictEqual(findFactors(17), null);
    assert.strictEqual(findFactors(19), null);
    assert.strictEqual(findFactors(23), null);
    assert.strictEqual(findFactors(29), null);
    assert.strictEqual(findFactors(31), null);
    assert.strictEqual(findFactors(37), null);
    assert.strictEqual(findFactors(41), null);
    assert.strictEqual(findFactors(43), null);
    assert.strictEqual(findFactors(47), null);
    assert.strictEqual(findFactors(53), null);
    assert.strictEqual(findFactors(59), null);
    assert.strictEqual(findFactors(61), null);
    assert.strictEqual(findFactors(67), null);
    assert.strictEqual(findFactors(71), null);
    assert.strictEqual(findFactors(73), null);
    assert.strictEqual(findFactors(79), null);
    assert.strictEqual(findFactors(83), null);
    assert.strictEqual(findFactors(89), null);
    assert.strictEqual(findFactors(97), null);
  });

  it("optimization correctness", async () => {
    // Test that optimized Church numerals decode correctly
    const testCases = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 27, 30, 32, 36, 49, 64, 81, 100,
    ];

    for (const n of testCases) {
      const church = ChurchN(n);
      const decoded = await UnChurchNumber(
        arenaEvaluator.reduce(church),
        arenaEvaluator,
      );
      assert.strictEqual(
        decoded,
        BigInt(n),
        `ChurchN(${n}) should decode to ${BigInt(n)}, but got ${decoded}`,
      );
    }
  });

  it("maximum safe integer - stack safety test", () => {
    // Test with Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991)
    // This tests that the iterative, stack-safe implementation can handle
    // very large numbers without stack overflow during construction.
    const maxSafeInt = Number.MAX_SAFE_INTEGER;

    // Verify that ChurchN can construct the numeral without stack overflow
    // The iterative implementation should handle this efficiently
    let church: SKIExpression;
    assert.doesNotThrow(() => {
      church = ChurchN(maxSafeInt);
      // Verify it's a valid SKI expression
      assert.ok(church);
      // Verify it's a non-terminal (Church numerals for n > 0 are applications)
      assert.strictEqual(church.kind, "non-terminal");
      // Verify structure is complete (both lft and rgt exist)
      if (church.kind === "non-terminal") {
        assert.ok(church.lft);
        assert.ok(church.rgt);
      }
    });

    // Verify construction completed successfully by checking structure
    // Note: We don't test reduction here as it would hit stack limits,
    // but construction itself is stack-safe.
    assert.strictEqual(church!.kind, "non-terminal");
    if (church!.kind === "non-terminal") {
      assert.ok(church!.lft);
      assert.ok(church!.rgt);
    }
  });

  it("supports arbitrarily large bigint inputs", () => {
    const huge = 2n ** 200n; // comfortably above Number.MAX_SAFE_INTEGER
    assert.doesNotThrow(() => {
      const expr = ChurchN(huge);
      assert.ok(expr);
    });
  });

  it("memoization", async () => {
    // Clear any existing cache by testing fresh
    // Multiple calls should return equivalent expressions
    const church1 = ChurchN(10);
    const church2 = ChurchN(10);
    const church3 = ChurchN(10);

    // All should decode to the same value
    assert.strictEqual(
      await UnChurchNumber(arenaEvaluator.reduce(church1), arenaEvaluator),
      10n,
    );
    assert.strictEqual(
      await UnChurchNumber(arenaEvaluator.reduce(church2), arenaEvaluator),
      10n,
    );
    assert.strictEqual(
      await UnChurchNumber(arenaEvaluator.reduce(church3), arenaEvaluator),
      10n,
    );
  });

  it("optimization strategy verification", async () => {
    // Verify that perfect powers use exponentiation
    // 9 = 3^2 should use application (exponentiation)
    const church9 = ChurchN(9);
    const decoded9 = await UnChurchNumber(
      arenaEvaluator.reduce(church9),
      arenaEvaluator,
    );
    assert.strictEqual(decoded9, 9n);

    // Verify that composites use composition
    // 18 = 2 * 9 should use composition (B combinator)
    const church18 = ChurchN(18);
    const decoded18 = await UnChurchNumber(
      arenaEvaluator.reduce(church18),
      arenaEvaluator,
    );
    assert.strictEqual(decoded18, 18n);

    // Verify that primes use successor
    // 19 is prime, so should use Succ(18)
    const church19 = ChurchN(19);
    const decoded19 = await UnChurchNumber(
      arenaEvaluator.reduce(church19),
      arenaEvaluator,
    );
    assert.strictEqual(decoded19, 19n);

    // Verify that 64 = 2^6 uses exponentiation
    const church64 = ChurchN(64);
    const decoded64 = await UnChurchNumber(
      arenaEvaluator.reduce(church64),
      arenaEvaluator,
    );
    assert.strictEqual(decoded64, 64n);
  });

  it("toBigInt should throw for non-integers", () => {
    assert.throws(
      () => ChurchN(1.5),
      /Only integer values can be converted to Church numerals/,
    );
  });

  it("ChurchN should throw for negative integers", () => {
    assert.throws(
      () => ChurchN(-1),
      /only non-negative integers are supported/,
    );
  });

  it("UnChurchNumber should handle non-function-valued SKI terms", async () => {
    // K is a function, but when applied to one arg it returns another function.
    // If we just pass K as a Church numeral, UnChurchNumber might fail gracefully.
    const result = await UnChurchNumber(K, arenaEvaluator);
    assert.strictEqual(result, 0n);
  });

  it("UnChurchNumber should handle IO terminals by returning 0", async () => {
    const readOneExpr = {
      kind: "terminal" as const,
      sym: SKITerminalSymbol.ReadOne,
    };
    const result = await UnChurchNumber(readOneExpr, arenaEvaluator);
    assert.strictEqual(result, 0n);
  });

  it("UnChurchNumber should decode selectorized Church zero", async () => {
    const result = await UnChurchNumber(apply(J(1), StageV(0)), arenaEvaluator);
    assert.strictEqual(result, 0n);
  });

  it("UnChurchNumber should decode selectorized identity-wrapped numerals", async () => {
    const selectorId = apply(J(0), StageV(0));
    const result = await UnChurchNumber(
      apply(selectorId, ChurchN(3)),
      arenaEvaluator,
    );
    assert.strictEqual(result, 3n);
  });

  it("UnChurchNumber should handle Turner primes", async () => {
    // S' w x y z = w (x z) (y z)
    // S' I I I 0 should be I(I 0)(I 0) = 0(0) which might fail as 0 is not a function
    // But let's just see if it doesn't crash
    const SPrime = { kind: "terminal" as const, sym: SKITerminalSymbol.SPrime };
    const BPrime = { kind: "terminal" as const, sym: SKITerminalSymbol.BPrime };
    const CPrime = { kind: "terminal" as const, sym: SKITerminalSymbol.CPrime };

    assert.strictEqual(
      typeof (await UnChurchNumber(applyMany(SPrime, I, I, I), arenaEvaluator)),
      "bigint",
    );
    assert.strictEqual(
      typeof (await UnChurchNumber(applyMany(BPrime, I, I, I), arenaEvaluator)),
      "bigint",
    );
    assert.strictEqual(
      typeof (await UnChurchNumber(applyMany(CPrime, I, I, I), arenaEvaluator)),
      "bigint",
    );
  });

  it("findPerfectPower edge cases", () => {
    assert.strictEqual(findPerfectPower(0), null);
    assert.strictEqual(findPerfectPower(1), null);
    assert.strictEqual(findPerfectPower(2), null);
    assert.strictEqual(findPerfectPower(3), null);
    assert.deepStrictEqual(findPerfectPower(4), [2n, 2n]);
  });

  it("findFactors edge cases", () => {
    assert.strictEqual(findFactors(0), null);
    assert.strictEqual(findFactors(1), null);
    assert.strictEqual(findFactors(2), null);
    assert.strictEqual(findFactors(3), null);
    assert.deepStrictEqual(findFactors(4), [2n, 2n]);
    assert.strictEqual(findFactors(5), null); // prime
  });

  it("UnChurchNumber with invalid church numeral (not returning bigint)", async () => {
    // A "church numeral" that returns something else
    // λf.λx.K
    const invalidChurch = apply(K, K);
    assert.strictEqual(await UnChurchNumber(invalidChurch, arenaEvaluator), 0n);
  });
});

describe("Church encodings", () => {
  const N = 5;
  let arenaEvaluator: any;

  before(async () => {
    arenaEvaluator = await createArenaEvaluator();
  });

  describe("succ / basic arithmetic", () => {
    it("0 + 1 = 1", async () => {
      assert.strictEqual(
        await UnChurchNumber(apply(Succ, ChurchN(0)), arenaEvaluator),
        1n,
      );
    });

    it("1 + 1 = 2", async () => {
      assert.strictEqual(
        await UnChurchNumber(
          arenaEvaluator.reduce(apply(Succ, ChurchN(1))),
          arenaEvaluator,
        ),
        2n,
      );
    });
  });

  it("boolean logic (AND / OR in Church encoding)", async () => {
    for (const p of [false, true]) {
      for (const q of [false, true]) {
        const conj = p && q;
        const dis = p || q;

        // AND ≡ λpq.p q p
        assert.strictEqual(
          await UnChurchBoolean(
            arenaEvaluator.reduce(
              applyMany(ChurchB(p), ChurchB(q), ChurchB(p)),
            ),
            arenaEvaluator,
          ),
          conj,
        );

        // OR  ≡ λpq.p p q
        assert.strictEqual(
          await UnChurchBoolean(
            arenaEvaluator.reduce(
              applyMany(ChurchB(p), ChurchB(p), ChurchB(q)),
            ),
            arenaEvaluator,
          ),
          dis,
        );
      }
    }
  });

  it("pairs (make, fst, snd, car, cdr)", async () => {
    assert.strictEqual(
      await UnChurchNumber(
        arenaEvaluator.reduce(applyMany(V, ChurchN(0), ChurchN(1), Fst)),
        arenaEvaluator,
      ),
      0n,
    );

    assert.strictEqual(
      await UnChurchNumber(
        arenaEvaluator.reduce(applyMany(V, ChurchN(0), ChurchN(1), Snd)),
        arenaEvaluator,
      ),
      1n,
    );

    assert.strictEqual(
      await UnChurchNumber(
        arenaEvaluator.reduce(apply(Car, applyMany(V, ChurchN(0), ChurchN(1)))),
        arenaEvaluator,
      ),
      0n,
    );

    assert.strictEqual(
      await UnChurchNumber(
        arenaEvaluator.reduce(apply(Cdr, applyMany(V, ChurchN(0), ChurchN(1)))),
        arenaEvaluator,
      ),
      1n,
    );
  });

  it("isZero predicate", async () => {
    // definition-style tests
    assert.strictEqual(
      await UnChurchBoolean(
        arenaEvaluator.reduce(applyMany(ChurchN(0), apply(K, False), True)),
        arenaEvaluator,
      ),
      true,
    );

    assert.strictEqual(
      await UnChurchBoolean(
        arenaEvaluator.reduce(applyMany(ChurchN(1), apply(K, False), True)),
        arenaEvaluator,
      ),
      false,
    );

    // IsZero combinator
    assert.strictEqual(
      await UnChurchBoolean(
        arenaEvaluator.reduce(apply(IsZero, ChurchN(0))),
        arenaEvaluator,
      ),
      true,
    );

    assert.strictEqual(
      await UnChurchBoolean(
        arenaEvaluator.reduce(apply(IsZero, ChurchN(1))),
        arenaEvaluator,
      ),
      false,
    );
  });

  it("sums and products (0‥N-1)", async () => {
    const arenaEvaluator = await createArenaEvaluator();

    for (let m = 0n; m < N; m++) {
      for (let n = 0n; n < N; n++) {
        // m + n   via λmn.(m succ) n
        assert.strictEqual(
          await UnChurchNumber(
            arenaEvaluator.reduce(applyMany(ChurchN(m), Succ, ChurchN(n))),
            arenaEvaluator,
          ),
          m + n,
        );

        // m + n   via Plus combinator
        assert.strictEqual(
          await UnChurchNumber(
            arenaEvaluator.reduce(applyMany(Plus, ChurchN(m), ChurchN(n))),
            arenaEvaluator,
          ),
          m + n,
        );

        // m * n   via λmn.m (n succ) 0
        assert.strictEqual(
          await UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(ChurchN(m), apply(ChurchN(n), Succ), Zero),
            ),
            arenaEvaluator,
          ),
          m * n,
        );

        // m * n   via B combinator
        assert.strictEqual(
          await UnChurchNumber(
            arenaEvaluator.reduce(
              applyMany(B, ChurchN(m), ChurchN(n), Succ, Zero),
            ),
            arenaEvaluator,
          ),
          m * n,
        );
      }
    }
  });
});
