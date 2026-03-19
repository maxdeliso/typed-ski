/**
 * Checks if n is a perfect power: n = a^b for integers a, b > 1
 * Returns [a, b] if found, null otherwise.
 * Prefers smallest exponent b to minimize application depth.
 */
export function findPerfectPower(
  value: number | bigint,
): [bigint, bigint] | null {
  const n = BigInt(value);
  if (n < 4n) return null; // 0,1,2,3 are not perfect powers (with b > 1)

  // Max exponent b for n is log2(n)
  const maxB = n <= 2n ? 1n : BigInt(n.toString(2).length);

  for (let b = 2n; b <= maxB; b++) {
    // Binary search for a such that a^b = n
    let low = 2n;
    let high = n;
    while (low <= high) {
      const mid = (low + high) / 2n;
      let p = 1n;
      let overflow = false;
      for (let i = 0; i < Number(b); i++) {
        p *= mid;
        if (p > n) {
          overflow = true;
          break;
        }
      }

      if (!overflow && p === n) return [mid, b];
      if (overflow || p > n) {
        high = mid - 1n;
      } else {
        low = mid + 1n;
      }
    }
  }
  return null;
}

/**
 * Finds factors of a composite number.
 * Returns [a, b] where a * b = n, preferring smallest factor first.
 * Returns null if n is prime.
 */
export function findFactors(value: number | bigint): [bigint, bigint] | null {
  const n = BigInt(value);
  if (n < 4n) return null;
  const sqrtN = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (let a = 2n; a <= sqrtN; a++) {
    if (n % a === 0n) {
      return [a, n / a];
    }
  }
  return null;
}
