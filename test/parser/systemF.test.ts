import { strict as assert } from 'assert';
import { parseSystemF } from '../../lib/parser/systemFTerm.ts';

describe('System F Parser', () => {
  it('parses a single variable', () => {
    const input = 'x';
    const [lit, ast] = parseSystemF(input);
    // Expect the literal string to match the input.
    assert.equal(lit, 'x');
    // The AST should be a variable node.
    assert.equal(ast.kind, 'systemF-var');
    assert.equal(ast.name, 'x');
  });

  it('parses a term abstraction', () => {
    // Example: λx:X.x
    const input = 'λx:X.x';
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, 'λx:X.x');

    // The AST should be a term abstraction.
    assert.equal(ast.kind, 'systemF-abs');
    assert.equal(ast.name, 'x');

    // The type annotation should be a type variable "X".
    const tyAnnot = ast.typeAnnotation;
    assert.equal(tyAnnot.kind, 'type-var');
    assert.equal(tyAnnot.typeName, 'X');

    // The body should be the variable "x".
    const body = ast.body;
    assert.equal(body.kind, 'systemF-var');
    assert.equal(body.name, 'x');
  });

  it('parses a type abstraction', () => {
    // Example: ΛX.λx:X.x
    const input = 'ΛX.λx:X.x';
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, 'ΛX.λx:X.x');
    // The AST should be a type abstraction.
    assert.equal(ast.kind, 'systemF-type-abs');
    assert.equal(ast.typeVar, 'X');

    // Its body should be a term abstraction.
    const body = ast.body;
    assert.equal(body.kind, 'systemF-abs');
    assert.equal(body.name, 'x');
    assert.equal(body.typeAnnotation.kind, 'type-var');
    assert.equal(body.typeAnnotation.typeName, 'X');
    assert.equal(body.body.kind, 'systemF-var');
    assert.equal(body.body.name, 'x');
  });

  it('parses a term with type application', () => {
    // Example: x[∀Y.Y→Y]
    // This applies variable x to a type argument which is a universal type.
    const input = 'x[∀Y.Y→Y]';
    const [lit, ast] = parseSystemF(input);
    assert.equal(lit, 'x[∀Y.Y→Y]');

    // The AST should be a type application node.
    assert.equal(ast.kind, 'systemF-type-app');

    // The term part should be a variable "x".
    const term = ast.term;
    assert.equal(term.kind, 'systemF-var');
    assert.equal(term.name, 'x');

    // The type argument should be a universal type.
    const typeArg = ast.typeArg;
    assert.equal(typeArg.kind, 'forall');
    assert.equal(typeArg.typeVar, 'Y');

    // The body of the forall is an arrow type (a cons cell) representing Y→Y.
    assert.equal(typeArg.body.kind, 'non-terminal');
    const left = typeArg.body.lft;
    const right = typeArg.body.rgt;
    assert.equal(left.kind, 'type-var');
    assert.equal(left.typeName, 'Y');
    assert.equal(right.kind, 'type-var');
    assert.equal(right.typeName, 'Y');
  });

  it('parses left-associative term applications', () => {
    // Example: x y z
    // This should be parsed as ((x y) z)
    const input = 'x y z';
    const [lit, ast] = parseSystemF(input);

    // Expect the literal to be "x y z" (or equivalent).
    assert.equal(lit, 'x y z');

    // The outermost AST node for application is a cons cell.
    assert.equal(ast.kind, 'non-terminal');

    // Its left branch should also be a cons cell representing (x y).
    const inner = ast.lft;
    assert.equal(inner.kind, 'non-terminal');

    // The left branch of the inner cons cell should be the variable "x".
    assert.equal(inner.lft.kind, 'systemF-var');
    assert.equal(inner.lft.name, 'x');

    // The right branch of the inner cons cell should be the variable "y".
    assert.equal(inner.rgt.kind, 'systemF-var');
    assert.equal(inner.rgt.name, 'y');

    // The right branch of the outer cons cell should be the variable "z".
    assert.equal(ast.rgt.kind, 'systemF-var');
    assert.equal(ast.rgt.name, 'z');
  });

  it('throws an error on incomplete or malformed input', () => {
    const badInputs = [
      '(',         // missing closing parenthesis
      'λx:X',      // missing dot and body
      'x)',        // unmatched closing parenthesis
      'x y )',     // stray parenthesis at end
      '∀X X',     // missing dot after ∀X
    ];
    badInputs.forEach(input => {
      assert.throws(() => {
        parseSystemF(input);
      }, Error, `Expected an error for input: ${input}`);
    });
  });
});
