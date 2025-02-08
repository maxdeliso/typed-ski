import { typelessApp, mkVar, mkUntypedAbs, prettyPrintUntypedLambda } from '../../lib/lambda/lambda.ts';
import { parseLambda } from '../../lib/parser/untyped.ts';

import { expect } from 'chai';

describe('Parser Tests', () => {
  describe('parseLambda', () => {
    describe('application parsing', () => {
      it('parses simple application', () => {
        const input = 'ab';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')));
      });

      it('parses application with parens', () => {
        const input = '(ab)';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(typelessApp(mkVar('a'), mkVar('b')));
      });

      it('parses an unbalanced triplet of vars', () => {
        const input = 'a(bc)';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);
        expect(term).to.deep.equal(
          typelessApp(mkVar('a'), typelessApp(mkVar('b'), mkVar('c')))
        );
      });
    });

    describe('complex expressions', () => {
      it('parses a var applied to a lambda', () => {
        const input = 'a(λb.b(aa))';
        const [lit, term] = parseLambda(input);
        expect(lit).to.equal(input);

        expect(term).to.deep.equal(
          typelessApp(mkVar('a'),
            typelessApp(mkUntypedAbs('b',
              typelessApp(mkVar('b'), typelessApp(mkVar('a'), mkVar('a'))))
            )
          ));
      });

      it('parses pred (complex lambda expression)', () => {
        const input = 'λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)';

        // λn.λf.λx.n(λg.λh.h(gf))(λu.x)(λu.u)
        const predLambda =
          // λn.λf.λx.
          mkUntypedAbs('n', mkUntypedAbs('f', mkUntypedAbs('x',
            // n(λg.λh.h(gf))(λu.x)(λu.u)
            typelessApp(
              mkVar('n'), // n
              mkUntypedAbs('g', mkUntypedAbs('h', // λg.λh.
                typelessApp(
                  mkVar('h'), typelessApp(mkVar('g'), mkVar('f'))))
              ), // h(gf)
              mkUntypedAbs('u', mkVar('x')), // (λu.x)
              mkUntypedAbs('u', mkVar('u')) // (λu.u)
            )
          )));

        const [, term] = parseLambda(input);
        expect(term).to.deep.equal(predLambda);

        // Test that pretty printing and reparsing gives same AST
        const [, reparsed] = parseLambda(prettyPrintUntypedLambda(term));
        expect(reparsed).to.deep.equal(predLambda);
      });
    });
  });
});
