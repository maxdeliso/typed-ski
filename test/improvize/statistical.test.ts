import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  tokenizeFormatting,
  getVocabRep,
  KneserNeyLM,
  calculateCrossEntropy,
  computeTokenScores,
  getNormalizedScores,
  getTrainedLMSync,
  getStatisticalDiagnostics,
} from "../../lib/improvize/statistical.ts";
import { lintTripSource } from "../../lib/improvize/index.ts";
import { parseTripLang } from "../../lib/parser/tripLang.ts";

describe("statistical formatting tokenizer", () => {
  it("retains all spacing, newlines, and generalizes identifiers", () => {
    const source = "module M\n  poly id = x\n";
    const tokens = tokenizeFormatting(source);

    // Check that we got space and newline tokens
    const spaceTokens = tokens.filter((t) => t.kind === "space");
    const newlineTokens = tokens.filter((t) => t.kind === "newline");
    assert.ok(spaceTokens.length > 0);
    assert.ok(newlineTokens.length > 0);

    const reps = tokens.map(getVocabRep);
    assert.deepEqual(reps, [
      "module",
      "<space>",
      "<ident>",
      "<newline>",
      "<spaces:2>",
      "poly",
      "<space>",
      "<ident>",
      "<space>",
      "=",
      "<space>",
      "<ident>",
      "<newline>",
    ]);
  });

  it("shares nested comment and escaped string scanning with the formatter", () => {
    const source =
      'module M\r\n{- outer {- inner -} end -}\npoly s = "a\\"b" @\n';
    const tokens = tokenizeFormatting(source);
    const reps = tokens.map(getVocabRep);

    assert.ok(reps.includes("<blockComment>"));
    assert.ok(reps.includes("<string>"));
    assert.ok(reps.includes("<unknown>"));
    assert.equal(
      tokens.find((token) => token.kind === "blockComment")?.text,
      "{- outer {- inner -} end -}",
    );
    assert.equal(
      tokens.find((token) => token.kind === "string")?.text,
      '"a\\"b"',
    );
  });
});

describe("Kneser-Ney language model", () => {
  it("computes sequence probabilities and smoothing backoff correctly", () => {
    const sequences = [
      ["poly", "<space>", "<ident>", "<space>", "=", "<space>", "<ident>"],
      ["poly", "<space>", "<ident>", "<space>", "=", "<space>", "<number>"],
    ];

    const lm = new KneserNeyLM(8);
    lm.train(sequences);

    // Probability of space after poly should be very high
    const probSpace = lm.getProbability("<space>", ["poly"]);
    assert.ok(probSpace > 0.5);

    // Probability of an unseen token in a context should back off and not be zero
    const probUnseen = lm.getProbability("<newline>", ["poly"]);
    assert.ok(probUnseen > 0);
    assert.ok(probUnseen < 0.1);
  });

  it("evaluates file cross-entropy naturalness", () => {
    const lm = getTrainedLMSync();

    const cleanSource = "module M\n\nimport Prelude U8\n\npoly main = #u8(1)\n";
    const anomalousSource = "module M import Prelude U8 poly main = #u8(1)";

    const cleanTokens = tokenizeFormatting(cleanSource).map(getVocabRep);
    const anomalousTokens =
      tokenizeFormatting(anomalousSource).map(getVocabRep);

    const cleanEntropy = calculateCrossEntropy(lm, cleanTokens);
    const anomalousEntropy = calculateCrossEntropy(lm, anomalousTokens);

    // Well-formatted canonical layout should have lower entropy (surprise) than squeezed layout
    assert.ok(cleanEntropy < anomalousEntropy);
  });
});

describe("ML-assisted linter and safe fixes", () => {
  it("detects spacing errors and suggests safe, AST-equivalent fixes", () => {
    const lm = getTrainedLMSync();

    // Squeezing module and imports without expected double newlines before declarations
    const anomalousSource = `module M
import Prelude U8
import Prelude List
poly main =
  let x = #u8(1) in
  let y = #u8(2) in
  x
`;

    const diagnostics = getStatisticalDiagnostics(anomalousSource, lm);
    // Should flag formatting deviation
    assert.ok(diagnostics.length > 0);
    assert.equal(diagnostics[0]!.code, "trip-formatting-deviation");
    assert.ok(diagnostics[0]!.fix);

    // Safe fixer should correct it under lintTripSource
    const result = lintTripSource(anomalousSource, { fix: true, lm });
    assert.ok(result.changed);
    // AST must remain identical
    assert.deepEqual(
      parseTripLang(result.fixed),
      parseTripLang(anomalousSource),
    );
  });
});

describe("Kneser-Ney precomputed statistics", () => {
  // Reference implementations: the pre-optimization vocabulary scans the O(1)
  // getters replaced. Equivalence to these is the correctness contract.
  const bruteContextCount = (lm: KneserNeyLM, ctx: string[]): number => {
    const key = ctx.join("|");
    let sum = 0;
    for (const word of lm.vocab) {
      sum += lm.counts[ctx.length + 1]!.get(`${key}|${word}`) || 0;
    }
    return sum;
  };
  const bruteFollowerCount = (lm: KneserNeyLM, ctx: string[]): number => {
    const key = ctx.join("|");
    let n = 0;
    for (const word of lm.vocab) {
      if (lm.counts[ctx.length + 1]!.has(`${key}|${word}`)) n++;
    }
    return n;
  };
  const slidingContexts = (seq: string[], maxLen: number): string[][] => {
    const out: string[][] = [];
    for (let len = 1; len <= maxLen; len++) {
      for (let i = 0; i + len <= seq.length; i++) {
        out.push(seq.slice(i, i + len));
      }
    }
    return out;
  };

  it("getters equal the brute-force scan on a synthetic corpus", () => {
    const sequences = [
      // prettier-ignore
      ["module", "<space>", "<ident>", "<newline>", "data", "<space>",
       "<ident>", "<space>", "=", "<space>", "<ident>", "<space>", "|",
       "<space>", "<ident>"],
      ["poly", "<space>", "<ident>", "<space>", "=", "<space>", "<number>"],
    ];
    const lm = new KneserNeyLM(8);
    lm.train(sequences);

    let checked = 0;
    for (const seq of sequences) {
      for (const ctx of slidingContexts(seq, lm.maxOrder - 1)) {
        assert.equal(lm.getContextCount(ctx), bruteContextCount(lm, ctx));
        assert.equal(
          lm.getUniqueFollowersCount(ctx),
          bruteFollowerCount(lm, ctx),
        );
        checked++;
      }
    }
    assert.ok(checked > 0);
  });

  it("getters equal the brute-force scan on the trained corpus (incl. | tokens)", () => {
    const lm = getTrainedLMSync();
    const sample = `module M

data Maybe A =
  | Nothing
  | Just A

poly main =
  match x [Maybe A] {
    | Nothing => zero
    | Just a => a
  }
`;
    const seq = tokenizeFormatting(sample).map(getVocabRep);
    assert.ok(seq.includes("|"));

    let checked = 0;
    for (const ctx of slidingContexts(seq, lm.maxOrder - 1)) {
      assert.equal(lm.getContextCount(ctx), bruteContextCount(lm, ctx));
      assert.equal(
        lm.getUniqueFollowersCount(ctx),
        bruteFollowerCount(lm, ctx),
      );
      checked++;
    }
    assert.ok(checked > 0);
  });
});

describe("trained LM memoization", () => {
  it("caches the corpus-wide model and rebuilds only for leave-one-out", () => {
    const a = getTrainedLMSync();
    const b = getTrainedLMSync();
    assert.equal(a, b); // same instance: the corpus-wide model is cached

    const excluded = getTrainedLMSync("definitely-not-a-real-file.trip");
    assert.notEqual(excluded, a); // an exclusion bypasses the cache
  });
});
