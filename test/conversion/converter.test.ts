import { describe, it } from 'mocha';
import { expect } from 'chai';

import { cons } from '../../lib/cons.js';
import { predLambda } from '../../lib/consts/lambdas.js';
import { reduce } from '../../lib/evaluator/skiEvaluator.js';
import { UnChurchNumber, ChurchN } from '../../lib/ski/church.js';
import { apply } from '../../lib/ski/expression.js';
import { I } from '../../lib/ski/terminal.js';
import { convertLambda } from '../../lib/conversion/converter.js';
import { mkUntypedAbs, mkVar, prettyPrintUntypedLambda } from '../../lib/terms/lambda.js';

describe('Lambda conversion', () => {
  const N = 5;
  const id = mkUntypedAbs('x', mkVar('x'));
  const konst = mkUntypedAbs('x', mkUntypedAbs('y', mkVar('x')));
  const flip  = mkUntypedAbs('x', mkUntypedAbs('y', cons(mkVar('y'), mkVar('x'))));

  it('should convert λx.x to I', () => {
    expect(convertLambda(id)).to.deep.equal(I);
  });

  it('should convert λx.λy.x to something that acts like K', () => {
    // The K combinator should return its first argument.
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const result = UnChurchNumber(
          reduce(apply(convertLambda(konst), ChurchN(a), ChurchN(b)))
        );
        expect(result).to.equal(a);
      }
    }
  });

  it('should compute exponentiation with converted lambda', () => {
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
          reduce(apply(convertLambda(flip), ChurchN(a), ChurchN(b)))
        );
        expect(result).to.equal(expected);
      }
    }
  });

  it(`should convert ${prettyPrintUntypedLambda(predLambda)} to pred`, () => {
    for (let n = 0; n < N; n++) {
      const expected = Math.max(n - 1, 0); // pred(0) is defined as 0.
      const result = UnChurchNumber(
        reduce(apply(convertLambda(predLambda), ChurchN(n)))
      );
      expect(result).to.equal(expected);
    }
  });
});
