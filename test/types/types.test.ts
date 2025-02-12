import { expect } from 'chai';
import { describe, it } from 'mocha';

import { cons } from '../../lib/cons.js';
import { mkUntypedAbs, mkVar, UntypedLambda } from '../../lib/terms/lambda.js';
import { parseType } from '../../lib/parser/type.js';
import { parseTypedLambda } from '../../lib/parser/typedLambda.js';
import { emptyContext, typedTermsLitEq } from '../../lib/types/typedLambda.js';
import {
  arrows,
  mkTypeVariable,
  typesLitEq,
  arrow,
  BaseType,
  prettyPrintTy
} from '../../lib/types/types.js';
import {
  inferType,
  substituteType,
  unify
} from '../../lib/types/inference.js';
import { normalize } from '../../lib/types/normalization.js';
import { insertAVL, searchAVL } from '../../lib/data/avl/avlNode.js';
import { compareStrings } from '../../lib/data/map/stringMap.js';

describe('Types', () => {
  describe('basic type operations', () => {
    describe('type construction and equivalence', () => {
      const t1 = arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('c'));
      const t2 = arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('d'));
      const t3 = arrows(mkTypeVariable('d'), mkTypeVariable('e'), mkTypeVariable('f'));

      it('recursively checks for literal type equivalence', () => {
        expect(typesLitEq(t1, t1)).to.equal(true);
        expect(typesLitEq(t1, t2)).to.equal(false);
        expect(typesLitEq(t1, t3)).to.equal(false);
        expect(typesLitEq(t2, t3)).to.equal(false);
        expect(typesLitEq(t1, t3)).to.equal(false);
      });

      it('associates type construction to the right', () => {
        expect(
          typesLitEq(
            arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('c')),
            arrow(mkTypeVariable('a'), arrow(mkTypeVariable('b'), mkTypeVariable('c')))
          )
        ).to.equal(true);
      });
    });

    describe('type normalization', () => {
      it('normalizes a type with repeated variables correctly', () => {
        const nonNormalized = arrow(mkTypeVariable('q'), arrow(mkTypeVariable('p'), mkTypeVariable('q')));
        const expected = arrow(mkTypeVariable('a'), arrow(mkTypeVariable('b'), mkTypeVariable('a')));
        const normalized = normalize(nonNormalized);
        expect(prettyPrintTy(normalized)).to.equal(prettyPrintTy(expected));
      });

      it('normalizes a chain of arrow types assigning fresh names in order of appearance', () => {
        const nonNormalized = arrows(mkTypeVariable('x'), mkTypeVariable('y'), mkTypeVariable('z'));
        const expected = arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('c'));
        const normalized = normalize(nonNormalized);
        expect(typesLitEq(normalized, expected)).to.equal(true);
      });

      it('leaves an already normalized type unchanged', () => {
        const normalizedInput = arrow(mkTypeVariable('a'), arrow(mkTypeVariable('b'), mkTypeVariable('a')));
        const normalizedOutput = normalize(normalizedInput);
        expect(typesLitEq(normalizedInput, normalizedOutput)).to.equal(true);
      });
    });
  });

  describe('type inference', () => {
    describe('successful inference', () => {
      it('infers the type of the I combinator', () => {
        const [termI, typeofI] = inferType(mkUntypedAbs('x', mkVar('x')));
        const [, parsedTypedI] = parseTypedLambda('λx:a.x');
        const [, parsedIType] = parseType('a→a');

        expect(typedTermsLitEq(termI, parsedTypedI)).to.equal(true);
        expect(prettyPrintTy(typeofI)).to.equal(prettyPrintTy(parsedIType));
      });

      it('infers the type of the K combinator', () => {
        const [termK, typeofK] = inferType(
          mkUntypedAbs('x',
            mkUntypedAbs('y',
              mkVar('x')))
        );
        const [, parsedTypedK] = parseTypedLambda('λx:a.λy:b.x');
        const [, parsedKType] = parseType('a→b→a');

        expect(typedTermsLitEq(termK, parsedTypedK)).to.equal(true);
        expect(prettyPrintTy(typeofK)).to.equal(prettyPrintTy(parsedKType));
      });

      it('infers the type of the S combinator', () => {
        const [termS, typeofS] = inferType(
          mkUntypedAbs('x',
            mkUntypedAbs('y',
              mkUntypedAbs('z',
                cons(
                  cons(mkVar('x'), mkVar('z')),
                  cons(mkVar('y'), mkVar('z')))
              )
            )
          ));

        const [, parsedTypedS] = parseTypedLambda('λx:a→b→c.λy:a→b.λz:a.xz(yz)');
        const [, parsedSType] = parseType('(a→b→c)→(a→b)→a→c');

        expect(prettyPrintTy(typeofS)).to.equal(prettyPrintTy(parsedSType));
        expect(typedTermsLitEq(termS, parsedTypedS)).to.equal(true);
      });

      it('succeeds at inferring the type of λx.λy.xy', () => {
        const [termT, typeofT] = inferType(
          mkUntypedAbs('x', mkUntypedAbs('y', cons(mkVar('x'), mkVar('y'))))
        );

        const [, parsedTypedT] = parseTypedLambda('λx:a→b.λy:a.xy');
        const [, parsedTType] = parseType('(a→b)→(a→b)');

        expect(prettyPrintTy(typeofT)).to.equal(prettyPrintTy(parsedTType));
        expect(typedTermsLitEq(termT, parsedTypedT)).to.equal(true);
      });
    });

    describe('inference failures', () => {
      it('fails to infer type of λx.xx', () => {
        expect(() => inferType(mkUntypedAbs('x', cons(mkVar('x'), mkVar('x')))))
          .to.throw(/occurs check failed/);
      });

      it('fails at inferring the type λx.λy.(xy)x', () => {
        expect(() => inferType(mkUntypedAbs('x',
          mkUntypedAbs('y',
            cons<UntypedLambda>(
              cons<UntypedLambda>(
                mkVar('x'),
                mkVar('y')),
              mkVar('x')))))
        ).to.throw(/occurs check failed/);
      });
    });
  });

  describe('unification', () => {
    describe('occurs check', () => {
      it('throws an error when a type variable occurs in its own substitution', () => {
        const a = mkTypeVariable('a');
        const b = mkTypeVariable('b');
        const funType = arrow(a, b);

        expect(() => substituteType(a, a, funType))
          .to.throw(/occurs check failed/);
      });

      it('throws an error when trying to unify a variable with a type that contains it (circular)', () => {
        const a = mkTypeVariable('a');
        const b = mkTypeVariable('b');
        const funType = arrow(a, b);
        let context = emptyContext();

        context = insertAVL(context, 'x', a, compareStrings);

        expect(() => {
          unify(a, funType, context);
        }).to.throw(/occurs check failed/);
      });
    });

    describe('arrow type unification', () => {
      it('unifies two arrow types by decomposing their structure', () => {
        const a = mkTypeVariable('a');
        const b = mkTypeVariable('b');
        const c = mkTypeVariable('c');

        const t1 = arrow(a, a);
        const t2 = arrow(b, c);

        let context = emptyContext();
        context = insertAVL(context, 'x', t1, compareStrings);
        context = unify(t1, t2, context);

        expect(searchAVL(context, 'x', compareStrings)).to.satisfy((ty: BaseType) => {
          if (ty.kind !== 'non-terminal') return false;
          return typesLitEq(ty.lft, ty.rgt);
        });
      });
    });
  });
});
