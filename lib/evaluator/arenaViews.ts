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

/** AoS: each node is 32 bytes (id<<5 indexing; left, right, hash32, next_idx, kind, sym, pad). */
const ARENA_NODE_STRIDE_BYTES = 32;
const NODE_OFFSET_LEFT = 0;
const NODE_OFFSET_RIGHT = 4;
const NODE_OFFSET_KIND = 16;
const NODE_OFFSET_SYM = 17;

/**
 * Arena view for direct memory access (AoS layout).
 * Nodes never move on grow(); offset_nodes + id * 20 gives the node address.
 */
export interface ArenaViews {
  buffer: ArrayBuffer | SharedArrayBuffer;
  baseAddr: number;
  offsetNodes: number;
  capacity: number;
}

/**
 * Interface for objects that provide the necessary exports to build arena views.
 * This abstracts the dependency on ArenaWasmExports.
 */
interface ArenaViewsProvider {
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
  // We use generated constants to access field indices, ensuring they match c/arena.h SabHeader layout
  const headerView = new Uint32Array(
    buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  );

  const capacity = headerView[SabHeaderField.CAPACITY]!;
  // offset_nodes is uint64_t (indices 10=lo, 11=hi); read as number (fits for arena sizes)
  const offsetNodesLo = headerView[SabHeaderField.OFFSET_NODES]!;
  const offsetNodesHi = headerView[SabHeaderField.OFFSET_NODES + 1]!;
  const offsetNodes = offsetNodesLo + offsetNodesHi * 0x1_0000_0000;

  return { buffer, baseAddr, offsetNodes, capacity };
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

function nodeBase(views: ArenaViews, id: number): number {
  return views.baseAddr + views.offsetNodes + id * ARENA_NODE_STRIDE_BYTES;
}

export function getKind(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u8 = new Uint8Array(views.buffer);
  return u8[nodeBase(views, id) + NODE_OFFSET_KIND]!;
}

export function getSym(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u8 = new Uint8Array(views.buffer);
  return u8[nodeBase(views, id) + NODE_OFFSET_SYM]!;
}

export function getLeft(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u32 = new Uint32Array(views.buffer);
  return u32[(nodeBase(views, id) >>> 2) + (NODE_OFFSET_LEFT >>> 2)]!;
}

export function getRight(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u32 = new Uint32Array(views.buffer);
  return u32[(nodeBase(views, id) >>> 2) + (NODE_OFFSET_RIGHT >>> 2)]!;
}
