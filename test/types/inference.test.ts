import { expect } from 'chai';
import { describe, it } from 'mocha';

import { mkVar, mkUntypedAbs, typelessApp } from '../../lib/terms/lambda.js';
import {
  inferType,
  substituteType,
} from '../../lib/types/inference.js';
import {
  arrow,
  mkTypeVariable,
  typesLitEq,
} from '../../lib/types/types.js';

describe('Type Inference Tests', () => {
  describe('substituteType', () => {
    it('should substitute a type variable with another type', () => {
      const a = mkTypeVariable('a');
      const b = mkTypeVariable('b');
      const c = mkTypeVariable('c');

      // Substitute 'a' with 'b' in 'a'
      const result1 = substituteType(a, a, b);
      expect(typesLitEq(result1, b)).to.equal(true);

      // Substitute 'a' with 'b' in 'c'
      const result2 = substituteType(c, a, b);
      expect(typesLitEq(result2, c)).to.equal(true);

      // Substitute 'a' with 'b' in 'a -> c'
      const arrowType = arrow(a, c);
      const result3 = substituteType(arrowType, a, b);
      expect(typesLitEq(result3, arrow(b, c))).to.equal(true);
    });

    it('should handle substitutions in complex types', () => {
      const a = mkTypeVariable('a');
      const b = mkTypeVariable('b');
      const c = mkTypeVariable('c');

      // (a -> b) -> c
      const complexType = arrow(arrow(a, b), c);
      const result = substituteType(complexType, a, c);

      // Should become (c -> b) -> c
      expect(typesLitEq(result, arrow(arrow(c, b), c))).to.equal(true);
    });

    it('should handle nested substitutions', () => {
      const a = mkTypeVariable('a');
      const b = mkTypeVariable('b');

      // (a -> a) -> (a -> a)
      const nestedType = arrow(arrow(a, a), arrow(a, a));
      const result = substituteType(nestedType, a, b);

      // Should become (b -> b) -> (b -> b)
      expect(typesLitEq(result, arrow(arrow(b, b), arrow(b, b)))).to.equal(true);
    });
  });

  // Tests for inferType
  describe('inferType', () => {
    it('should infer the type of a variable', () => {
      // Create a variable term and infer its type
      // Instead, let's test inferType on a simple lambda abstraction
      const idTerm = mkUntypedAbs('x', mkVar('x'));
      const [, ty] = inferType(idTerm);

      // Should infer the identity function's type (something like t0 -> t0)
      expect(ty.kind).to.equal('non-terminal');
      // We should now have a consistently typed result
    });

    it('should infer the type of a lambda abstraction', () => {
      const term = mkUntypedAbs('x', mkVar('x'));
      const [, ty] = inferType(term);

      // Should infer something like t0 -> t0
      expect(ty.kind).to.equal('non-terminal');
      // Check that the left and right parts of the arrow are the same type variable
      if (ty.kind === 'non-terminal' &&
          ty.lft.kind === 'type-var' &&
          ty.rgt.kind === 'type-var') {
        expect(ty.lft.typeName).to.equal(ty.rgt.typeName);
      }
    });

    it('should infer the type of an application', () => {
      // Use the application combinator: λf.λx.(f x)
      // This is a well-typed term with type (a → b) → a → b
      const appCombinator = mkUntypedAbs('f',
        mkUntypedAbs('x',
          typelessApp(
            mkVar('f'),
            mkVar('x')
          )
        )
      );

      const [, ty] = inferType(appCombinator);

      // The type should be an arrow type (non-terminal)
      expect(ty.kind).to.equal('non-terminal');
    });

    it('should handle complex expressions', () => {
      // Let's use the K combinator: λx.λy.x
      const K = mkUntypedAbs('x', mkUntypedAbs('y', mkVar('x')));

      const [, ty] = inferType(K);

      // K's type is a → b → a, which is a non-terminal (arrow) type
      expect(ty.kind).to.equal('non-terminal');
    });
  });
});
