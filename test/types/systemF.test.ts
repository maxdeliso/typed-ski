import { expect } from 'chai';

import {
  SystemFTerm,
  mkSystemFVar,
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFApp
} from '../../lib/terms/systemF.js';

import { mkTypeVariable, arrow, prettyPrintTy } from '../../lib/types/types.js';
import { emptySystemFContext, typecheckSystemF, SystemFContext, eraseSystemF } from '../../lib/types/systemF.js';
import { parseSystemF } from '../../lib/parser/systemFTerm.js';
import { insertAVL } from '../../lib/data/avl/avlNode.js';
import { compareStrings } from '../../lib/data/map/stringMap.js';

describe('System F Type Checker (using AVL context)', () => {
  describe('Positive Cases', () => {
    it('should typecheck the polymorphic identity function', () => {
      // Polymorphic identity: ΛX. λx: X. x
      const id: SystemFTerm = mkSystemFTAbs('X',
        mkSystemFAbs('x', mkTypeVariable('X'), mkSystemFVar('x'))
      );
      const ctx: SystemFContext = emptySystemFContext();
      const [ty] = typecheckSystemF(ctx, id);

      // Expected type: ∀X. (X → X)
      expect(ty.kind).to.equal('forall');
      if (ty.kind === 'forall') {
        expect(ty.typeVar).to.equal('X');
        // The body of the forall should be an arrow type (represented as a cons cell).
        expect(ty.body.kind).to.equal('non-terminal');
        if ('lft' in ty.body && 'rgt' in ty.body) {
          expect(ty.body.lft.kind).to.equal('type-var');
          expect(ty.body.rgt.kind).to.equal('type-var');
          if (ty.body.lft.kind === 'type-var' && ty.body.rgt.kind === 'type-var') {
            expect(ty.body.lft.typeName).to.equal('X');
            expect(ty.body.rgt.typeName).to.equal('X');
          }
        }
      }
    });

    it('should typecheck the K combinator', () => {
      // K combinator: ΛX. ΛY. λx: X. λy: Y. x
      const K: SystemFTerm = mkSystemFTAbs('X',
        mkSystemFTAbs('Y',
          mkSystemFAbs('x', mkTypeVariable('X'),
            mkSystemFAbs('y', mkTypeVariable('Y'), mkSystemFVar('x'))
          )
        )
      );
      const ctx: SystemFContext = emptySystemFContext();
      const [ty] = typecheckSystemF(ctx, K);

      // Expected type: ∀X. ∀Y. (X → (Y → X))
      expect(ty.kind).to.equal('forall');
      const printed = prettyPrintTy(ty);
      expect(printed).to.match(/∀X\..*∀Y\..*X→\(Y→X\)/);
    });

    it('should typecheck type application', () => {
      // Let id = ΛX. λx: X. x
      const id: SystemFTerm = mkSystemFTAbs('X',
        mkSystemFAbs('x', mkTypeVariable('X'), mkSystemFVar('x'))
      );
      // Build type application: id [A]
      const idA: SystemFTerm = mkSystemFTypeApp(id, mkTypeVariable('A'));
      // Build term application: (id [A]) a
      const term: SystemFTerm = mkSystemFApp(idA, mkSystemFVar('a'));

      // Update the context using the AVL tree: add binding for "a" : A
      let ctx: SystemFContext = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: insertAVL(ctx.termCtx, 'a', mkTypeVariable('A'), compareStrings)
      };

      const [ty] = typecheckSystemF(ctx, term);
      // Expect the result type to be A.
      expect(ty.kind).to.equal('type-var');
      if (ty.kind === 'type-var') {
        expect(ty.typeName).to.equal('A');
      }
    });

    it('should typecheck the S combinator', () => {
      // S combinator:
      // S = ΛA. ΛB. ΛC. λx: (A → B → C). λy: (A → B). λz: A. ((x z) (y z))
      const S: SystemFTerm = mkSystemFTAbs('A',
        mkSystemFTAbs('B',
          mkSystemFTAbs('C',
            mkSystemFAbs('x', arrow(mkTypeVariable('A'), arrow(mkTypeVariable('B'), mkTypeVariable('C'))),
              mkSystemFAbs('y', arrow(mkTypeVariable('A'), mkTypeVariable('B')),
                mkSystemFAbs('z', mkTypeVariable('A'),
                  mkSystemFApp(
                    mkSystemFApp(mkSystemFVar('x'), mkSystemFVar('z')),
                    mkSystemFApp(mkSystemFVar('y'), mkSystemFVar('z'))
                  )
                )
              )
            )
          )
        )
      );

      const ctx: SystemFContext = emptySystemFContext();
      const [ty] = typecheckSystemF(ctx, S);

      // Expected type: ∀A. ∀B. ∀C. ((A → (B → C)) → ((A → B) → (A → C)))
      expect(ty.kind).to.equal('forall');
      const printed = prettyPrintTy(ty);
      expect(printed).to.equal('∀A.∀B.∀C.((A→(B→C))→((A→B)→(A→C)))');
    });
  });

  describe('Negative Cases', () => {
    it('should fail when a variable is unbound', () => {
      const term: SystemFTerm = mkSystemFVar('a');
      const ctx: SystemFContext = emptySystemFContext();
      expect(() => typecheckSystemF(ctx, term)).to.throw(Error, /unknown variable/);
    });

    it('should fail when applying a non-arrow', () => {
      let ctx: SystemFContext = emptySystemFContext();
      // Insert bindings using the AVL helper.
      ctx = { ...ctx, termCtx: insertAVL(ctx.termCtx, 'a', mkTypeVariable('A'), compareStrings) };
      ctx = { ...ctx, termCtx: insertAVL(ctx.termCtx, 'b', mkTypeVariable('B'), compareStrings) };

      // Application: a b
      const term: SystemFTerm = mkSystemFApp(mkSystemFVar('a'), mkSystemFVar('b'));
      expect(() => typecheckSystemF(ctx, term)).to.throw(Error, /expected an arrow type/);
    });

    it('should fail when a type application is used on a non-universal type', () => {
      let ctx: SystemFContext = emptySystemFContext();
      ctx = { ...ctx, termCtx: insertAVL(ctx.termCtx, 'a', mkTypeVariable('A'), compareStrings) };
      // Attempt a type application on a variable of type A.
      const term: SystemFTerm = mkSystemFTypeApp(mkSystemFVar('a'), mkTypeVariable('B'));
      expect(() => typecheckSystemF(ctx, term)).to.throw(Error, /type application expected a universal type/);
    });

    it('should fail when a function argument type does not match', () => {
      // f = λx: A. x, so f: A → A; try to apply it to an argument of type B.
      const f: SystemFTerm = mkSystemFAbs('x', mkTypeVariable('A'), mkSystemFVar('x'));
      let ctx: SystemFContext = emptySystemFContext();
      ctx = { ...ctx, termCtx: insertAVL(ctx.termCtx, 'f', arrow(mkTypeVariable('A'), mkTypeVariable('A')), compareStrings) };
      ctx = { ...ctx, termCtx: insertAVL(ctx.termCtx, 'a', mkTypeVariable('B'), compareStrings) };

      // Application: f a
      const term: SystemFTerm = mkSystemFApp(f, mkSystemFVar('a'));
      expect(() => typecheckSystemF(ctx, term)).to.throw(Error, /function argument type mismatch/);
    });

    it('should fail when a term is applied to itself with non-arrow type', () => {
      // Ill-typed term: λx: X. x x
      const term: SystemFTerm = mkSystemFAbs('x', mkTypeVariable('X'),
        mkSystemFApp(mkSystemFVar('x'), mkSystemFVar('x'))
      );
      const ctx: SystemFContext = emptySystemFContext();
      expect(() => typecheckSystemF(ctx, term)).to.throw(Error, /expected an arrow type/);
    });
  });

  describe('Integration with Parser and Pretty Printer', () => {
    it('should round-trip a well-formed System F term', () => {
      // Example term: polymorphic identity: ΛX. λx: X. x
      const input = 'ΛX. λx: X. x';
      // Assume parseSystemF returns a tuple [parsedLiteral, SystemFTerm]
      const [parsedLit, term] = parseSystemF(input);
      const ctx: SystemFContext = emptySystemFContext();
      const [ty] = typecheckSystemF(ctx, term);
      const printedType = prettyPrintTy(ty);
      expect(printedType).to.match(/∀X\..*X→X/);
      // Check that the parsed literal, after removing whitespace, matches the input.
      expect(parsedLit.replace(/\s+/g, '')).to.equal(input.replace(/\s+/g, ''));
    });
  });
});

describe('SystemF Additional Tests', () => {
  describe('eraseSystemF', () => {
    it('should erase types from System F terms', () => {
      // Term: ΛX.λx:X.x (System F identity function)
      const term: SystemFTerm = mkSystemFTAbs(
        'X',
        mkSystemFAbs('x', mkTypeVariable('X'), mkSystemFVar('x'))
      );

      const erased = eraseSystemF(term);

      // After erasure: λx.x (untyped identity function)
      expect(erased.kind).to.equal('typed-lambda-abstraction');
      if (erased.kind === 'typed-lambda-abstraction') {
        expect(erased.varName).to.equal('x');
        expect(erased.body.kind).to.equal('lambda-var');
        if (erased.body.kind === 'lambda-var') {
          expect(erased.body.name).to.equal('x');
        }
      }
    });

    it('should correctly erase nested type applications', () => {
      // Term: ΛX.ΛY.λf:X→Y.λx:X.(f x)
      const identity: SystemFTerm = mkSystemFTAbs(
        'X',
        mkSystemFTAbs(
          'Y',
          mkSystemFAbs(
            'f',
            arrow(mkTypeVariable('X'), mkTypeVariable('Y')),
            mkSystemFAbs(
              'x',
              mkTypeVariable('X'),
              mkSystemFApp(
                mkSystemFVar('f'),
                mkSystemFVar('x')
              )
            )
          )
        )
      );

      // Apply this to two types: int and bool
      const applied: SystemFTerm = mkSystemFTypeApp(
        mkSystemFTypeApp(
          identity,
          mkTypeVariable('int')
        ),
        mkTypeVariable('bool')
      );

      const erased = eraseSystemF(applied);

      // After erasure: λf.λx.(f x) (the types are erased)
      expect(erased.kind).to.equal('typed-lambda-abstraction');
      if (erased.kind === 'typed-lambda-abstraction') {
        expect(erased.varName).to.equal('f');
        expect(erased.body.kind).to.equal('typed-lambda-abstraction');
        if (erased.body.kind === 'typed-lambda-abstraction') {
          expect(erased.body.varName).to.equal('x');
          expect(erased.body.body.kind).to.equal('non-terminal');
        }
      }
    });
  });

  describe('typecheckSystemF edge cases', () => {
    it('should handle nested type abstractions', () => {
      // Term: ΛX.ΛY.λx:X.λy:Y.x (K combinator in System F)
      const term: SystemFTerm = mkSystemFTAbs(
        'X',
        mkSystemFTAbs(
          'Y',
          mkSystemFAbs(
            'x',
            mkTypeVariable('X'),
            mkSystemFAbs(
              'y',
              mkTypeVariable('Y'),
              mkSystemFVar('x')
            )
          )
        )
      );

      const ctx = emptySystemFContext();
      const [type] = typecheckSystemF(ctx, term);

      // Should have type ∀X.∀Y.X→Y→X
      expect(type.kind).to.equal('forall');
      if (type.kind === 'forall') {
        expect(type.body.kind).to.equal('forall');
      }
    });

    it('should typecheck with a non-empty initial context', () => {
      // Create a context with predefined variables
      let ctx = emptySystemFContext();

      // Add binding: x: A
      ctx = {
        ...ctx,
        termCtx: insertAVL(
          ctx.termCtx,
          'x',
          mkTypeVariable('A'),
          compareStrings
        )
      };

      // Add binding: f: A→B
      ctx = {
        ...ctx,
        termCtx: insertAVL(
          ctx.termCtx,
          'f',
          arrow(mkTypeVariable('A'), mkTypeVariable('B')),
          compareStrings
        )
      };

      // Term: f x (should type check with existing context)
      const term: SystemFTerm = mkSystemFApp(
        mkSystemFVar('f'),
        mkSystemFVar('x')
      );

      const [type] = typecheckSystemF(ctx, term);

      // Should have type B
      expect(type.kind).to.equal('type-var');
      if (type.kind === 'type-var') {
        expect(type.typeName).to.equal('B');
      }
    });

    it('should typecheck combined term and type application', () => {
      // Define the polymorphic identity function
      const polyId: SystemFTerm = mkSystemFTAbs(
        'X',
        mkSystemFAbs('x', mkTypeVariable('X'), mkSystemFVar('x'))
      );

      // Term: (ΛX.λx:X.x)[A] y
      const term: SystemFTerm = mkSystemFApp(
        mkSystemFTypeApp(polyId, mkTypeVariable('A')),
        mkSystemFVar('y')
      );

      // Create a context with y: A
      let ctx = emptySystemFContext();
      ctx = {
        ...ctx,
        termCtx: insertAVL(
          ctx.termCtx,
          'y',
          mkTypeVariable('A'),
          compareStrings
        )
      };

      const [type] = typecheckSystemF(ctx, term);

      // Should have type A
      expect(type.kind).to.equal('type-var');
      if (type.kind === 'type-var') {
        expect(type.typeName).to.equal('A');
      }
    });
  });
});
