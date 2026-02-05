export function required<T>(
  value: T | null | undefined,
  message: string,
): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

export function requiredAt<T>(
  values: ArrayLike<T>,
  index: number,
  message: string,
): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}
