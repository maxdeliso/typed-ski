/**
 * Type variable name generation.
 *
 * This module provides functionality for generating fresh type variable names
 * during type inference and normalization operations.
 *
 * @module
 */
import { mkTypeVariable } from "./types.ts";

/**
 * Returns a generator that yields sequential numbers.
 */
const monoInts = (): () => number => {
  let num = 0;
  return () => {
    const ret = num;
    num++;
    return ret;
  };
};

/**
 * Returns a generator that produces fresh type variables.
 * For instance, the first call might return the variable "a", the next "b", etc.
 */
export const varSource = (): () => ReturnType<typeof mkTypeVariable> => {
  const ordinals = monoInts();
  const baseCharCode = 97; // 'a'
  const alphabetSize = 26;

  return () => {
    const offset = ordinals();
    const remainder = offset % alphabetSize;
    const quotient = Math.floor(offset / alphabetSize);
    const letter = String.fromCharCode(baseCharCode + remainder);
    const name = quotient === 0 ? letter : `${letter}${quotient}`;
    return mkTypeVariable(name);
  };
};
