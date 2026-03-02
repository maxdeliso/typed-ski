import { expect } from "chai";
import {
  type ArenaViews,
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
  getSym,
  validateAndRebuildViews,
} from "../../lib/evaluator/arenaViews.ts";
import { SabHeaderField } from "../../lib/evaluator/arenaHeader.generated.ts";

/** AoS node stride (must match arenaViews / C ArenaNode). */
const NODE_STRIDE = 32;
const NODE_OFFSET_LEFT = 0;
const NODE_OFFSET_RIGHT = 4;
const NODE_OFFSET_KIND = 16;
const NODE_OFFSET_SYM = 17;

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

  await t.step("getKind/getLeft/getRight/getSym with AoS layout", () => {
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
      u8[i * NODE_STRIDE + NODE_OFFSET_SYM] = (i % 3) + 1; // S=1,K=2,I=3
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
    expect(getSym(10, views)).to.equal(-1);

    expect(getKind(0, views)).to.equal(1);
    expect(getLeft(0, views)).to.equal(0);
    expect(getRight(0, views)).to.equal(0);
    expect(getSym(0, views)).to.equal(1);
    expect(getSym(1, views)).to.equal(2);
    expect(getSym(2, views)).to.equal(3);
  });

  await t.step("validateAndRebuildViews rebuilds when capacity changed", () => {
    const headerSize = 18 * 4;
    const baseAddr = 64;
    const buf = new ArrayBuffer(headerSize + 256);
    const headerView = new Uint32Array(buf, baseAddr, 18);
    headerView[SabHeaderField.CAPACITY] = 5;
    headerView[SabHeaderField.OFFSET_NODES] = 0;
    headerView[SabHeaderField.OFFSET_NODES + 1] = 0;
    const memory = { buffer: buf } as WebAssembly.Memory;
    const provider = { debugGetArenaBaseAddr: () => baseAddr };

    const views1 = getOrBuildArenaViews(memory, provider);
    expect(views1).not.to.be.null;
    expect(views1!.capacity).to.equal(5);

    headerView[SabHeaderField.CAPACITY] = 10;
    const validated = validateAndRebuildViews(views1, memory, provider);
    expect(validated).not.to.be.null;
    expect(validated!.capacity).to.equal(10);
  });

  await t.step(
    "getOrBuildArenaViews returns fresh views when cache stale",
    () => {
      const headerSize = 18 * 4;
      const baseAddr = 64;
      const buf = new ArrayBuffer(headerSize + 256);
      const headerView = new Uint32Array(buf, baseAddr, 18);
      headerView[SabHeaderField.CAPACITY] = 4;
      headerView[SabHeaderField.OFFSET_NODES] = 0;
      headerView[SabHeaderField.OFFSET_NODES + 1] = 0;
      const memory = { buffer: buf } as WebAssembly.Memory;
      const provider = { debugGetArenaBaseAddr: () => baseAddr };

      const views1 = getOrBuildArenaViews(memory, provider);
      expect(views1!.capacity).to.equal(4);
      headerView[SabHeaderField.CAPACITY] = 8;
      const views2 = getOrBuildArenaViews(memory, provider);
      expect(views2!.capacity).to.equal(8);
    },
  );
});
