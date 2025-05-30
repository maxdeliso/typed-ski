import { expect } from 'chai';
import { describe, it } from 'mocha';

import { cons } from '../../lib/cons.js';
import { mkVar } from '../../lib/terms/lambda.js';
import { addBinding, emptyContext, mkTypedAbs, typecheckTypedLambda } from '../../lib/types/typedLambda.js';
import { mkTypeVariable, arrow, typesLitEq, arrows } from '../../lib/types/types.js';

describe('type checking errors', () => {
  it('throws an error for free variables', () => {
    // Create a term with a free variable: just the variable "x" with no binding.
    expect(() => typecheckTypedLambda(mkVar('x'))).to.throw(/unknown term named: x/);
  });

  it('throws an error on duplicate binding', () => {
    let ctx = emptyContext();
    ctx = addBinding(ctx, 'x', mkTypeVariable('a'));
    expect(() => addBinding(ctx, 'x', mkTypeVariable('b')))
      .to.throw(/duplicated binding for name: x/);
  });
});

describe('type checking', () => {
  it('typechecks the I combinator', () => {
    // λx : a . x ≡ I : a -> a
    const typedI = mkTypedAbs('x', mkTypeVariable('a'), mkVar('x'));
    const typeofI = typecheckTypedLambda(typedI);
    const expectedTy = arrow(mkTypeVariable('a'), mkTypeVariable('a'));
    expect(typesLitEq(typeofI, expectedTy)).to.equal(true);
  });

  it('typechecks the K combinator', () => {
    // λx : a . λy : b . x ≡ K : a -> b -> a
    const typedK =
      mkTypedAbs('x', mkTypeVariable('a'), // λx : a
        mkTypedAbs('y', mkTypeVariable('b'), // λy : b
          mkVar('x') // x
        )
      );
    const typeofK = typecheckTypedLambda(typedK);
    const expectedTy = arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('a'));

    expect(typesLitEq(typeofK, expectedTy)).to.equal(true);
  });

  it('typechecks the S combinator', () => {
    // λx : (a -> b -> c) . λy : (a -> b) . λz : a . xz(yz)
    // ≡ S : (a -> b -> c) -> (a -> b) -> (a -> c)
    const typedS =
      mkTypedAbs(
        'x', // a -> b -> c
        arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('c')),
        mkTypedAbs(
          'y', // a -> b
          arrow(mkTypeVariable('a'), mkTypeVariable('b')),
          mkTypedAbs(
            'z', // a
            mkTypeVariable('a'),
            cons(
              cons(mkVar('x'), mkVar('z')),
              cons(mkVar('y'), mkVar('z'))
            )
          )
        )
      );

    // (a -> b -> c) -> (a -> b) -> a -> c
    const expectedTy = arrows(
      arrows(mkTypeVariable('a'), mkTypeVariable('b'), mkTypeVariable('c')),
      arrows(mkTypeVariable('a'), mkTypeVariable('b')),
      arrows(mkTypeVariable('a'), mkTypeVariable('c'))
    );

    const typeofS = typecheckTypedLambda(typedS);

    expect(typesLitEq(typeofS, expectedTy)).to.equal(true);
  });
});
