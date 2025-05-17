import { assert } from 'chai';
import { externalReferences } from '../../../lib/meta/frontend/externalReferences.js';
import { keyValuePairs } from '../../../lib/data/avl/avlNode.js';
import { parseTripLang } from '../../../lib/parser/tripLang.js';
import { resolveDefTerm } from '../../../lib/meta/frontend/symbolTable.js';

describe('externalReferences', () => {
  it('identifies external references in a simple lambda abstraction', () => {
    const input = 'poly id = λx:A.x';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), []);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['A']);
  });

  it('identifies external references in a System F term', () => {
    const input = 'poly id = ΛX.λx:X.x';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), []);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), []);
  });

  it('identifies external references in a term with free variables', () => {
    const input = 'poly free = λx:A.y';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), ['y']);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['A']);
  });

  it('identifies external references in a System F term with free type variables', () => {
    const input = 'poly freeType = ΛX.λx:Y.x';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), []);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['Y']);
  });

  it('identifies external references in a complex term', () => {
    const input = 'poly complex = λx:A.λy:B.(x (y z))';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), ['z']);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['A', 'B']);
  });

  it('identifies external references in a System F term with type application', () => {
    const input = 'poly typeApp = ΛX.λx:X.(x[Y])';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), []);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['Y']);
  });

  it('identifies external references in a non-terminal term', () => {
    const input = 'poly app = (x y)';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), ['x', 'y']);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), []);
  });

  it('identifies external references in a term with nested abstractions', () => {
    const input = 'poly nested = λx:A.λy:B.(λz:C.(x y z))';
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(resolveDefTerm(program.terms[0]));

    assert.deepStrictEqual(keyValuePairs(termRefs).map(kvp => kvp[0]), []);
    assert.deepStrictEqual(keyValuePairs(typeRefs).map(kvp => kvp[0]), ['A', 'B', 'C']);
  });
});
