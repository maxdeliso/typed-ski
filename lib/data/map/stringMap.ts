/**
 * String map implementation using AVL trees.
 *
 * This module provides a string-to-string map implementation using
 * AVL trees with string comparison for efficient lookups.
 *
 * @module
 */
import { createEmptyAVL, insertAVL, searchAVL } from "../avl/avlNode.ts";

import type { AVLTree } from "../avl/avlNode.ts";

export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Create an empty string->string AVL tree. */
export function createStringMap(): AVLTree<string, string> {
  return createEmptyAVL<string, string>();
}

/** Immutable insert into string->string map. */
export function insertStringMap(
  tree: AVLTree<string, string>,
  key: string,
  value: string,
): AVLTree<string, string> {
  return insertAVL(tree, key, value, compareStrings);
}

/** Immutable search for string->string map. */
export function searchStringMap(
  tree: AVLTree<string, string>,
  key: string,
): string | undefined {
  return searchAVL(tree, key, compareStrings);
}
