/**
 * Web Worker entry point for the parallel arena evaluator.
 *
 * @module
 */

import { getEmbeddedReleaseWasm } from "./arenaWasm.embedded.ts";
import type { ArenaWasmExports } from "./arenaEvaluator.ts";

interface InitMessage {
  type: "init";
  memory: WebAssembly.Memory;
  sab: SharedArrayBuffer;
  workerId: number;
}

interface ConnectArenaMessage {
  type: "connectArena";
  arenaPointer: number;
}

let wasmExports: ArenaWasmExports | null = null;

async function init(msg: InitMessage) {
  const wasmBytes = getEmbeddedReleaseWasm().slice();
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    env: {
      memory: msg.memory,
    },
  });
  wasmExports = instance.exports as unknown as ArenaWasmExports;

  self.postMessage({ type: "ready", workerId: msg.workerId });
}

function handleConnectArena(msg: ConnectArenaMessage) {
  if (!wasmExports || typeof wasmExports.connectArena !== "function") {
    self.postMessage({
      type: "connectArenaComplete",
      error: "connectArena export missing",
    });
    return;
  }
  try {
    const rc = wasmExports.connectArena(msg.arenaPointer);
    // Return codes from connectArena (see rust/src/arena.rs):
    // 1 = Success
    // 0 = Error: null pointer
    // 2 = Error: header out of bounds
    // 3 = Error: invalid capacity
    // 4 = Error: Arena data out of bounds
    // 5 = Error: Invalid Magic / Corrupted Header
    // 6 = Error: Misaligned address
    if (rc === 1) {
      self.postMessage({ type: "connectArenaComplete" });
      // Enter the blocking worker loop; never returns.
      wasmExports.workerLoop?.();
    } else {
      self.postMessage({
        type: "connectArenaComplete",
        error: `connectArena failed with code ${rc}`,
      });
    }
  } catch (err) {
    self.postMessage({
      type: "connectArenaComplete",
      error: `connectArena threw an error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

self.onmessage = (e) => {
  if (e.data.type === "init") {
    init(e.data).catch((err) => {
      self.postMessage({ type: "error", error: err.message });
    });
  } else if (e.data.type === "connectArena") {
    handleConnectArena(e.data as ConnectArenaMessage);
  }
};
