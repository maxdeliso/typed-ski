/**
 * Hash-consing arena evaluator singleton.
 *
 * @module
 */

import {
  type ArenaEvaluatorWasm,
  createArenaEvaluatorReleaseSync,
} from "./arenaEvaluator.ts";
import type { Evaluator } from "./evaluator.ts";

/**
 * Lazily initialise the release-mode arena evaluator so CLI commands that do
 * not evaluate expressions (e.g. --help, --version) can run without loading WASM.
 */
let wasmEvaluator: ArenaEvaluatorWasm | null = null;

function getWasmEvaluator(): ArenaEvaluatorWasm {
  if (wasmEvaluator) return wasmEvaluator;
  wasmEvaluator = createArenaEvaluatorReleaseSync();
  return wasmEvaluator;
}

/**
 * Primary hash-consing arena evaluator used throughout the project.
 */
export const arenaEvaluator: Evaluator = {
  stepOnce(expr) {
    return getWasmEvaluator().stepOnce(expr);
  },
  reduce(expr, maxIterations) {
    return getWasmEvaluator().reduce(expr, maxIterations);
  },
};
