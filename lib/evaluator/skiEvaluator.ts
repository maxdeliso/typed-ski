/**
 * Hash-consing arena evaluator singleton.
 *
 * This module now exposes the WebAssembly arena evaluator as the primary
 * evaluation engine for SKI expressions. The legacy symbolic evaluator has been
 * removed in favour of the faster hash-consing implementation.
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
export const arenaEvaluator: ArenaEvaluatorWasm = wasmEvaluator;
