import { charToIndex, SKIExpression, SKIKey } from '../ski/expression.js';
import { SKITrieNode } from './skiTrieNode.js';

/**
 * A simple immutable SKI trie.
 */
export interface SKITrie {
  root: SKITrieNode<SKIExpression>;
}

/**
 * Creates a new SKI trie.
 * If no root is provided, a root node with an empty prefix is created.
 */
export function createSKITrie(root?: SKITrieNode<SKIExpression>): SKITrie {
  return { root: root ?? makeTrieNode<SKIExpression>([]) };
}

/**
 * Helper to create a new trie node.
 * If no children array is provided, one with 5 slots is created.
 */
export function makeTrieNode<T>(
  prefix: SKIKey,
  value?: T,
  children?: (SKITrieNode<T> | undefined)[]
): SKITrieNode<T> {
  return {
    prefix,
    value,
    children: children ? children.slice() : new Array<SKITrieNode<T> | undefined>(5).fill(undefined)
  };
}

/**
 * Returns a shallow copy of a node.
 */
function copyNode<T>(node: SKITrieNode<T>): SKITrieNode<T> {
  return makeTrieNode(node.prefix.slice(), node.value, node.children);
}

/**
 * Looks up the value associated with the given key.
 *
 * The key is an array of SKIChar.
 */
export function getSKITrie(trie: SKITrie, key: SKIKey): SKIExpression | undefined {
  let node = trie.root;
  // For each character in the key, descend one level.
  for (const char of key) {
    const idx = charToIndex(char);
    const child = node.children[idx];
    if (!child) {
      return undefined;
    }
    node = child;
  }
  return node.value;
}

/**
 * Returns a new trie that maps the given key to the given value.
 * Makes use of structural sharing to avoid duplicating nodes.
 */
export function setSKITrie(trie: SKITrie, key: SKIKey, value: SKIExpression): SKITrie {
  // Special-case: an empty key updates the root.
  if (key.length === 0) {
    const newRoot = copyNode(trie.root);
    newRoot.value = value;
    return createSKITrie(newRoot);
  }

  // Start by copying the root.
  const newRoot = copyNode(trie.root);
  let current = newRoot;
  // For each character in the key, descend into the appropriate child.
  for (const char of key) {
    const idx = charToIndex(char);
    let child = current.children[idx];
    if (child) {
      // Copy the child so as not to mutate the original structure.
      child = copyNode(child);
    } else {
      // Create a new node for this character.
      // (For non-root nodes the prefix is the one character of the key.)
      child = makeTrieNode<SKIExpression>([char]);
    }
    // Replace the corresponding child pointer.
    const newChildren = current.children.slice();
    newChildren[idx] = child;
    current.children = newChildren;
    // Move down the trie.
    current = child;
  }

  // At the end of the key, set the value.
  current.value = value;
  return createSKITrie(newRoot);
}
