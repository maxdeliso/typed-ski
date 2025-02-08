import { ConsCell, cons } from '../cons.ts';
import { TypeVariable } from './types.ts';

/*
 * https://en.wikipedia.org/wiki/System_F
 */

/**
 * A universal (polymorphic) type, written as “∀X. T”.
 */
export interface ForallType {
  kind: 'forall';
  typeVar: string;
  body: SystemFType;
}

export const forall = (
  typeVar: string,
  body: SystemFType
): ForallType => ({
  kind: 'forall',
  typeVar,
  body,
});

/**
 * A System F type is one of:
 *  - a type variable,
 *  - a universal type, or
 *  - an arrow type represented as a cons cell.
 *
 * In an arrow type such as A → B, the left branch holds A and the right branch holds B.
 */
export type SystemFType = TypeVariable | ForallType | ConsCell<SystemFType>;

export const arrow = (
  left: SystemFType,
  right: SystemFType
): ConsCell<SystemFType> => cons(left, right);
