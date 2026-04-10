import { describe, it } from "./test_shim.ts";
import assert from "node:assert/strict";
import { required, requiredAt } from "./required.ts";

describe("test util - required", () => {
  it("required returns value if present", () => {
    assert.strictEqual(required(1, "err"), 1);
    assert.strictEqual(required("a", "err"), "a");
    assert.strictEqual(required(false, "err"), false);
  });

  it("required throws if null or undefined", () => {
    assert.throws(() => required(null, "is null"), /is null/);
    assert.throws(() => required(undefined, "is undefined"), /is undefined/);
  });

  it("requiredAt returns value at index", () => {
    const arr = [10, 20];
    assert.strictEqual(requiredAt(arr, 0, "err"), 10);
    assert.strictEqual(requiredAt(arr, 1, "err"), 20);
  });

  it("requiredAt throws if index out of bounds or undefined", () => {
    const arr = [10];
    assert.throws(() => requiredAt(arr, 1, "out of bounds"), /out of bounds/);
    assert.throws(() => requiredAt([], 0, "empty"), /empty/);
  });
});
