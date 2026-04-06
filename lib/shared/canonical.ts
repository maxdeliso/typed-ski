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

export function compareAsciiTuple(
  left: readonly string[],
  right: readonly string[],
): number {
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i++) {
    const cmp = compareAscii(left[i]!, right[i]!);
    if (cmp !== 0) {
      return cmp;
    }
  }
  if (left.length < right.length) {
    return -1;
  }
  if (left.length > right.length) {
    return 1;
  }
  return 0;
}

export function sortedStrings(values: Iterable<string>): string[] {
  return Array.from(values).sort(compareAscii);
}

export function sortByKey<T>(
  values: Iterable<T>,
  key: (value: T) => string,
): T[] {
  return Array.from(values).sort((left, right) =>
    compareAscii(key(left), key(right)),
  );
}

export function sortedRecordEntries<T>(
  record: Readonly<Record<string, T>>,
): Array<[string, T]> {
  return Object.entries(record).sort(([left], [right]) =>
    compareAscii(left, right),
  );
}
