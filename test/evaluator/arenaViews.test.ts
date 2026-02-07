import { expect } from "chai";
import {
  type ArenaViews,
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
  validateAndRebuildViews,
} from "../../lib/evaluator/arenaViews.ts";

Deno.test("arenaViews - coverage", async (t) => {
  await t.step("getOrBuildArenaViews handles missing memory", () => {
    expect(getOrBuildArenaViews(undefined, {})).to.be.null;
  });

  await t.step(
    "validateAndRebuildViews handles missing views or memory",
    () => {
      expect(validateAndRebuildViews(null, undefined, {})).to.be.null;
      const dummyViews = { capacity: 10 } as unknown as ArenaViews;
      expect(validateAndRebuildViews(dummyViews, undefined, {})).to.equal(
        dummyViews,
      );
    },
  );

  await t.step("validateAndRebuildViews handles missing baseAddr", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const dummyViews = { capacity: 10 } as unknown as ArenaViews;
    expect(validateAndRebuildViews(dummyViews, memory, {})).to.be.null;
  });

  await t.step("getOrBuildArenaViews handles missing baseAddr", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(getOrBuildArenaViews(memory, {})).to.be.null;
  });

  await t.step("getOrBuildArenaViews handles baseAddr 0", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(getOrBuildArenaViews(memory, { debugGetArenaBaseAddr: () => 0 })).to
      .be.null;
  });

  await t.step("getKind/getLeft/getRight handles out of bounds", () => {
    const views = {
      capacity: 5,
      kind: new Uint8Array([1, 1, 1, 1, 1]),
      leftId: new Uint32Array([0, 0, 0, 0, 0]),
      rightId: new Uint32Array([0, 0, 0, 0, 0]),
      sym: new Uint8Array([0, 0, 0, 0, 0]),
    };

    expect(getKind(10, views)).to.equal(-1);
    expect(getLeft(10, views)).to.equal(-1);
    expect(getRight(10, views)).to.equal(-1);

    expect(getKind(0, views)).to.equal(1);
    expect(getLeft(0, views)).to.equal(0);
    expect(getRight(0, views)).to.equal(0);
  });
});
