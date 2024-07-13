import { Zero, One, Succ, True, False } from '../consts/combinators.ts';
import { apply, SKIExpression } from './expression.ts';
import { SKITerminalSymbol } from './terminal.ts';

/**
 * @see https://en.wikipedia.org/wiki/Church_encoding
 * @param n a number
 * @returns an extensionally equivalent Church numeral.
 */
export const ChurchN = (n: number): SKIExpression => {
  if (n < 0) {
    throw new Error('only positive integers represented');
  } else if (n === 0) {
    return Zero;
  } else if (n === 1) {
    return One;
  } else {
    return apply(Succ, ChurchN(n - 1));
  }
};

/*
 * To verify that combinator expressions produce n applications of f on x,
 * this function is introduced which runs the combinator forward with a lambda
 * that adds one to its argument and returns a number.
 *
 * This is needed because each function has infinitely many representations
 * in the SKI combinators, but we are concerned with whether a given function
 * represents a given Church numeral, regardless of which one it is. This is
 * the notion of extensional equality.
 */
export const UnChurch = (exp: SKIExpression): number => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
  return toLambda(exp)((x: number) => x + 1)(0);
};

export const ChurchB = (b: boolean): SKIExpression => b ? True : False;

/**
 * This is a somewhat foul construction in TypeScript, which gives insight into
 * the nature of the untyped lambda calculus.
 *
 * @param exp an expression in the SKI combinator language.
 * @returns a Curried TypeScript lambda which is extensionally equivalent to it
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toLambda = (exp: SKIExpression): any => {
  if (exp.kind === 'non-terminal') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return toLambda(exp.lft)(toLambda(exp.rgt));
  } else {
    switch (exp.sym) {
      case SKITerminalSymbol.S:
        return (x: (_: unknown) => { (_: unknown): unknown; _: unknown }) =>
          (y: (_: unknown) => unknown) =>
            (z: unknown) =>
              x(z)(y(z));

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      case SKITerminalSymbol.K: return (x: unknown) => (_y: unknown) => x;
      case SKITerminalSymbol.I: return (x: unknown) => x;
    }
  }
};
