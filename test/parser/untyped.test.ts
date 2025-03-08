import { expect } from 'chai';

import { typelessApp, mkVar, mkUntypedAbs, prettyPrintUntypedLambda } from '../../lib/terms/lambda.js';
import { parseLambda } from '../../lib/parser/untyped.js';
import { predLambda } from '../../lib/consts/lambdas.js';

describe('Parser Tests', () => {
  describe('parseLambda', () => {
    describe('application parsing', () => {
      it('parses simple application', () => {
        const input = 'a b';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')));
      });

      it('parses application with parentheses', () => {
        const input = '(a b)';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')));
      });

      it('parses nested application correctly', () => {
        const input = 'a (b c)';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(
          typelessApp(mkVar('a'), typelessApp(mkVar('b'), mkVar('c')))
        );
      });
    });

    describe('complex expressions', () => {
      it('parses a var applied to a lambda', () => {
        const input = 'a (λb.b (a a))';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(
          typelessApp(
            mkVar('a'),
            mkUntypedAbs('b', typelessApp(mkVar('b'), typelessApp(mkVar('a'), mkVar('a'))))
          )
        );
      });

      it('parses pred (complex lambda expression)', () => {
        const input = 'λn. λf. λx. n (λg. λh. h (g f)) (λu. x) (λu. u)';

        const expectedLambda = mkUntypedAbs(
          'n',
          mkUntypedAbs(
            'f',
            mkUntypedAbs(
              'x',
              typelessApp(
                typelessApp(
                  typelessApp(
                    mkVar('n'),
                    mkUntypedAbs(
                      'g',
                      mkUntypedAbs(
                        'h',
                        typelessApp(mkVar('h'), typelessApp(mkVar('g'), mkVar('f')))
                      )
                    )
                  ),
                  mkUntypedAbs('u', mkVar('x'))
                ),
                mkUntypedAbs('u', mkVar('u'))
              )
            )
          )
        );

        const [, term] = parseLambda(input);
        expect(term).to.deep.equal(expectedLambda);

        const pretty = prettyPrintUntypedLambda(term);
        const [, reparsed] = parseLambda(pretty);
        expect(reparsed).to.deep.equal(expectedLambda);

        expect(reparsed).to.deep.equal(predLambda);
      });
    });
  });
});
