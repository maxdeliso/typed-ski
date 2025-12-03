/**
 * Hash-consing arena evaluator singleton.
 *
 * @module
 */

import {
  type ArenaEvaluatorWasm,
  createArenaEvaluatorReleaseSync,
} from "./arenaEvaluator.ts";

/**
 * Initialise the release-mode arena evaluator synchronously using the embedded
 * WASM binary so that bundled environments (e.g. Deno compile / bundle) do not
 * require filesystem or network access at startup.
 */
const wasmEvaluator: ArenaEvaluatorWasm = createArenaEvaluatorReleaseSync();

/**
 * Primary hash-consing arena evaluator used throughout the project.
 */
export const arenaEvaluator = wasmEvaluator;
