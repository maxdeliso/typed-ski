import { expect } from "chai";
import {
  type ArenaViews,
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
  validateAndRebuildViews,
} from "../../lib/evaluator/arenaViews.ts";

/** AoS node stride (must match arenaViews / C ArenaNode). */
const NODE_STRIDE = 32;
const NODE_OFFSET_LEFT = 0;
const NODE_OFFSET_RIGHT = 4;
const NODE_OFFSET_KIND = 16;

Deno.test("arenaViews - coverage", async (t) => {
  await t.step("getOrBuildArenaViews handles missing memory", () => {
    expect(getOrBuildArenaViews(undefined, {})).to.be.null;
  });

  await t.step(
    "validateAndRebuildViews handles missing views or memory",
    () => {
      expect(validateAndRebuildViews(null, undefined, {})).to.be.null;
      const dummyViews = {
        buffer: new ArrayBuffer(0),
        baseAddr: 0,
        offsetNodes: 0,
        capacity: 10,
      } satisfies ArenaViews;
      expect(validateAndRebuildViews(dummyViews, undefined, {})).to.equal(
        dummyViews,
      );
    },
  );

  await t.step("validateAndRebuildViews handles missing baseAddr", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const dummyViews = {
      buffer: new ArrayBuffer(0),
      baseAddr: 0,
      offsetNodes: 0,
      capacity: 10,
    } satisfies ArenaViews;
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

  await t.step("getKind/getLeft/getRight with AoS layout", () => {
    // Minimal buffer: 5 nodes at offset 0 (baseAddr=0, offsetNodes=0)
    const capacity = 5;
    const buf = new ArrayBuffer(capacity * NODE_STRIDE);
    const u32 = new Uint32Array(buf);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < capacity; i++) {
      const base = (i * NODE_STRIDE) >>> 2;
      u32[base + (NODE_OFFSET_LEFT >>> 2)] = 0;
      u32[base + (NODE_OFFSET_RIGHT >>> 2)] = 0;
      u8[i * NODE_STRIDE + NODE_OFFSET_KIND] = 1;
    }
    const views: ArenaViews = {
      buffer: buf,
      baseAddr: 0,
      offsetNodes: 0,
      capacity,
    };

    expect(getKind(10, views)).to.equal(-1);
    expect(getLeft(10, views)).to.equal(-1);
    expect(getRight(10, views)).to.equal(-1);

    expect(getKind(0, views)).to.equal(1);
    expect(getLeft(0, views)).to.equal(0);
    expect(getRight(0, views)).to.equal(0);
  });
});
