import { cons } from '../../lib/cons.ts';
import { mkUntypedAbs, mkVar, UntypedLambda } from '../../lib/lambda/lambda.ts';
import { parseType } from '../../lib/parser/type.ts';
import { parseTypedLambda } from '../../lib/parser/typed.ts';
import { typedTermsLitEq } from '../../lib/typed/typedLambda.ts';
import {
  arrows,
  mkTypeVar,
  typesLitEq,
  arrow,
  inferType,
  substituteType,
  unify,
  Type,
  normalize
} from '../../lib/typed/types.ts';
import { expect } from 'chai';
import { describe, it } from 'mocha';

describe('type construction and equivalence', () => {
  const t1 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c'));
  const t2 = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('d'));
  const t3 = arrows(mkTypeVar('d'), mkTypeVar('e'), mkTypeVar('f'));

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
        arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c')),
        arrow(mkTypeVar('a'), arrow(mkTypeVar('b'), mkTypeVar('c')))
      )
    ).to.equal(true);
  });
});

describe('type inference', () => {
  it('infers the type of the I combinator', () => {
    const [termI, typeofI] = inferType(mkUntypedAbs('x', mkVar('x')));
    const [, parsedTypedI] = parseTypedLambda('λx:a.x');
    const [, parsedIType] = parseType('a→a');

    expect(typedTermsLitEq(termI, parsedTypedI)).to.equal(true);
    expect(typesLitEq(typeofI, parsedIType)).to.equal(true);
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
    expect(typesLitEq(typeofK, parsedKType)).to.equal(true);
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

    expect(typedTermsLitEq(termS, parsedTypedS)).to.equal(true);
    expect(typesLitEq(typeofS, parsedSType)).to.equal(true);
  });

  it('succeeds at inferring the type of λx.λy.xy', () => {
    const [termT, typeofT] = inferType(
      mkUntypedAbs('x', mkUntypedAbs('y', cons(mkVar('x'), mkVar('y'))))
    );

    const [, parsedTypedT] = parseTypedLambda('λx:a→b.λy:a.xy');
    const [, parsedTType] = parseType('(a→b)→(a→b)');

    expect(typedTermsLitEq(termT, parsedTypedT)).to.equal(true);
    expect(typesLitEq(typeofT, parsedTType)).to.equal(true);
  });

  it('fails to infer type of λx.xx', () => {
    expect(() => inferType(mkUntypedAbs('x', cons(mkVar('x'), mkVar('x')))))
      .to.throw(/Occurs check failed/);
  });

  it('fails at inferring the type λx.λy.(xy)x', () => {
    expect(() => inferType(mkUntypedAbs('x',
      mkUntypedAbs('y',
        cons<UntypedLambda>(
          cons<UntypedLambda>(
            mkVar('x'),
            mkVar('y')),
          mkVar('x')))))
    ).to.throw(/Occurs check failed/);
  });
});

describe('occurs check in substitution', () => {
  it('throws an error when a type variable occurs in its own substitution', () => {
    const a = mkTypeVar('a');
    const b = mkTypeVar('b');
    const funType = arrow(a, b);

    expect(() => substituteType(a, a, funType))
      .to.throw(/Occurs check failed/);
  });
});

describe('normalize', () => {
  it('normalizes a type with repeated variables correctly', () => {
    const nonNormalized = arrow(mkTypeVar('q'), arrow(mkTypeVar('p'), mkTypeVar('q')));
    const expected = arrow(mkTypeVar('a'), arrow(mkTypeVar('b'), mkTypeVar('a')));

    const normalized = normalize(nonNormalized);

    expect(typesLitEq(normalized, expected)).to.equal(true);
  });

  it('normalizes a chain of arrow types assigning fresh names in order of appearance', () => {
    const nonNormalized = arrows(mkTypeVar('x'), mkTypeVar('y'), mkTypeVar('z'));
    const expected = arrows(mkTypeVar('a'), mkTypeVar('b'), mkTypeVar('c'));
    const normalized = normalize(nonNormalized);

    expect(typesLitEq(normalized, expected)).to.equal(true);
  });

  it('leaves an already normalized type unchanged', () => {
    const normalizedInput = arrow(mkTypeVar('a'), arrow(mkTypeVar('b'), mkTypeVar('a')));
    const normalizedOutput = normalize(normalizedInput);

    expect(typesLitEq(normalizedInput, normalizedOutput)).to.equal(true);
  });

});

describe('advanced unification', () => {
  it('throws an error when trying to unify a variable with a type that contains it (circular)', () => {
    const a = mkTypeVar('a');
    const b = mkTypeVar('b');
    const funType = arrow(a, b);
    const context = new Map<string, Type>();

    context.set('x', a);

    expect(() => {
      unify(a, funType, context);
    }).to.throw(/Occurs check failed/);
  });

  it('unifies two arrow types by decomposing their structure', () => {
    const a = mkTypeVar('a');
    const b = mkTypeVar('b');
    const c = mkTypeVar('c');

    const t1 = arrow(a, a);
    const t2 = arrow(b, c);

    const context = new Map<string, Type>();
    context.set('x', t1);
    unify(t1, t2, context);

    expect(context.get('x')).to.satisfy((ty: { lft: Type; rgt: Type; }) => {
      return typesLitEq(ty.lft, ty.rgt);
    });
  });
});
