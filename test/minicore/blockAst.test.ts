import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  emptyMiniCoreMetadata,
  getRuntimeSymbolSignature,
  TRIP_RUNTIME_SYMBOLS,
  type BlockFunctionDef,
  type BlockInstruction,
  type BlockModule,
} from "../../lib/minicore/index.ts";

describe("MiniCore Block IR format", () => {
  it("models typed blocks with block params and runtime calls", () => {
    const read: BlockInstruction = {
      result: { id: 0, name: "b", type: { kind: "u8" } },
      resultType: { kind: "u8" },
      effects: "io",
      op: { kind: "runtimeCall", name: "trip_read_one", args: [] },
    };

    const write: BlockInstruction = {
      resultType: { kind: "unit" },
      effects: "io",
      op: {
        kind: "runtimeCall",
        name: "trip_write_one",
        args: [{ kind: "local", id: 0, name: "b", type: { kind: "u8" } }],
      },
    };

    const fn: BlockFunctionDef = {
      kind: "function",
      id: 0,
      name: "Main.echoOne",
      params: [],
      returnType: { kind: "unit" },
      visibility: "exported",
      blocks: [
        {
          label: "entry",
          params: [],
          instructions: [read, write],
          terminator: { kind: "return" },
        },
      ],
    };

    const module: BlockModule = {
      symbols: [fn],
      entry: 0,
      symbolsByName: new Map([["Main.echoOne", 0]]),
      metadata: emptyMiniCoreMetadata(),
    };

    assert.equal(module.symbols[0], fn);
    assert.equal(fn.blocks[0]?.instructions[0]?.op.kind, "runtimeCall");
    assert.equal(fn.blocks[0]?.terminator.kind, "return");
  });

  it("defines the backend-neutral Trip runtime ABI", () => {
    assert.deepEqual(getRuntimeSymbolSignature("trip_read_one"), {
      name: "trip_read_one",
      args: [],
      result: { kind: "u8" },
      effects: "io",
    });
    assert.deepEqual(TRIP_RUNTIME_SYMBOLS.get("trip_write_one"), {
      name: "trip_write_one",
      args: [{ kind: "u8" }],
      result: { kind: "unit" },
      effects: "io",
    });
  });
});
