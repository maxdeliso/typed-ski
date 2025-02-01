import { cons } from '../../lib/cons.ts';
import { predLambda } from '../../lib/consts/lambdas.ts';
import { reduceSKI } from '../../lib/evaluator/skiEvaluator.ts';
import { mkVar, prettyPrintUntypedLambda } from '../../lib/lambda/lambda.ts';
import { UnChurchNumber, ChurchN } from '../../lib/ski/church.ts';
import { apply } from '../../lib/ski/expression.ts';
import { I } from '../../lib/ski/terminal.ts';
import { UpTo } from '../ski/church.test.ts';

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { convertLambda, Lambda } from '../../lib/conversion/converter.ts';

describe('Lambda conversion', () => {
  const mkAbs = (name: string, body: Lambda): Lambda => ({
    kind: 'lambda-abs',
    name,
    body,
  });

  const N = 5;

  const id = mkAbs('x', mkVar('x'));
  const konst = mkAbs('x', mkAbs('y', mkVar('x')));
  const flip  = mkAbs('x', mkAbs('y', cons(mkVar('y'), mkVar('x'))));

  it('should convert λx.x to I', () => {
    expect(convertLambda(id)).to.deep.equal(I);
  });

  it('should convert λx.λy.x to something that acts like K', () => {
    // The K combinator should return its first argument.
    UpTo(N).forEach(a => {
      UpTo(N).forEach(b => {
        const result = UnChurchNumber(
          reduceSKI(apply(convertLambda(konst), ChurchN(a), ChurchN(b)))
        );
        expect(result).to.equal(a);
      });
    });
  });

  it('should convert λx.λy.y x to something that acts like T', () => {
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
    UpTo(N).forEach(a => {
      UpTo(N).forEach(b => {
        const expected = a ** b; // exponentiation: a^b
        const result = UnChurchNumber(
          reduceSKI(apply(convertLambda(flip), ChurchN(a), ChurchN(b)))
        );
        expect(result).to.equal(expected);
      });
    });
  });

  it(`should convert ${prettyPrintUntypedLambda(predLambda)} to pred`, () => {
    UpTo(N).forEach(n => {
      const expected = Math.max(n - 1, 0); // pred(0) is defined as 0.
      const result = UnChurchNumber(
        reduceSKI(apply(convertLambda(predLambda), ChurchN(n)))
      );
      expect(result).to.equal(expected);
    });
  });
});
