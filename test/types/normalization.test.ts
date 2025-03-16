import { expect } from 'chai';
import { describe, it } from 'mocha';

import { normalize } from '../../lib/types/normalization.js';
import {
  arrow,
  mkTypeVariable} from '../../lib/types/types.js';
import { forall as mkUniversal } from '../../lib/types/systemF.js';

describe('Type Normalization Tests', () => {
  describe('normalize edge cases', () => {
    it('should handle normalization of a single type variable', () => {
      const a = mkTypeVariable('a');
      const normalized = normalize(a);

      // Should remain the same but with a fresh name
      expect(normalized.kind).to.equal('type-var');
      if (normalized.kind === 'type-var') {
        // The name should start with a letter
        expect(normalized.typeName).to.match(/^[a-z]/);
      }
    });

    it('should handle normalization of nested arrow types with repeated variables', () => {
      // Type: (a -> a) -> (a -> a)
      const repeatedType = arrow(
        arrow(mkTypeVariable('a'), mkTypeVariable('a')),
        arrow(mkTypeVariable('a'), mkTypeVariable('a'))
      );

      const normalized = normalize(repeatedType);

      // The normalized type should replace all occurrences of 'a' with the same fresh name
      if (normalized.kind === 'non-terminal' &&
          normalized.lft.kind === 'non-terminal' &&
          normalized.rgt.kind === 'non-terminal') {

        // Check left side
        if (normalized.lft.lft.kind === 'type-var' &&
            normalized.lft.rgt.kind === 'type-var') {
          const leftVarName = normalized.lft.lft.typeName;
          expect(normalized.lft.rgt.typeName).to.equal(leftVarName);
        } else {
          expect.fail('Expected type variables in nested arrow type');
        }

        // Check right side
        if (normalized.rgt.lft.kind === 'type-var' &&
            normalized.rgt.rgt.kind === 'type-var') {
          const rightVarName = normalized.rgt.lft.typeName;
          expect(normalized.rgt.rgt.typeName).to.equal(rightVarName);
        } else {
          expect.fail('Expected type variables in nested arrow type');
        }

        // All type variable names should be the same
        // We already know these are type variables, so we don't need to check again
        expect(normalized.lft.lft.typeName).to.equal(normalized.rgt.lft.typeName);
      } else {
        expect.fail('Expected nested non-terminal types');
      }
    });

    it('should normalize quantified types', () => {
      // Type: ∀a. a -> a
      const quantifiedType = mkUniversal(
        'a',
        arrow(mkTypeVariable('a'), mkTypeVariable('a'))
      );

      const normalized = normalize(quantifiedType);

      // The result should be a forall with a fresh name
      expect(normalized.kind).to.equal('forall');
      if (normalized.kind === 'forall') {
        // The body should be an arrow type with the same type variable on both sides
        if (normalized.body.kind === 'non-terminal' &&
            normalized.body.lft.kind === 'type-var' &&
            normalized.body.rgt.kind === 'type-var') {
          expect(normalized.body.lft.typeName).to.equal(normalized.body.rgt.typeName);
          // The type variable name should match the one in the forall binding
          expect(normalized.body.lft.typeName).to.equal(normalized.typeVar);
        } else {
          expect.fail('Expected arrow type with matching type variables');
        }
      }
    });

    it('should handle nested forall types', () => {
      // Type: ∀a. ∀b. a -> b -> a
      const nestedForall = mkUniversal(
        'a',
        mkUniversal(
          'b',
          arrow(
            mkTypeVariable('a'),
            arrow(mkTypeVariable('b'), mkTypeVariable('a'))
          )
        )
      );

      const normalized = normalize(nestedForall);

      // The result should preserve the nesting structure
      expect(normalized.kind).to.equal('forall');
      if (normalized.kind === 'forall') {
        const outerVar = normalized.typeVar;

        expect(normalized.body.kind).to.equal('forall');
        if (normalized.body.kind === 'forall') {
          const innerVar = normalized.body.typeVar;

          // The outer and inner bindings should have different names
          expect(outerVar).not.to.equal(innerVar);

          // Check the innermost type (a -> b -> a)
          if (normalized.body.body.kind === 'non-terminal' &&
              normalized.body.body.rgt.kind === 'non-terminal') {

            // First argument type should match the outer binding
            if (normalized.body.body.lft.kind === 'type-var') {
              expect(normalized.body.body.lft.typeName).to.equal(outerVar);
            } else {
              expect.fail('Expected type variable');
            }

            // Second argument type should match the inner binding
            if (normalized.body.body.rgt.lft.kind === 'type-var') {
              expect(normalized.body.body.rgt.lft.typeName).to.equal(innerVar);
            } else {
              expect.fail('Expected type variable');
            }

            // Return type should match the outer binding
            if (normalized.body.body.rgt.rgt.kind === 'type-var') {
              expect(normalized.body.body.rgt.rgt.typeName).to.equal(outerVar);
            } else {
              expect.fail('Expected type variable');
            }
          } else {
            expect.fail('Expected arrow types in body');
          }
        }
      }
    });

    it('should handle multiple occurrences of the same variable across different scopes', () => {
      // Type: (∀a. a -> a) -> (∀a. a -> a)
      // The two 'a's are in different scopes, so they should be normalized to different names
      const complexType = arrow(
        mkUniversal('a', arrow(mkTypeVariable('a'), mkTypeVariable('a'))),
        mkUniversal('a', arrow(mkTypeVariable('a'), mkTypeVariable('a')))
      );

      const normalized = normalize(complexType);

      // The result should have two different forall bindings
      if (normalized.kind === 'non-terminal' &&
          normalized.lft.kind === 'forall' &&
          normalized.rgt.kind === 'forall') {

        const leftVar = normalized.lft.typeVar;
        const rightVar = normalized.rgt.typeVar;

        // The two forall bindings should have different names
        expect(leftVar).not.to.equal(rightVar);

        // Check the left side (∀a. a -> a)
        if (normalized.lft.body.kind === 'non-terminal' &&
            normalized.lft.body.lft.kind === 'type-var' &&
            normalized.lft.body.rgt.kind === 'type-var') {

          expect(normalized.lft.body.lft.typeName).to.equal(leftVar);
          expect(normalized.lft.body.rgt.typeName).to.equal(leftVar);
        } else {
          expect.fail('Expected arrow type with matching type variables');
        }

        // Check the right side (∀a. a -> a)
        if (normalized.rgt.body.kind === 'non-terminal' &&
            normalized.rgt.body.lft.kind === 'type-var' &&
            normalized.rgt.body.rgt.kind === 'type-var') {

          expect(normalized.rgt.body.lft.typeName).to.equal(rightVar);
          expect(normalized.rgt.body.rgt.typeName).to.equal(rightVar);
        } else {
          expect.fail('Expected arrow type with matching type variables');
        }
      } else {
        expect.fail('Expected arrow type with forall types');
      }
    });
  });
});
