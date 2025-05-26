import { expect } from 'chai';
import { elaborateSystemF } from '../../../lib/meta/frontend/elaboration.js';
import { SymbolTable } from '../../../lib/meta/trip.js';
import { mkSystemFVar, mkSystemFTypeApp, mkSystemFTAbs, mkSystemFAbs, mkSystemFApp } from '../../../lib/terms/systemF.js';
import { insertAVL, createEmptyAVL } from '../../../lib/data/avl/avlNode.js';
import { compareStrings } from '../../../lib/data/map/stringMap.js';
import { BaseType, arrow } from '../../../lib/types/types.js';

describe('elaborateSystemF', () => {
  function createSymbolTable(types: { name: string; type: BaseType }[]): SymbolTable {
    const table: SymbolTable = {
      terms: createEmptyAVL(),
      types: createEmptyAVL()
    };

    for (const { name, type } of types) {
      table.types = insertAVL(table.types, name, { kind: 'type', name, type }, compareStrings);
    }

    return table;
  }

  it('should rewrite term applications as type applications when right-hand side is a type', () => {
    const syms = createSymbolTable([
      { name: 'T', type: { kind: 'type-var', typeName: 'T' } }
    ]);

    // Create expression: x T
    const expr = mkSystemFApp(
      mkSystemFVar('x'),
      mkSystemFVar('T')
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFTypeApp(
        mkSystemFVar('x'),
        { kind: 'type-var', typeName: 'T' }
      )
    );
  });

  it('should handle nested type applications', () => {
    const syms = createSymbolTable([
      { name: 'T', type: { kind: 'type-var', typeName: 'T' } },
      { name: 'U', type: { kind: 'type-var', typeName: 'U' } }
    ]);

    // Create expression: (x T) U
    const expr = mkSystemFApp(
      mkSystemFApp(
        mkSystemFVar('x'),
        mkSystemFVar('T')
      ),
      mkSystemFVar('U')
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFTypeApp(
        mkSystemFTypeApp(
          mkSystemFVar('x'),
          { kind: 'type-var', typeName: 'T' }
        ),
        { kind: 'type-var', typeName: 'U' }
      )
    );
  });

  it('should not rewrite applications when right-hand side is not a type', () => {
    const syms = createSymbolTable([
      { name: 'T', type: { kind: 'type-var', typeName: 'T' } }
    ]);

    // Create expression: x y
    const expr = mkSystemFApp(
      mkSystemFVar('x'),
      mkSystemFVar('y')
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFApp(
        mkSystemFVar('x'),
        mkSystemFVar('y')
      )
    );
  });

  it('should handle mixed type and term applications', () => {
    const syms = createSymbolTable([
      { name: 'T', type: { kind: 'type-var', typeName: 'T' } }
    ]);

    // Create expression: (x T) y
    const expr = mkSystemFApp(
      mkSystemFApp(
        mkSystemFVar('x'),
        mkSystemFVar('T')
      ),
      mkSystemFVar('y')
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFApp(
        mkSystemFTypeApp(
          mkSystemFVar('x'),
          { kind: 'type-var', typeName: 'T' }
        ),
        mkSystemFVar('y')
      )
    );
  });

  it('should handle type abstractions correctly', () => {
    const syms = createSymbolTable([
      { name: 'T', type: { kind: 'type-var', typeName: 'T' } }
    ]);

    // Create expression: ΛX. x T
    const expr = mkSystemFTAbs(
      'X',
      mkSystemFApp(
        mkSystemFVar('x'),
        mkSystemFVar('T')
      )
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFTAbs(
        'X',
        mkSystemFTypeApp(
          mkSystemFVar('x'),
          { kind: 'type-var', typeName: 'T' }
        )
      )
    );
  });

  it('should handle polymorphic successor function correctly', () => {
    const syms = createSymbolTable([
      { name: 'X', type: { kind: 'type-var', typeName: 'X' } }
    ]);

    // Create expression: λn:Nat.ΛX.λs:(X→X).λz:X.(s (n[X] s z))
    const expr = mkSystemFAbs(
      'n',
      { kind: 'type-var', typeName: 'Nat' },
      mkSystemFTAbs(
        'X',
        mkSystemFAbs(
          's',
          arrow(
            { kind: 'type-var', typeName: 'X' },
            { kind: 'type-var', typeName: 'X' }
          ),
          mkSystemFAbs(
            'z',
            { kind: 'type-var', typeName: 'X' },
            mkSystemFApp(
              mkSystemFVar('s'),
              mkSystemFApp(
                mkSystemFTypeApp(
                  mkSystemFVar('n'),
                  { kind: 'type-var', typeName: 'X' }
                ),
                mkSystemFApp(
                  mkSystemFVar('s'),
                  mkSystemFVar('z')
                )
              )
            )
          )
        )
      )
    );

    const result = elaborateSystemF(expr, syms);

    expect(result).to.deep.equal(
      mkSystemFAbs(
        'n',
        { kind: 'type-var', typeName: 'Nat' },
        mkSystemFTAbs(
          'X',
          mkSystemFAbs(
            's',
            arrow(
              { kind: 'type-var', typeName: 'X' },
              { kind: 'type-var', typeName: 'X' }
            ),
            mkSystemFAbs(
              'z',
              { kind: 'type-var', typeName: 'X' },
              mkSystemFApp(
                mkSystemFVar('s'),
                mkSystemFApp(
                  mkSystemFTypeApp(
                    mkSystemFVar('n'),
                    { kind: 'type-var', typeName: 'X' }
                  ),
                  mkSystemFApp(
                    mkSystemFVar('s'),
                    mkSystemFVar('z')
                  )
                )
              )
            )
          )
        )
      )
    );
  });
});
