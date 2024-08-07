import { cons } from '../../lib/cons.ts';
import { Appendable } from '../../lib/parser/appendable.ts';
import { SKIExpression } from '../../lib/ski/expression.ts';
import { S, K, I } from '../../lib/ski/terminal.ts';

import { expect } from 'chai';

describe('appendable expressions', () => {
  it('append a pair of terminals into a single non-terminal', () => {
    const app = new Appendable();
    app.appendSymbol(S);
    app.appendSymbol(K);
    app.flatten();
    expect(app.flatten()).to.deep.equal(cons(S, K));
  });

  it('append undefined and a terminal to yield that terminal', () => {
    const app = new Appendable();
    app.appendSymbol(S);
    expect(app.flatten()).to.deep.equal(S);
  });

  it('fills in undefined holes on the left side of a non-terminal', () => {
    const app = new Appendable();
    app.appendEmptyBranch();
    app.appendSymbol(S);
    app.appendSymbol(K);
    expect(app.flatten()).to.deep.equal(cons(S, K));
  });

  it('throws when attempting to flatten an incomplete expr', () => {
    const app = new Appendable();
    app.appendEmptyBranch();
    expect(() => app.flatten()).to.throw('expression undefined (hole)');
  });

  it('successfully parses a tree which hangs to the right', () => {
    const app = new Appendable();
    app.appendEmptyBranch();
    app.appendEmptyBranch();
    app.appendEmptyBranch();
    app.appendSymbol(S);
    app.appendSymbol(K);
    app.appendEmptyBranch();
    app.appendSymbol(I);
    app.appendSymbol(S);
    app.appendEmptyBranch();
    app.appendSymbol(K);
    app.appendSymbol(I);
    expect(app.flatten()).to.deep.equal(
      cons<SKIExpression>(
        cons<SKIExpression>(
          cons<SKIExpression>(
            S,
            K
          ),
          cons<SKIExpression>(
            I,
            S
          )
        ),
        cons<SKIExpression>(
          K,
          I
        )
      )
    );
  });

  it('successfully parses a mixed tree', () => {
    const app = new Appendable();
    app.appendEmptyBranch();
    app.appendSymbol(S);
    app.appendSymbol(K);
    app.appendEmptyBranch();
    app.appendSymbol(I);
    app.appendSymbol(S);
    app.appendEmptyBranch();
    app.appendSymbol(K);
    app.appendSymbol(I);
    expect(app.flatten()).to.deep.equal(
      cons<SKIExpression>(
        cons<SKIExpression>(
          cons<SKIExpression>(
            S,
            K
          ),
          cons<SKIExpression>(
            I,
            S
          )
        ),
        cons<SKIExpression>(
          K,
          I
        )
      )
    );
  });
});
