import { SKIKey } from '../ski/expression.js';

/**
 * A plain record representing a node in the SKI trie.
 */
export interface SKITrieNode<T> {
  prefix: SKIKey;
  value?: T;
  children: (SKITrieNode<T> | undefined)[];
}

/**
 * Factory function to create a new SKI trie node.
 * If children are not provided, a new 5-slot array filled with undefined is created.
 */
export function makeTrieNode<T>(
  prefix: SKIKey,
  value?: T,
  children?: (SKITrieNode<T> | undefined)[]
): SKITrieNode<T> {
  return {
    prefix,
    value,
    children: children ?? new Array<SKITrieNode<T> | undefined>(5).fill(undefined)
  };
}
