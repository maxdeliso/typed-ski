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
import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "../../lib/evaluator/arenaHeader.generated.ts";

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
        capacity: 10,
        offsetNodeLeft: 0,
        offsetNodeRight: 0,
        offsetNodeHash32: 0,
        offsetNodeNextIdx: 0,
        offsetNodeKind: 0,
        offsetNodeSym: 0,
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
      capacity: 10,
      offsetNodeLeft: 0,
      offsetNodeRight: 0,
      offsetNodeHash32: 0,
      offsetNodeNextIdx: 0,
      offsetNodeKind: 0,
      offsetNodeSym: 0,
    } satisfies ArenaViews;
    expect(validateAndRebuildViews(dummyViews, memory, {})).to.equal(
      dummyViews,
    );
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

  await t.step("getKind/getLeft/getRight/getSym with SoA layout", () => {
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
    };

    expect(getKind(10, views)).to.equal(-1);
    expect(getLeft(10, views)).to.equal(-1);
    expect(getRight(10, views)).to.equal(-1);
    expect(getSym(10, views)).to.equal(-1);

    expect(getKind(0, views)).to.equal(1);
    expect(getLeft(0, views)).to.equal(100);
    expect(getRight(0, views)).to.equal(200);
    expect(getSym(0, views)).to.equal(1);
    expect(getSym(1, views)).to.equal(2);
    expect(getSym(2, views)).to.equal(3);
  });

  await t.step("validateAndRebuildViews rebuilds when capacity changed", () => {
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
      expect(views1!.capacity).to.equal(4);
      headerView[SabHeaderField.CAPACITY] = 8;
      const views2 = getOrBuildArenaViews(memory, provider);
      expect(views2!.capacity).to.equal(8);
    },
  );
});
