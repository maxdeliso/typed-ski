import { ConsCell, cons } from '../cons.js';
import { SKITerminal } from './terminal.js';

/*
 * EBNF grammar:
 *
 * terminal = "S" | "K" | "I"
 * non-terminal = "(", expression, expression, ")"
 * expression = terminal | non-terminal
 *
 * alphabet:
 *
 * "S" | "K" | "I" | "(" | ")"
 *
 * non-terminals:
 *
 * terminal | non-terminal | expression
 */
export type SKIExpression = SKITerminal | ConsCell<SKIExpression>;
export type SKIChar = 'S' | 'K' | 'I' | '(' | ')';
export type SKIKey = SKIChar[];

/**
 * Maps an SKI character to its corresponding index:
 *   "S" -> 0
 *   "K" -> 1
 *   "I" -> 2
 *   "(" -> 3
 *   ")" -> 4
 */
export function charToIndex(ch: SKIChar): 0 | 1 | 2 | 3 | 4 {
  switch (ch) {
    case 'S': return 0;
    case 'K': return 1;
    case 'I': return 2;
    case '(' : return 3;
    case ')' : return 4;
  }
}

/**
 * Converts a SKI expression to its canonical key,
 * represented as an array of SKIChar.
 *
 * This function mimics the original pretty-printing algorithm,
 * but builds an SKIKey instead.
 */
export function toSKIKey(expr: SKIExpression): SKIKey {
  const key: SKIKey = [];
  // The stack can hold either expressions or literal SKIChar values.
  const stack: (SKIExpression | SKIChar)[] = [expr];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      throw new Error('stack underflow');
    }

    if (typeof item === 'string') {
      // If the item is a literal SKIChar, append it to the key.
      key.push(item);
    } else if (item.kind === 'terminal') {
      // For terminal nodes, simply push the symbol.
      key.push(item.sym);
    } else {
      // For non-terminal nodes, we want to output:
      // "(" + [key for left subtree] + [key for right subtree] + ")"
      // Push the components in reverse order (LIFO) so that '(' comes first.
      stack.push(')');         // Will be appended last.
      stack.push(item.rgt);      // Right subtree.
      stack.push(item.lft);      // Left subtree.
      stack.push('(');           // Will be appended first.
    }
  }

  return key;
}

/**
 * Returns the string representation of a SKI expression.
 *
 * This function calls toSKIKey to produce the key and then joins
 * the key array into a string.
 */
export function prettyPrint(expr: SKIExpression): string {
  return toSKIKey(expr).join('');
}


/**
  * @param exp an abstract expression.
  * @returns how many terminals are present in the expression.
  */
export function size(exp: SKIExpression): number {
  if (exp.kind === 'terminal') return 1;
  else return size(exp.lft) + size(exp.rgt);
}

/**
 * Apply a function to its arguments.
 * @param exps an array of expressions.
 * @returns an unevaluated result.
 */
export const apply = (...exps: SKIExpression[]): SKIExpression => {
  if (exps.length <= 0) {
    throw new Error('there must be at least one expression to apply');
  } else {
    return exps.reduce(cons<SKIExpression>);
  }
};
