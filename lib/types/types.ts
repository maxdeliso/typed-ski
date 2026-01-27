/**
 * Core type system definitions and utilities.
 *
 * This module defines the fundamental types used throughout the type system,
 * including type variables, arrow types, universal types, and utility functions
 * for type manipulation.
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

export interface TypeApplication {
  kind: "type-app";
  fn: BaseType;
  arg: BaseType;
}

export type BaseType = TypeVariable | ArrowType | ForallType | TypeApplication;

export const mkTypeVariable = (name: string): TypeVariable => ({
  kind: "type-var",
  typeName: name,
});

export const arrow = (a: BaseType, b: BaseType): ArrowType => ({
  kind: "non-terminal",
  lft: a,
  rgt: b,
});

export const typeApp = (fn: BaseType, arg: BaseType): TypeApplication => ({
  kind: "type-app",
  fn,
  arg,
});

export const arrows = (...tys: BaseType[]): BaseType =>
  tys.reduceRight((acc, ty) => arrow(ty, acc));

export const typesLitEq = (a: BaseType, b: BaseType): boolean => {
  if (a.kind === "type-var" && b.kind === "type-var") {
    return a.typeName === b.typeName;
  } else if (a.kind === "type-app" && b.kind === "type-app") {
    return typesLitEq(a.fn, b.fn) && typesLitEq(a.arg, b.arg);
  } else if (a.kind === "forall" && b.kind === "forall") {
    return a.typeVar === b.typeVar && typesLitEq(a.body, b.body);
  } else if ("lft" in a && "rgt" in a && "lft" in b && "rgt" in b) {
    return typesLitEq(a.lft, b.lft) && typesLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};
