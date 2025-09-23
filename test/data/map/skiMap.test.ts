import { assert } from "chai";

import {
  createMap,
  insertMap,
  searchMap,
} from "../../../lib/data/map/skiMap.ts";
import type { SKIChar } from "../../../lib/ski/expression.ts";
import { I, K, S } from "../../../lib/ski/terminal.ts";

Deno.test("SKIAVL", async (t) => {
  await t.step("basic operations", async (t) => {
    await t.step("returns undefined for non-existent key", () => {
      const tree = createMap();
      const key: SKIChar[] = ["S", "K", "I"];
      const value = searchMap(tree, key);
      assert.isUndefined(value, "Expected no value for non-existent key");
    });

    await t.step("stores and retrieves value for empty key", () => {
      let tree = createMap();
      const emptyKey: SKIChar[] = [];
      // Store the SKI expression `I` at the empty key
      tree = insertMap(tree, emptyKey, I);

      const retrieved = searchMap(tree, emptyKey);
      assert.deepEqual(
        retrieved,
        I,
        "Should retrieve the same SKI expression I",
      );
    });

    await t.step("stores and retrieves value for simple key", () => {
      let tree = createMap();
      const key: SKIChar[] = ["S"];
      // Store the SKI expression `K` at key ['S']
      tree = insertMap(tree, key, K);

      const retrieved = searchMap(tree, key);
      assert.deepEqual(retrieved, K, "Should retrieve the SKI expression K");
    });

    await t.step(
      "handles multiple distinct keys with different first characters",
      () => {
        let tree = createMap();
        const keyA: SKIChar[] = ["S"];
        const keyB: SKIChar[] = ["K"];

        tree = insertMap(tree, keyA, S);
        tree = insertMap(tree, keyB, K);

        const valA = searchMap(tree, keyA);
        const valB = searchMap(tree, keyB);

        assert.deepEqual(valA, S, "Retrieved S for keyA");
        assert.deepEqual(valB, K, "Retrieved K for keyB");
      },
    );
  });

  await t.step("key relationships", async (t) => {
    await t.step("handles overlapping keys correctly", () => {
      let tree = createMap();
      const key1: SKIChar[] = ["S", "K"];
      const key2: SKIChar[] = ["S", "K", "I"];

      // Store `S` at ['S','K']
      tree = insertMap(tree, key1, S);
      // Then store `K` at ['S','K','I']
      tree = insertMap(tree, key2, K);

      const value1 = searchMap(tree, key1);
      const value2 = searchMap(tree, key2);
      assert.deepEqual(value1, S, "Expected S for key1");
      assert.deepEqual(value2, K, "Expected K for key2");
    });

    await t.step("handles keys sharing common prefix", () => {
      let tree = createMap();
      // Two keys that share ['S','K'] then diverge
      const key1: SKIChar[] = ["S", "K", "I"];
      const key2: SKIChar[] = ["S", "K", "("];

      tree = insertMap(tree, key1, S);
      tree = insertMap(tree, key2, K);

      const value1 = searchMap(tree, key1);
      const value2 = searchMap(tree, key2);
      assert.deepEqual(value1, S, "Key1's value is S");
      assert.deepEqual(value2, K, "Key2's value is K");
    });

    await t.step(
      "returns undefined when searching for prefix of existing key",
      () => {
        let tree = createMap();
        // The key is ['S','K','I']
        tree = insertMap(tree, ["S", "K", "I"], I);

        // Searching for just ['S','K'] => undefined
        const valShort = searchMap(tree, ["S", "K"]);
        assert.isUndefined(
          valShort,
          "Shorter prefix is not stored => undefined",
        );
      },
    );
  });

  await t.step("immutability and updates", async (t) => {
    await t.step("updates existing key immutably", () => {
      let tree1 = createMap();
      const key: SKIChar[] = ["(", "I", ")"];

      // Insert S at key
      tree1 = insertMap(tree1, key, S);
      // Create a second tree by inserting K at the same key
      const tree2 = insertMap(tree1, key, K);

      // The first tree should still have S
      const val1 = searchMap(tree1, key);
      // The second tree should have K
      const val2 = searchMap(tree2, key);

      assert.deepEqual(val1, S, "Original tree unchanged, still stores S");
      assert.deepEqual(val2, K, "New tree has updated value K");
    });

    await t.step("overwrites previously inserted value for same key", () => {
      let tree = createMap();
      const key: SKIChar[] = ["K", "I"];

      // First insertion
      tree = insertMap(tree, key, S);
      const val1 = searchMap(tree, key);
      assert.deepEqual(val1, S, "Should store S initially");

      // Insert again with a different value
      tree = insertMap(tree, key, I);
      const val2 = searchMap(tree, key);
      assert.deepEqual(val2, I, "Should overwrite with new value I");
    });
  });

  await t.step("edge cases", async (t) => {
    await t.step("handles large complex keys", () => {
      let tree = createMap();
      const bigKey: SKIChar[] = ["S", "K", "I", "(", "(", "I", ")", ")", "S"];
      // Store `K` for demonstration
      tree = insertMap(tree, bigKey, K);

      // Retrieve
      const retrieved = searchMap(tree, bigKey);
      assert.deepEqual(retrieved, K, "Larger key retrieval works");
    });
  });
});
