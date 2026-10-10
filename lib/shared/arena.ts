/**
 * Control-pointer bit helpers.
 *
 * Classifies control pointers and encodes or decodes their numeric indexes.
 *
 * @module
 */

export const CONTROL_PTR_BIT = 0x80000000;

export function isControlPtr(ptr: number): boolean {
  return (ptr & CONTROL_PTR_BIT) !== 0;
}

/** @internal */
export function isValuePtr(ptr: number): boolean {
  return (ptr & CONTROL_PTR_BIT) === 0;
}

/** @internal */
export function controlIndex(ptr: number): number {
  return ptr & ~CONTROL_PTR_BIT;
}

/** @internal */
export function makeControlPtr(index: number): number {
  return (index | CONTROL_PTR_BIT) >>> 0;
}
