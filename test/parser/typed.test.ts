import { cons } from '../../lib/cons.ts';
import { mkVar } from '../../lib/lambda/lambda.ts';
import { ParseError } from '../../lib/parser/parseError.ts';
import { parseTypedLambda } from '../../lib/parser/typed.ts';
import { parseType } from '../../lib/parser/type.ts';
import { typedTermsLitEq, mkTypedAbs } from '../../lib/typed/typedLambda.ts';
import { typesLitEq, arrow, mkTypeVar, arrows } from '../../lib/typed/types.ts';

import { expect } from 'chai';

describe('Parser Tests', () => {
  describe('parseType', () => {
    it('parses a simple type that is just a variable', () => {
      const parseInput = 'a';
      const [typeLit, type] = parseType(parseInput);
      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, mkTypeVar('a'))).to.equal(true);
    });

    it('parses the type a→b', () => {
      const parseInput = 'a→b';
      const [typeLit, type] = parseType(parseInput);

      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, arrow(mkTypeVar('a'), mkTypeVar('b'))));
    });

    it('parses the type a→b→c', () => {
      const parseInput = 'a→b→c';
      const [typeLit, type] = parseType(parseInput);

      const expectedTy = arrow(
        mkTypeVar('a'),
        arrow(mkTypeVar('b'), mkTypeVar('c'))
      );

      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, expectedTy)).to.equal(true);
    });

    it('parses the type (a→b)→a→b', () => {
      const parseInput = '(a→b)→a→b';
      const [typeLit, type] = parseType(parseInput);

      const expectedTy =
        arrow(
          arrow(mkTypeVar('a'), mkTypeVar('b')),
          arrow(mkTypeVar('a'), mkTypeVar('b')));

      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, expectedTy)).to.equal(true);
    });

    it('parses the type a→b→a→b', () => {
      const parseInput = 'a→b→a→b';
      const [typeLit, type] = parseType(parseInput);

      const expectedTy =
        arrows(
          mkTypeVar('a'),
          mkTypeVar('b'),
          mkTypeVar('a'),
          mkTypeVar('b'));

      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, expectedTy)).to.equal(true);
    });

    it('parses a complex arrow type with nested parentheses', () => {
      const parseInput = '((a→b)→c)→d';
      const [typeLit, type] = parseType(parseInput);

      const expectedType = arrow(
        arrow(arrow(mkTypeVar('a'), mkTypeVar('b')), mkTypeVar('c')),
        mkTypeVar('d')
      );
      expect(typeLit).to.equal(parseInput);
      expect(typesLitEq(type, expectedType)).to.equal(true);
    });
  });

  describe('parseTypedLambda', () => {
    describe('successful parsing', () => {
      it('parses a single term application', () => {
        const parseInput = 'xy';
        const [parsedLit, term] = parseTypedLambda(parseInput);

        const parsed = cons(mkVar('x'), mkVar('y'));

        expect(parsedLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, parsed)).to.equal(true);
      });

      it('parses juxstaposed terms', () => {
        const parseInput = 'xz(yz)';
        const [parsedLit, term] = parseTypedLambda(parseInput);

        const parsed = cons(cons(mkVar('x'), mkVar('z')), cons(mkVar('y'), mkVar('z')));

        expect(parsedLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, parsed)).to.equal(true);
      });

      it('parses λx:a.xx', () => {
        const parseInput = 'λx:a.xx';
        const [inputLit, term] = parseTypedLambda(parseInput);

        const parsed =
          mkTypedAbs('x',
            mkTypeVar('a'),
            cons(mkVar('x'), mkVar('x')));

        expect(inputLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, parsed)).to.equal(true);
      });

      it('parses a typed lambda expression corresponding to K', () => {
        const parseInput = 'λx:a.λy:b.x';
        const [inputLit, term] = parseTypedLambda(parseInput);

        const parsed =
          mkTypedAbs('x',
            mkTypeVar('a'),
            mkTypedAbs('y',
              mkTypeVar('b'),
              mkVar('x')));

        expect(inputLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, parsed)).to.equal(true);
      });

      it('parses a typed lambda expression corresponding to S', () => {
        const parseInput = 'λx:a→b→c.λy:a→b.λz:a.xz(yz)';
        const [parsedLit, term] = parseTypedLambda(parseInput);

        const parsed =
          mkTypedAbs('x',
            arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
            mkTypedAbs('y',
              arrow(mkTypeVar('a'), mkTypeVar('b')),
              mkTypedAbs('z', mkTypeVar('a'),
                cons(cons(mkVar('x'), mkVar('z')), cons(mkVar('y'), mkVar('z'))))));

        expect(parsedLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, parsed)).to.equal(true);
      });

      it('parses a typed lambda with parentheses around the whole abstraction', () => {
        const parseInput = '(λx:a.x)';
        const [parsedLit, term] = parseTypedLambda(parseInput);

        const expected = mkTypedAbs('x', mkTypeVar('a'), mkVar('x'));
        expect(parsedLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });

      it('parses a typed lambda expression with nested parentheses in the type annotation', () => {
        const parseInput = 'λx:(a→b)→c.x';
        const [parsedLit, term] = parseTypedLambda(parseInput);

        const expected = mkTypedAbs(
          'x',
          arrow(arrow(mkTypeVar('a'), mkTypeVar('b')), mkTypeVar('c')),
          mkVar('x')
        );
        expect(parsedLit).to.equal(parseInput);
        expect(typedTermsLitEq(term, expected)).to.equal(true);
      });
    });

    describe('error cases', () => {
      it('fails to parse missing variable', () => {
        expect(() => parseTypedLambda('λ:a→b.x'))
          .to.throw(ParseError, /failed to parse variable/);
      });

      it('fails to parse an incomplete type', () => {
        expect(() => parseTypedLambda('λx:a→.x'))
          .to.throw(ParseError, /failed to parse variable/);
      });

      it('fails to parse missing term', () => {
        expect(() => parseTypedLambda('λx:a→b.'))
          .to.throw(ParseError, /expected a term/);
      });

      it('fails to parse when there is an unmatched left parenthesis', () => {
        expect(() => parseTypedLambda('(λx:a.x'))
          .to.throw(ParseError, /expected \) but found null/);
      });

      it('fails to parse when there is an extra right parenthesis', () => {
        const badInput = 'λx:a.x))';
        expect(() => parseTypedLambda(badInput))
          .to.throw(ParseError);
      });

      it('fails to parse an incomplete lambda abstraction', () => {
        const badInput = 'λx:a→b.';
        expect(() => parseTypedLambda(badInput))
          .to.throw(ParseError, /expected a term/);
      });

      it('fails to parse an incomplete type annotation', () => {
        const badInput = 'λx:a→.x';
        expect(() => parseTypedLambda(badInput))
          .to.throw(ParseError);
      });
    });
  });
});
