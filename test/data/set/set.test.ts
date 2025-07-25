import { expect } from "npm:chai";

import {
  createSet,
  insertSet,
  memberSet,
  setToArray,
} from "../../../lib/data/set/set.ts";

Deno.test("Set", async (t) => {
  // Basic set comparison function for numbers
  const compareNumbers = (a: number, b: number) => a - b;

  await t.step("basic operations", async (t) => {
    await t.step("creates an empty set", () => {
      const set = createSet(compareNumbers);
      expect(set).to.have.property("tree");
      expect(set).to.have.property("compare");
      const array = setToArray(set);
      expect(array).to.be.an("array");
      expect(array.length).to.equal(0);
    });

    await t.step("inserts elements and checks membership", () => {
      let set = createSet(compareNumbers);
      expect(memberSet(set, 1)).to.equal(false);

      // Insert some elements
      set = insertSet(set, 1);
      set = insertSet(set, 2);
      set = insertSet(set, 3);

      // Check membership
      expect(memberSet(set, 1)).to.equal(true);
      expect(memberSet(set, 2)).to.equal(true);
      expect(memberSet(set, 3)).to.equal(true);
      expect(memberSet(set, 4)).to.equal(false);
    });
  });

  await t.step("set operations", async (t) => {
    await t.step("converts set to a sorted array", () => {
      let set = createSet(compareNumbers);

      // Insert elements in random order
      set = insertSet(set, 3);
      set = insertSet(set, 1);
      set = insertSet(set, 2);

      // Array should be sorted by the comparator
      expect(setToArray(set)).to.deep.equal([1, 2, 3]);
    });

    await t.step("handles duplicate elements", () => {
      let set = createSet(compareNumbers);

      set = insertSet(set, 1);
      set = insertSet(set, 1); // Duplicate

      expect(setToArray(set)).to.deep.equal([1]);
      expect(setToArray(set).length).to.equal(1);
    });
  });

  await t.step("custom types", async (t) => {
    await t.step("works with custom objects and comparator", () => {
      interface Person {
        id: number;
        name: string;
      }
      const comparePeopleById = (a: Person, b: Person) => a.id - b.id;

      let set = createSet<Person>(comparePeopleById);

      const alice = { id: 1, name: "Alice" };
      const bob = { id: 2, name: "Bob" };
      const charlie = { id: 3, name: "Charlie" };

      set = insertSet(set, alice);
      set = insertSet(set, bob);
      set = insertSet(set, charlie);

      expect(memberSet(set, alice)).to.equal(true);
      expect(memberSet(set, { id: 1, name: "Alice" })).to.equal(true);
      expect(memberSet(set, { id: 4, name: "Dave" })).to.equal(false);

      expect(setToArray(set)).to.deep.equal([alice, bob, charlie]);
    });
  });
});
