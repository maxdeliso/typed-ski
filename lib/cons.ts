/**
 * This module provides utilities for working with cons cells and binary tree structures.
 * It exports the ConsCell interface and cons function for creating non-terminal nodes.
 *
 * @example
 * ```ts
 * import { cons, type ConsCell, S, K, I, prettyPrintSKIExpression, type SKIExpression } from "jsr:@maxdeliso/typed-ski";
 *
 * const tree: SKIExpression = cons(I, cons(S, K));
 * console.log(prettyPrintSKIExpression(tree)); // "(I(SK))"
 * ```
 *
 * @module
 */

export interface ConsCell<E> {
  kind: "non-terminal";
  lft: E;
  rgt: E;
}

/**
 * @param lft the left subtree.
 * @param rgt the right subtree.
 * @returns a new non-terminal node, with E as the type of each branch.
 */
export const cons = <E>(lft: E, rgt: E): ConsCell<E> => ({
  kind: "non-terminal",
  lft,
  rgt,
});
