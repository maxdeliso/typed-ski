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
 * Arena view for direct memory access (SoA layout).
 * Nodes never move on grow().
 */
export interface ArenaViews {
  buffer: ArrayBuffer | SharedArrayBuffer;
  baseAddr: number;
  capacity: number;
  offsetNodeLeft: number;
  offsetNodeRight: number;
  offsetNodeHash32: number;
  offsetNodeNextIdx: number;
  offsetNodeKind: number;
  offsetNodeSym: number;
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
 * Internal helper: Build arena views from wasm exports.
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

  const get64 = (field: number) => {
    const lo = headerView[field]!;
    const hi = headerView[field + 1]!;
    return lo + hi * 0x1_0000_0000;
  };

  const offsetNodeLeft = get64(SabHeaderField.OFFSET_NODE_LEFT);
  const offsetNodeRight = get64(SabHeaderField.OFFSET_NODE_RIGHT);
  const offsetNodeHash32 = get64(SabHeaderField.OFFSET_NODE_HASH32);
  const offsetNodeNextIdx = get64(SabHeaderField.OFFSET_NODE_NEXT_IDX);
  const offsetNodeKind = get64(SabHeaderField.OFFSET_NODE_KIND);
  const offsetNodeSym = get64(SabHeaderField.OFFSET_NODE_SYM);

  return {
    buffer,
    baseAddr,
    capacity,
    offsetNodeLeft,
    offsetNodeRight,
    offsetNodeHash32,
    offsetNodeNextIdx,
    offsetNodeKind,
    offsetNodeSym,
  };
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
    return views;
  }

  const headerView = new Uint32Array(
    memory.buffer,
    baseAddr,
    SABHEADER_HEADER_SIZE_U32,
  );
  const currentCapacity = headerView[SabHeaderField.CAPACITY]!;

  if (currentCapacity !== views.capacity || baseAddr !== views.baseAddr) {
    return buildArenaViews(memory, provider);
  }

  return views;
}

/**
 * Public accessor for arena views with caching.
 */
export function getOrBuildArenaViews(
  memory: WebAssembly.Memory | undefined,
  provider: ArenaViewsProvider,
): ArenaViews | null {
  if (!memory) return null;

  const cached = viewsCache.get(memory.buffer);
  let views: ArenaViews | null = null;

  if (cached) {
    const validated = validateAndRebuildViews(cached.views, memory, provider);
    if (validated) {
      views = validated;
    } else {
      views = buildArenaViews(memory, provider);
    }
  } else {
    views = buildArenaViews(memory, provider);
  }

  if (views) {
    viewsCache.set(memory.buffer, {
      views,
      lastCapacity: views.capacity,
      lastBaseAddr: views.baseAddr,
    });
  }

  return views;
}

export function getKind(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u8 = new Uint8Array(views.buffer);
  return u8[views.baseAddr + views.offsetNodeKind + id]!;
}

export function getSym(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u8 = new Uint8Array(views.buffer);
  return u8[views.baseAddr + views.offsetNodeSym + id]!;
}

export function getLeft(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u32 = new Uint32Array(views.buffer);
  return u32[(views.baseAddr + views.offsetNodeLeft + id * 4) >>> 2]!;
}

export function getRight(id: number, views: ArenaViews): number {
  if (id >= views.capacity) return -1;
  const u32 = new Uint32Array(views.buffer);
  return u32[(views.baseAddr + views.offsetNodeRight + id * 4) >>> 2]!;
}
