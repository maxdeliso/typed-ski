import { assert } from 'chai';
import { SKIKey } from '../../lib/ski/expression.js';
import { createSKITrie, getSKITrie, setSKITrie } from '../../lib/data/skiTrie.js';
import { S, K, I } from '../../lib/ski/terminal.js';

describe('SKITrie', () => {
  it('should return undefined for a non-existent key', () => {
    const trie = createSKITrie();
    const key: SKIKey = ['S', 'K', 'I'];
    const value = getSKITrie(trie, key);
    assert.isUndefined(value);
  });

  it('should store and retrieve a value for an empty key', () => {
    let trie = createSKITrie();
    // Use a terminal expression from our library as the stored value.
    trie = setSKITrie(trie, [], I);
    const value = getSKITrie(trie, []);
    assert.deepEqual(value, I);
  });

  it('should store and retrieve a value for a simple key', () => {
    let trie = createSKITrie();
    const key: SKIKey = ['S'];
    // For example, store a K terminal.
    trie = setSKITrie(trie, key, K);
    const value = getSKITrie(trie, key);
    assert.deepEqual(value, K);
  });

  it('should handle overlapping keys correctly', () => {
    let trie = createSKITrie();
    const key1: SKIKey = ['S', 'K'];
    const key2: SKIKey = ['S', 'K', 'I'];

    // Set value for the shorter key (e.g. S).
    trie = setSKITrie(trie, key1, S);
    // Then set a value for the longer, overlapping key (e.g. K).
    trie = setSKITrie(trie, key2, K);

    const value1 = getSKITrie(trie, key1);
    const value2 = getSKITrie(trie, key2);
    assert.deepEqual(value1, S);
    assert.deepEqual(value2, K);
  });

  it('should update an existing key immutably', () => {
    let trie1 = createSKITrie();
    const key: SKIKey = ['(', 'I', ')'];

    // Create an initial trie with the key storing S.
    trie1 = setSKITrie(trie1, key, S);
    // Update the trie with a new value (K).
    const trie2 = setSKITrie(trie1, key, K);

    // The original trie remains unchanged.
    const value1 = getSKITrie(trie1, key);
    const value2 = getSKITrie(trie2, key);
    assert.deepEqual(value1, S);
    assert.deepEqual(value2, K);
  });

  it('should correctly update keys that share a common prefix', () => {
    let trie = createSKITrie();
    // Use two keys that share a common prefix, then diverge.
    const key1: SKIKey = ['S', 'K', 'I'];
    const key2: SKIKey = ['S', 'K', '('];

    trie = setSKITrie(trie, key1, S);
    trie = setSKITrie(trie, key2, K);

    const value1 = getSKITrie(trie, key1);
    const value2 = getSKITrie(trie, key2);
    assert.deepEqual(value1, S);
    assert.deepEqual(value2, K);
  });
});
