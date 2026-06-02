/**
 * Canonical ASCII ordering helpers used for deterministic compiler output.
 *
 * @module
 */

export function compareAscii(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
