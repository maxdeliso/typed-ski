import { assert } from 'chai';
import { indexSymbols, resolveDefTerm } from '../../../lib/meta/frontend/symbolTable.js';
import { TripLangProgram, PolyDefinition, TypedDefinition, TypeDefinition } from '../../../lib/meta/trip.js';
import { CompilationError } from '../../../lib/meta/frontend/compilation.js';
import { searchAVL } from '../../../lib/data/avl/avlNode.js';
import { compareStrings } from '../../../lib/data/map/stringMap.js';

describe('Symbol Table', () => {
  describe('indexSymbols', () => {
    it('should index a program with unique terms and types', () => {
      const program: TripLangProgram = {
        kind: 'program',
        terms: [
          {
            kind: 'poly',
            name: 'id',
            term: { kind: 'systemF-var', name: 'x' }
          },
          {
            kind: 'type',
            name: 'Nat',
            type: { kind: 'type-var', typeName: 'X' }
          }
        ]
      };

      const symbols = indexSymbols(program);
      const term = searchAVL(symbols.terms, 'id', compareStrings);
      const type = searchAVL(symbols.types, 'Nat', compareStrings);

      assert.isDefined(term);
      assert.isDefined(type);
      assert.deepStrictEqual(term, program.terms[0]);
      assert.deepStrictEqual(type, program.terms[1]);
    });

    it('should throw on duplicate term definitions', () => {
      const program: TripLangProgram = {
        kind: 'program',
        terms: [
          {
            kind: 'poly',
            name: 'id',
            term: { kind: 'systemF-var', name: 'x' }
          },
          {
            kind: 'poly',
            name: 'id',
            term: { kind: 'systemF-var', name: 'y' }
          }
        ]
      };

      assert.throws(
        () => indexSymbols(program),
        CompilationError,
        'Duplicate definition: id'
      );
    });

    it('should throw on duplicate type definitions', () => {
      const program: TripLangProgram = {
        kind: 'program',
        terms: [
          {
            kind: 'type',
            name: 'Nat',
            type: { kind: 'type-var', typeName: 'X' }
          },
          {
            kind: 'type',
            name: 'Nat',
            type: { kind: 'type-var', typeName: 'Y' }
          }
        ]
      };

      assert.throws(
        () => indexSymbols(program),
        CompilationError,
        'Duplicate type'
      );
    });
  });

  describe('resolveDefTerm', () => {
    it('should resolve poly term definition', () => {
      const term: PolyDefinition = {
        kind: 'poly',
        name: 'id',
        term: { kind: 'systemF-var', name: 'x' }
      };

      const resolved = resolveDefTerm(term);
      assert.deepStrictEqual(resolved, { kind: 'systemF-var', name: 'x' });
    });

    it('should resolve typed term definition', () => {
      const term: TypedDefinition = {
        kind: 'typed',
        name: 'id',
        type: { kind: 'type-var', typeName: 'X' },
        term: { kind: 'lambda-var', name: 'x' }
      };

      const resolved = resolveDefTerm(term);
      assert.deepStrictEqual(resolved, { kind: 'lambda-var', name: 'x' });
    });

    it('should resolve type definition', () => {
      const term: TypeDefinition = {
        kind: 'type',
        name: 'Nat',
        type: { kind: 'type-var', typeName: 'X' }
      };

      const resolved = resolveDefTerm(term);
      assert.deepStrictEqual(resolved, { kind: 'type-var', typeName: 'X' });
    });
  });
});
