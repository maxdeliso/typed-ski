import { assert } from 'chai';
import { substitute } from '../../../lib/meta/frontend/substitution.js';
import { CompilationError } from '../../../lib/meta/frontend/compilation.js';
import { SystemFTerm, mkSystemFVar, mkSystemFAbs, mkSystemFTAbs, mkSystemFTypeApp, mkSystemFApp } from '../../../lib/terms/systemF.js';

describe('Substitution', () => {
  describe('substitute', () => {
    it('should throw on invalid type', () => {
      const type = { kind: 'invalid' } as unknown;

      assert.throws(
        () => substitute(
          type as SystemFTerm,
          () => [],
          () => false,
          n => n,
          () => true,
          (n, rebuilt) => {
            throw new CompilationError(
              'Substitution failed: no result found', 'resolve',
              { term: n, substitutions: rebuilt });
          }
        ),
        CompilationError,
        'Substitution failed: no result found'
      );
    });

    it('should substitute a variable with a term', () => {
      const varTerm = mkSystemFVar('x');
      const replacement = mkSystemFVar('y');

      const result = substitute<SystemFTerm>(
        varTerm,
        () => [],
        n => n.kind === 'systemF-var' && n.name === 'x',
        () => replacement,
        () => false,
        n => n
      );

      assert.deepEqual(result, replacement);
    });

    it('should substitute within a term abstraction', () => {
      const absTerm = mkSystemFAbs('x', { kind: 'type-var', typeName: 'T' }, mkSystemFVar('x'));
      const replacement = mkSystemFVar('y');

      const result = substitute<SystemFTerm>(
        absTerm,
        n => n.kind === 'systemF-abs' ? [n.body] : [],
        n => n.kind === 'systemF-var' && n.name === 'x',
        () => replacement,
        n => n.kind === 'systemF-abs',
        (n, rebuilt) => {
          if (n.kind === 'systemF-abs') {
            return mkSystemFAbs(n.name, n.typeAnnotation, rebuilt.pop()!);
          }
          return n;
        }
      );

      assert.deepEqual(result, mkSystemFAbs('x', { kind: 'type-var', typeName: 'T' }, replacement));
    });

    it('should substitute within a type abstraction', () => {
      const typeAbs = mkSystemFTAbs('X', mkSystemFVar('x'));
      const replacement = mkSystemFVar('y');

      const result = substitute<SystemFTerm>(
        typeAbs,
        n => n.kind === 'systemF-type-abs' ? [n.body] : [],
        n => n.kind === 'systemF-var' && n.name === 'x',
        () => replacement,
        n => n.kind === 'systemF-type-abs',
        (n, rebuilt) => {
          if (n.kind === 'systemF-type-abs') {
            return mkSystemFTAbs(n.typeVar, rebuilt.pop()!);
          }
          return n;
        }
      );

      assert.deepEqual(result, mkSystemFTAbs('X', replacement));
    });

    it('should substitute within a type application', () => {
      const typeApp = mkSystemFTypeApp(mkSystemFVar('x'), { kind: 'type-var', typeName: 'T' });
      const replacement = mkSystemFVar('y');

      const result = substitute<SystemFTerm>(
        typeApp,
        n => n.kind === 'systemF-type-app' ? [n.term] : [],
        n => n.kind === 'systemF-var' && n.name === 'x',
        () => replacement,
        n => n.kind === 'systemF-type-app',
        (n, rebuilt) => {
          if (n.kind === 'systemF-type-app') {
            return mkSystemFTypeApp(rebuilt.pop()!, n.typeArg);
          }
          return n;
        }
      );

      assert.deepEqual(result, mkSystemFTypeApp(replacement, { kind: 'type-var', typeName: 'T' }));
    });

    it('should handle nested term substitution', () => {
      const nestedTerm = mkSystemFApp(
        mkSystemFAbs('x', { kind: 'type-var', typeName: 'T' }, mkSystemFVar('x')),
        mkSystemFVar('y')
      );
      const replacement = mkSystemFVar('z');

      const result = substitute<SystemFTerm>(
        nestedTerm,
        n => {
          if (n.kind === 'non-terminal') return [n.lft, n.rgt];
          if (n.kind === 'systemF-abs') return [n.body];
          return [];
        },
        n => n.kind === 'systemF-var' && n.name === 'y',
        () => replacement,
        n => n.kind === 'non-terminal' || n.kind === 'systemF-abs',
        (n, rebuilt) => {
          if (n.kind === 'non-terminal') {
            return mkSystemFApp(rebuilt.pop()!, rebuilt.pop()!);
          }
          if (n.kind === 'systemF-abs') {
            return mkSystemFAbs(n.name, n.typeAnnotation, rebuilt.pop()!);
          }
          return n;
        }
      );

      const expected = mkSystemFApp(
        mkSystemFAbs('x', { kind: 'type-var', typeName: 'T' }, mkSystemFVar('x')),
        replacement
      );

      assert.deepEqual(result, expected);
    });
  });
});
