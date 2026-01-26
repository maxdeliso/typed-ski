/**
 * SKI expression representation and utilities.
 *
 * This module defines the AST types for SKI combinator expressions and provides
 * utilities for pretty-printing, equivalence checking, and manipulation of SKI terms.
 *
 * @module
 */
import type { SKITerminal } from "./terminal.ts";

/*
 * EBNF grammar:
 *
 * terminal = "S" | "K" | "I" | "," | "."
 * non-terminal = "(", expression, expression, ")"
 * expression = terminal | non-terminal
 *
 * alphabet:
 *
 * "S" | "K" | "I" | "," | "." | "(" | ")"
 *
 * non-terminals:
 *
 * terminal | non-terminal | expression
 */
/**
 * An SKI application node representing the application of one SKI expression to another.
 *
 * Applications are binary operations where the left expression is applied to the
 * right expression, forming the fundamental building block of functional composition
 * in the SKI combinator calculus.
 */
export interface SKIApplication {
  kind: "non-terminal";
  lft: SKIExpression;
  rgt: SKIExpression;
}

/**
 * An SKI expression is either a terminal symbol (S, K, I) or an application node.
 *
 * This recursive type represents all valid expressions in the SKI combinator calculus,
 * where every expression is either one of the three fundamental combinators or an
 * application of two expressions.
 */
export type SKIExpression = SKITerminal | SKIApplication;
export type SKIChar = "S" | "K" | "I" | "," | "." | "(" | ")";
export type SKIKey = SKIChar[];

/**
 * Converts a SKI expression to its canonical key,
 * represented as an array of SKIChar.
 *
 * This function mimics the original pretty-printing algorithm,
 * but builds an SKIKey instead.
 */
export const toSKIKey = (expr: SKIExpression): SKIKey => {
  const key: SKIKey = [];
  // The stack can hold either expressions or literal SKIChar values.
  const stack: (SKIExpression | SKIChar)[] = [expr];

  while (stack.length > 0) {
    const item = stack.pop();

    if (item === undefined) {
      throw new Error("stack underflow");
    } else if (typeof item === "string") {
      // If the item is a literal SKIChar, append it to the key.
      key.push(item);
    } else if (item.kind === "terminal") {
      // For terminal nodes, simply push the symbol.
      key.push(item.sym);
    } else {
      // For non-terminal nodes, we want to output:
      // "(" + [key for left subtree] + [key for right subtree] + ")"
      // Push the components in reverse order (LIFO) so that '(' comes first.
      stack.push(")"); // Will be appended last.
      stack.push(item.rgt); // Right subtree.
      stack.push(item.lft); // Left subtree.
      stack.push("("); // Will be appended first.
    }
  }

  return key;
};

/**
 * Compare two SKI expressions for structural equivalence.
 */
export const equivalent = (
  lft: SKIExpression,
  rgt: SKIExpression,
): boolean => {
  const firstStack = [lft];
  const secondStack = [rgt];

  while (firstStack.length > 0 && secondStack.length > 0) {
    const firstItem = firstStack.pop();
    const secondItem = secondStack.pop();

    if (firstItem === undefined || secondItem === undefined) {
      throw new Error("stack underflow");
    } else if (
      firstItem.kind === "terminal" && secondItem.kind === "terminal"
    ) {
      if (firstItem!.sym !== secondItem!.sym) {
        return false;
      }
    } else if (
      firstItem.kind === "non-terminal" && secondItem.kind === "non-terminal"
    ) {
      firstStack.push(firstItem.rgt);
      firstStack.push(firstItem.lft);
      secondStack.push(secondItem.rgt);
      secondStack.push(secondItem.lft);
    } else {
      return false;
    }
  }

  return firstStack.length === secondStack.length;
};

/**
 * Unparses a SKI expression into a string representation.
 *
 * This function calls toSKIKey to produce the key and then joins
 * the key array into a string.
 */
export const unparseSKI = (expr: SKIExpression): string => {
  return toSKIKey(expr).join("");
};

/**
 * @param exp an abstract expression.
 * @returns how many terminals are present in the expression.
 */
export const terminals = (exp: SKIExpression): number => {
  if (exp.kind === "terminal") return 1;
  else return terminals(exp.lft) + terminals(exp.rgt);
};

/**
 * Creates an application of one SKI expression to another.
 * @param left the function expression
 * @param right the argument expression
 * @returns a new application node
 */
export const apply = (
  left: SKIExpression,
  right: SKIExpression,
): SKIExpression => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});

/**
 * Apply multiple expressions in sequence (left-associative).
 * @param exps an array of expressions.
 * @returns an unevaluated result.
 */
export const applyMany = (...exps: SKIExpression[]): SKIExpression => {
  if (exps.length <= 0) {
    throw new Error("there must be at least one expression to apply");
  } else {
    return exps.reduce(apply);
  }
};
