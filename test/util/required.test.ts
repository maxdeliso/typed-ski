import { test } from "node:test";
import { expect } from "./assertions.ts";
import { required, requiredAt } from "./required.ts";

test("test util - required", async (t) => {
  await t.test("required returns value if present", () => {
    expect(required(1, "err")).to.equal(1);
    expect(required("a", "err")).to.equal("a");
    expect(required(false, "err")).to.equal(false);
  });

  await t.test("required throws if null or undefined", () => {
    expect(() => required(null, "is null")).to.throw("is null");
    expect(() => required(undefined, "is undefined")).to.throw("is undefined");
  });

  await t.test("requiredAt returns value at index", () => {
    const arr = [10, 20];
    expect(requiredAt(arr, 0, "err")).to.equal(10);
    expect(requiredAt(arr, 1, "err")).to.equal(20);
  });

  await t.test("requiredAt throws if index out of bounds or undefined", () => {
    const arr = [10];
    expect(() => requiredAt(arr, 1, "out of bounds")).to.throw("out of bounds");
    expect(() => requiredAt([], 0, "empty")).to.throw("empty");
  });
});
