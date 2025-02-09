import { mkTypeVariable } from './types.js';

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
 * For instance, the first call might return the variable “a”, the next “b”, etc.
 */
export const varSource = (): (() => ReturnType<typeof mkTypeVariable>) => {
  const ordinals = monoInts();
  return () => {
    const offset = ordinals();
    if (offset > 25) {
      throw new Error('too many type variables');
    }
    const char = String.fromCharCode(97 + offset);
    return mkTypeVariable(char);
  };
};
