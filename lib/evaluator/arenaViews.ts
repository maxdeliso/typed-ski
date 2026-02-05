/**
 * Arena Views Module
 *
 * Provides typed array views for direct memory access to the arena allocator.
 * Includes caching and validation to handle arena growth.
 *
 * @module
 */

import {
  SABHEADER_HEADER_SIZE_U32,
  SabHeaderField,
} from "./arenaHeader.generated.ts";

/**
 * Typed array views of the arena memory for direct access.
 * These views provide O(1) access to arena node data without WASM function calls.
 */
export interface ArenaViews {
  kind: Uint8Array;
  sym: Uint8Array;
  leftId: Uint32Array;
  rightId: Uint32Array;
  capacity: number;
}

/**
 * Interface for objects that provide the necessary exports to build arena views.
 * This abstracts the dependency on ArenaWasmExports.
 */
export interface ArenaViewsProvider {
  debugGetArenaBaseAddr?(): number;
}

/**
 * Arena views cache: Maps memory buffer -> { views, lastCapacity, lastBaseAddr }
 * Uses memory.buffer as key since it's stable per evaluator instance
 * Note: We use Map instead of WeakMap because ArrayBuffer/SharedArrayBuffer can be used as Map keys
 */
const viewsCache = new Map<
  ArrayBuffer | SharedArrayBuffer,
  { views: ArenaViews; lastCapacity: number; lastBaseAddr: number }
>();

/**
 * Build typed array views of the arena memory for direct access.
 * Reads the arena header to get offsets and creates views of the data arrays.
 */
function buildArenaViews(
  memory: WebAssembly.Memory,
  provider: ArenaViewsProvider,
): ArenaViews | null {
  if (!provider.debugGetArenaBaseAddr) {
    return null; // Fallback to WASM calls if base address not available
  }

  const baseAddr = provider.debugGetArenaBaseAddr();
  if (baseAddr === 0) {
    return null; // Arena not initialized
  }

  const buffer = memory.buffer;
  // Read header as Uint32Array - offsets are stored in the header itself
  // We use generated constants to access field indices, ensuring they match Rust struct layout
  const headerView = new Uint32Array(
    buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  );

  // Read offsets from header (these are computed at runtime by Rust code)
  const capacity = headerView[SabHeaderField.CAPACITY]!;
  const offsetKind = headerView[SabHeaderField.OFFSET_KIND]!;
  const offsetSym = headerView[SabHeaderField.OFFSET_SYM]!;
  const offsetLeftId = headerView[SabHeaderField.OFFSET_LEFT_ID]!;
  const offsetRightId = headerView[SabHeaderField.OFFSET_RIGHT_ID]!;

  // Create typed array views of the arena data arrays
  const kind = new Uint8Array(buffer, baseAddr + offsetKind, capacity);
  const sym = new Uint8Array(buffer, baseAddr + offsetSym, capacity);
  const leftId = new Uint32Array(buffer, baseAddr + offsetLeftId, capacity);
  const rightId = new Uint32Array(buffer, baseAddr + offsetRightId, capacity);

  return { kind, sym, leftId, rightId, capacity };
}

/**
 * Validate and rebuild views if they've become stale (arena grew).
 * Returns updated views or null if validation failed.
 */
export function validateAndRebuildViews(
  views: ArenaViews | null,
  memory: WebAssembly.Memory | undefined,
  provider: ArenaViewsProvider,
): ArenaViews | null {
  if (!views || !memory) {
    return views;
  }

  const baseAddr = provider.debugGetArenaBaseAddr?.();
  if (!baseAddr) {
    return null;
  }

  // Check current capacity from header
  const buffer = memory.buffer;
  const headerView = new Uint32Array(
    buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  );
  const currentCapacity = headerView[SabHeaderField.CAPACITY];

  // If capacity changed, views are stale - rebuild them
  if (currentCapacity !== views.capacity) {
    return buildArenaViews(memory, provider);
  }

  return views;
}

/**
 * Get or build arena views with caching.
 * Uses memory.buffer as cache key since it's stable per evaluator instance.
 * Validates cached views are still current and rebuilds if stale.
 */
export function getOrBuildArenaViews(
  memory: WebAssembly.Memory | undefined,
  provider: ArenaViewsProvider,
): ArenaViews | null {
  if (!memory) {
    return null;
  }

  const buffer = memory.buffer;
  const baseAddr = provider.debugGetArenaBaseAddr?.();
  const cached = viewsCache.get(buffer);

  let views: ArenaViews | null = null;

  // Check if cached views are still valid (same base address and capacity)
  if (cached && baseAddr && cached.lastBaseAddr === baseAddr) {
    // Validate cached views are still current (check capacity)
    const validated = validateAndRebuildViews(cached.views, memory, provider);
    if (validated && validated.capacity === cached.lastCapacity) {
      views = validated;
    } else {
      // Views are stale or invalid, rebuild
      views = validated || buildArenaViews(memory, provider);
    }
  } else {
    // No cache or base address changed, build new views
    views = buildArenaViews(memory, provider);
  }

  // Update cache if we have valid views and base address
  if (views && baseAddr) {
    viewsCache.set(buffer, {
      views,
      lastCapacity: views.capacity,
      lastBaseAddr: baseAddr,
    });
  }

  return views;
}

export function arenaTop(memory: WebAssembly.Memory, baseAddr: number): number {
  return new Uint32Array(
    memory.buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  )[SabHeaderField.TOP]! >>> 0;
}

export function getKind(id: number, views: ArenaViews): number {
  return id < views.capacity ? views.kind[id]! : -1;
}

export function getSym(id: number, views: ArenaViews): number {
  return id < views.capacity ? views.sym[id]! : -1;
}

export function getLeft(id: number, views: ArenaViews): number {
  return id < views.capacity ? views.leftId[id]! : -1;
}

export function getRight(id: number, views: ArenaViews): number {
  return id < views.capacity ? views.rightId[id]! : -1;
}
