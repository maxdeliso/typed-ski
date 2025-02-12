import { AVLTree, createEmptyAVL, insertAVL, searchAVL, keyValuePairs } from '../avl/avlNode.js';

/**
 * A generic set implemented on top of an AVL tree.
 *
 * The set is parameterized by the type T and stores unique values of type T.
 * The caller must supply a comparator function for T.
 */
export interface Set<T> {
  readonly tree: AVLTree<T, T>;
  readonly compare: (a: T, b: T) => number;
}

/**
 * Creates an empty AVLSet given a comparator function.
 *
 * @param compare A comparator for values of type T.
 * @returns An empty AVLSet.
 */
export function createSet<T>(compare: (a: T, b: T) => number): Set<T> {
  const tree = createEmptyAVL<T, T>();
  return { tree, compare };
}

/**
 * Inserts a value into the set.
 * Returns a new set instance that contains the given value.
 * If the value is already present, the original set is effectively returned.
 *
 * @param set The original set.
 * @param value The value to insert.
 * @returns A new AVLSet containing the value.
 */
export function insertSet<T>(set: Set<T>, value: T): Set<T> {
  return { ...set, tree: insertAVL(set.tree, value, value, set.compare) };
}

/**
 * Checks whether the set contains a given value.
 *
 * @param set The set to query.
 * @param value The value to look up.
 * @returns true if the value is present, false otherwise.
 */
export function memberSet<T>(set: Set<T>, value: T): boolean {
  return searchAVL(set.tree, value, set.compare) !== undefined;
}

/**
 * Returns an array of all elements in the set in ascending order.
 *
 * @param set The set to convert.
 * @returns An array of set elements.
 */
export function setToArray<T>(set: Set<T>): T[] {
  return keyValuePairs(set.tree).map(([, value]) => value);
}
