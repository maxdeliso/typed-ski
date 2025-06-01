import {
  type AVLTree,
  createEmptyAVL,
  insertAVL,
  searchAVL,
} from "../avl/avlNode.ts";

import type { SKIExpression, SKIKey } from "../../ski/expression.ts";

function compareSKIKeys(a: SKIKey, b: SKIKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export type SKIMap = AVLTree<SKIKey, SKIExpression>;

export function createMap(): SKIMap {
  return createEmptyAVL<SKIKey, SKIExpression>();
}

export function insertMap(
  tree: SKIMap,
  key: SKIKey,
  value: SKIExpression,
): SKIMap {
  return insertAVL(
    tree,
    key,
    value,
    compareSKIKeys,
  );
}

export function searchMap(
  tree: SKIMap,
  key: SKIKey,
): SKIExpression | undefined {
  return searchAVL(
    tree,
    key,
    compareSKIKeys,
  );
}
