import { ConsCell, cons } from '../cons.ts';

/**
 * The type variable node.
 */
export interface TypeVariable {
  kind: 'type-var';
  typeName: string;
}

/**
 * A type is either a type variable or an arrow type
 * (represented as a cons cell of types).
 */
export type Type = TypeVariable | ConsCell<Type>;

/**
 * Constructor for a type variable.
 */
export const mkTypeVariable = (name: string): TypeVariable => ({
  kind: 'type-var',
  typeName: name,
});

/**
 * Constructs an arrow type A→B as a cons cell.
 */
export const arrow = (a: Type, b: Type): Type => cons<Type>(a, b);

/**
 * Given a list of types, builds a right–associative arrow type.
 * For example, arrows(a, b, c) produces a→(b→c).
 */
export const arrows = (...tys: Type[]): Type =>
  tys.reduceRight((acc, ty) => cons<Type>(ty, acc));

/**
 * Compares two types for literal equality.
 */
export const typesLitEq = (a: Type, b: Type): boolean => {
  if (a.kind === 'type-var' && b.kind === 'type-var') {
    return a.typeName === b.typeName;
  } else if (a.kind === 'non-terminal' && b.kind === 'non-terminal') {
    return typesLitEq(a.lft, b.lft) && typesLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};

/**
 * Pretty–prints a type.
 */
export const prettyPrintTy = (ty: Type): string => {
  if (ty.kind === 'type-var') {
    return ty.typeName;
  } else {
    return `(${prettyPrintTy(ty.lft)}→${prettyPrintTy(ty.rgt)})`;
  }
};
