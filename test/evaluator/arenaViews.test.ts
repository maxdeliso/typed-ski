import assert from "node:assert/strict";
import {
  type ArenaViews,
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
  getSym,
  validateAndRebuildViews,
} from "../../lib/evaluator/arenaViews.ts";
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "../../lib/evaluator/arenaHeader.generated.ts";

import { describe, it } from "../util/test_shim.ts";

describe("arenaViews - coverage", () => {
  it("getOrBuildArenaViews handles missing memory", () => {
    assert.strictEqual(getOrBuildArenaViews(undefined, {}), null);
  });

  it("validateAndRebuildViews handles missing views or memory", () => {
    assert.strictEqual(validateAndRebuildViews(null, undefined, {}), null);
    const dummyViews = {
      buffer: new ArrayBuffer(0),
      baseAddr: 0,
      capacity: 10,
      offsetNodeLeft: 0,
      offsetNodeRight: 0,
      offsetNodeHash32: 0,
      offsetNodeNextIdx: 0,
      offsetNodeKind: 0,
      offsetNodeSym: 0,
      kindView: new Uint8Array(10),
      symView: new Uint8Array(10),
      leftView: new Uint32Array(10),
      rightView: new Uint32Array(10),
    } satisfies ArenaViews;
    assert.strictEqual(
      validateAndRebuildViews(dummyViews, undefined, {}),
      dummyViews,
    );
  });

  it("validateAndRebuildViews handles missing baseAddr", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const dummyViews = {
      buffer: new ArrayBuffer(0),
      baseAddr: 0,
      capacity: 10,
      offsetNodeLeft: 0,
      offsetNodeRight: 0,
      offsetNodeHash32: 0,
      offsetNodeNextIdx: 0,
      offsetNodeKind: 0,
      offsetNodeSym: 0,
      kindView: new Uint8Array(10),
      symView: new Uint8Array(10),
      leftView: new Uint32Array(10),
      rightView: new Uint32Array(10),
    } satisfies ArenaViews;
    assert.strictEqual(
      validateAndRebuildViews(dummyViews, memory, {}),
      dummyViews,
    );
  });

  it("getOrBuildArenaViews handles missing baseAddr", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    assert.strictEqual(getOrBuildArenaViews(memory, {}), null);
  });

  it("getOrBuildArenaViews handles baseAddr 0", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    assert.strictEqual(
      getOrBuildArenaViews(memory, { debugGetArenaBaseAddr: () => 0 }),
      null,
    );
  });

  it("getKind/getLeft/getRight/getSym with SoA layout", () => {
    const capacity = 5;
    // Layout: Left (cap*4), Right (cap*4), Kind (cap*1), Sym (cap*1)
    const offsetLeft = 0;
    const offsetRight = capacity * 4;
    const offsetKind = offsetRight + capacity * 4;
    const offsetSym = offsetKind + capacity;

    const buf = new ArrayBuffer((offsetSym + capacity + 3) & ~3);
    const u32 = new Uint32Array(buf);
    const u8 = new Uint8Array(buf);

    for (let i = 0; i < capacity; i++) {
      u32[(offsetLeft + i * 4) >>> 2] = i + 100;
      u32[(offsetRight + i * 4) >>> 2] = i + 200;
      u8[offsetKind + i] = 1;
      u8[offsetSym + i] = (i % 3) + 1; // S=1,K=2,I=3
    }

    const views: ArenaViews = {
      buffer: buf,
      baseAddr: 0,
      capacity,
      offsetNodeLeft: offsetLeft,
      offsetNodeRight: offsetRight,
      offsetNodeHash32: 0,
      offsetNodeNextIdx: 0,
      offsetNodeKind: offsetKind,
      offsetNodeSym: offsetSym,
      kindView: new Uint8Array(buf, offsetKind, capacity),
      symView: new Uint8Array(buf, offsetSym, capacity),
      leftView: new Uint32Array(buf, offsetLeft, capacity),
      rightView: new Uint32Array(buf, offsetRight, capacity),
    };

    assert.strictEqual(getKind(10, views), -1);
    assert.strictEqual(getLeft(10, views), -1);
    assert.strictEqual(getRight(10, views), -1);
    assert.strictEqual(getSym(10, views), -1);

    assert.strictEqual(getKind(0, views), 1);
    assert.strictEqual(getLeft(0, views), 100);
    assert.strictEqual(getRight(0, views), 200);
    assert.strictEqual(getSym(0, views), 1);
    assert.strictEqual(getSym(1, views), 2);
    assert.strictEqual(getSym(2, views), 3);
  });

  it("validateAndRebuildViews rebuilds when capacity changed", () => {
    const headerSize = SABHEADER_HEADER_SIZE_U32 * 4;
    const baseAddr = 64;
    const buf = new ArrayBuffer(baseAddr + headerSize + 256);
    const headerView = new Uint32Array(
      buf,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
    headerView[SabHeaderField.CAPACITY] = 5;
    // Set all offsets to 0 for simplicity in this test
    headerView[SabHeaderField.OFFSET_NODE_LEFT] = 0;
    headerView[SabHeaderField.OFFSET_NODE_RIGHT] = 0;
    headerView[SabHeaderField.OFFSET_NODE_HASH32] = 0;
    headerView[SabHeaderField.OFFSET_NODE_NEXT_IDX] = 0;
    headerView[SabHeaderField.OFFSET_NODE_KIND] = 0;
    headerView[SabHeaderField.OFFSET_NODE_SYM] = 0;

    const memory = { buffer: buf } as WebAssembly.Memory;
    const provider = { debugGetArenaBaseAddr: () => baseAddr };

    const views1 = getOrBuildArenaViews(memory, provider);
    assert.notStrictEqual(views1, null);
    assert.strictEqual(views1!.capacity, 5);

    headerView[SabHeaderField.CAPACITY] = 10;
    const validated = validateAndRebuildViews(views1, memory, provider);
    assert.notStrictEqual(validated, null);
    assert.strictEqual(validated!.capacity, 10);
  });

  it("getOrBuildArenaViews returns fresh views when cache stale", () => {
    const headerSize = SABHEADER_HEADER_SIZE_U32 * 4;
    const baseAddr = 64;
    const buf = new ArrayBuffer(baseAddr + headerSize + 256);
    const headerView = new Uint32Array(
      buf,
      baseAddr,
      SABHEADER_HEADER_SIZE_U32,
    );
    headerView[SabHeaderField.CAPACITY] = 4;
    headerView[SabHeaderField.OFFSET_NODE_LEFT] = 0;
    headerView[SabHeaderField.OFFSET_NODE_RIGHT] = 0;
    headerView[SabHeaderField.OFFSET_NODE_HASH32] = 0;
    headerView[SabHeaderField.OFFSET_NODE_NEXT_IDX] = 0;
    headerView[SabHeaderField.OFFSET_NODE_KIND] = 0;
    headerView[SabHeaderField.OFFSET_NODE_SYM] = 0;

    const memory = { buffer: buf } as WebAssembly.Memory;
    const provider = { debugGetArenaBaseAddr: () => baseAddr };

    const views1 = getOrBuildArenaViews(memory, provider);
    assert.strictEqual(views1!.capacity, 4);
    headerView[SabHeaderField.CAPACITY] = 8;
    const views2 = getOrBuildArenaViews(memory, provider);
    assert.strictEqual(views2!.capacity, 8);
  });
});
