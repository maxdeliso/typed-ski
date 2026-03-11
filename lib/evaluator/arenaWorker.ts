/**
 * Web Worker entry point for the parallel arena evaluator.
 *
 * @module
 */

import { getReleaseWasmBytes } from "./arenaWasmLoader.ts";
import type { ArenaWasmExports } from "./arenaEvaluator.ts";

interface InitMessage {
  type: "init";
  memory: WebAssembly.Memory;
  workerId: number;
}

interface ConnectArenaMessage {
  type: "connectArena";
  arenaPointer: number;
}

let wasmExports: ArenaWasmExports | null = null;
let currentWorkerId = 64; // MAX_WORKERS

async function init(msg: InitMessage) {
  const wasmBytes = await getReleaseWasmBytes();
  const module = await WebAssembly.compile(wasmBytes);
  currentWorkerId = msg.workerId;
  const instance = await WebAssembly.instantiate(module, {
    env: {
      memory: msg.memory,
      wasm_get_worker_id: () => currentWorkerId,
      wasm_set_worker_id: (id: number) => {
        currentWorkerId = id;
      },
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
    if (rc === 1) {
      self.postMessage({ type: "connectArenaComplete" });
      // Enter the blocking worker loop; never returns.
      wasmExports.workerLoop?.(currentWorkerId);
    } else {
      self.postMessage({
        type: "connectArenaComplete",
        error: `connectArena failed with code ${rc}`,
      });
    }
  } catch (err) {
    self.postMessage({
      type: "connectArenaComplete",
      error: (err as Error).message,
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
