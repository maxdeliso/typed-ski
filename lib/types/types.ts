/**
 * Core type system definitions and utilities.
 *
 * This module defines the fundamental types used throughout the type system,
 * including type variables, arrow types, universal types, and utility functions
 * for type manipulation and pretty printing.
 *
 * @module
 */

export interface TypeVariable {
  kind: "type-var";
  typeName: string;
}

export interface ForallType {
  kind: "forall";
  typeVar: string;
  body: BaseType;
}

export interface ArrowType {
  kind: "non-terminal";
  lft: BaseType;
  rgt: BaseType;
}

export type BaseType = TypeVariable | ArrowType | ForallType;

export const mkTypeVariable = (name: string): TypeVariable => ({
  kind: "type-var",
  typeName: name,
});

export const arrow = (a: BaseType, b: BaseType): ArrowType => ({
  kind: "non-terminal",
  lft: a,
  rgt: b,
});

export const arrows = (...tys: BaseType[]): BaseType =>
  tys.reduceRight((acc, ty) => arrow(ty, acc));

export const typesLitEq = (a: BaseType, b: BaseType): boolean => {
  if (a.kind === "type-var" && b.kind === "type-var") {
    return a.typeName === b.typeName;
  } else if (a.kind === "forall" && b.kind === "forall") {
    return a.typeVar === b.typeVar && typesLitEq(a.body, b.body);
  } else if ("lft" in a && "rgt" in a && "lft" in b && "rgt" in b) {
    return typesLitEq(a.lft, b.lft) && typesLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};

/**
 * Renders a base type as a compact UTF-8 string using ∀ and →.
 * @param ty the type to print
 * @returns a human-readable string representation
 */
export const prettyPrintTy = (ty: BaseType): string => {
  // Formats either a type variable, a forall, or an arrow type using →.
  if (ty.kind === "type-var") {
    return ty.typeName;
  } else if (ty.kind === "forall") {
    return `∀${ty.typeVar}.${prettyPrintTy(ty.body)}`;
  } else {
    return `(${prettyPrintTy(ty.lft)}→${prettyPrintTy(ty.rgt)})`;
  }
};
