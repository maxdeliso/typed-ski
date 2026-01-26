/**
 * System F term representation and utilities.
 *
 * This module defines the AST types for System F (polymorphic lambda calculus)
 * terms, including variables, abstractions, type abstractions, and applications.
 * It also provides pretty-printing and utility functions for working with System F terms.
 *
 * @module
 */
import type { BaseType } from "../types/types.ts";
import { parseNatLiteralIdentifier } from "../consts/nat.ts";

/**
 * A term variable in System F.
 * Represents a reference to a bound or free variable by name.
 */
export interface SystemFVar {
  kind: "systemF-var";
  name: string;
}

/**
 * Creates a System F term variable.
 * @param name the variable name
 * @returns a new System F variable node
 */
export const mkSystemFVar = (name: string): SystemFVar => ({
  kind: "systemF-var",
  name,
});

/**
 * A term abstraction in System F: λx: T. t
 * Represents a function that binds a variable with a type annotation.
 */
export interface SystemFAbs {
  kind: "systemF-abs";
  name: string;
  typeAnnotation: BaseType;
  body: SystemFTerm;
}

/**
 * Creates a System F term abstraction (λx: T. t).
 * @param name the bound variable name
 * @param typeAnnotation the type annotation for the bound variable
 * @param body the body of the abstraction
 * @returns a new System F term abstraction node
 */
export const mkSystemFAbs = (
  name: string,
  typeAnnotation: BaseType,
  body: SystemFTerm,
): SystemFAbs => ({
  kind: "systemF-abs",
  name,
  typeAnnotation,
  body,
});

/**
 * A type abstraction in System F: ΛX. t
 * Represents a polymorphic function that abstracts over a type variable.
 */
export interface SystemFTAbs {
  kind: "systemF-type-abs";
  typeVar: string;
  body: SystemFTerm;
}

/**
 * Creates a System F type abstraction (ΛX. t).
 * @param typeVar the bound type variable name
 * @param body the body of the type abstraction
 * @returns a new System F type abstraction node
 */
export const mkSystemFTAbs = (
  typeVar: string,
  body: SystemFTerm,
): SystemFTAbs => ({
  kind: "systemF-type-abs",
  typeVar,
  body,
});

/**
 * A type application node in System F: t [T]
 * Represents applying a polymorphic term to a type argument.
 */
export interface SystemFTypeApp {
  kind: "systemF-type-app";
  term: SystemFTerm;
  typeArg: BaseType;
}

/**
 * Creates a System F type application (t [T]).
 * @param term the polymorphic term to apply
 * @param typeArg the type argument
 * @returns a new System F type application node
 */
export const mkSystemFTypeApp = (
  term: SystemFTerm,
  typeArg: BaseType,
): SystemFTypeApp => ({
  kind: "systemF-type-app",
  term,
  typeArg,
});

/**
 * Creates a System F term application (t u).
 * @param lft the function term
 * @param rgt the argument term
 * @returns a new System F application node
 */
export const mkSystemFApp = (
  lft: SystemFTerm,
  rgt: SystemFTerm,
): SystemFTerm => ({ kind: "non-terminal", lft, rgt });

/**
 * An application in System F representing the application of one term to another.
 *
 * Applications are binary operations where the left term is applied to the right term.
 * This is the fundamental operation for function application in System F.
 */
export interface SystemFApplication {
  kind: "non-terminal";
  lft: SystemFTerm;
  rgt: SystemFTerm;
}

/**
 * A System F term represents expressions in the polymorphic lambda calculus (System F).
 *
 * System F extends the simply typed lambda calculus with universal quantification over types.
 * A System F term can be one of:
 * - a variable (SystemFVar),
 * - a term abstraction λx:T.t (SystemFAbs),
 * - a type abstraction ΛX.t (SystemFTAbs),
 * - a type application t[T] (SystemFTypeApp), or
 * - a term application t u (SystemFApplication)
 */
export type SystemFTerm =
  | SystemFVar
  | SystemFAbs
  | SystemFTAbs
  | SystemFTypeApp
  | SystemFApplication;

/**
 * Creates an application of one System F term to another.
 * @param left the function term
 * @param right the argument term
 * @returns a new application node
 */
export const createSystemFApplication = (
  left: SystemFTerm,
  right: SystemFTerm,
): SystemFTerm => ({
  kind: "non-terminal",
  lft: left,
  rgt: right,
});

/**
 * Pretty-prints a System F term using ASCII syntax.
 * @param term the System F term
 * @returns a human-readable string representation
 */
export function prettyPrintSystemF(term: SystemFTerm): string {
  switch (term.kind) {
    case "non-terminal": {
      const parts = flattenSystemFApp(term);
      return `(${parts.map(prettyPrintSystemF).join(" ")})`;
    }
    case "systemF-var":
      return parseNatLiteralIdentifier(term.name)?.toString() ?? term.name;
    case "systemF-abs":
      return `\\${term.name}:${prettyPrintSystemFType(term.typeAnnotation)}=>${
        prettyPrintSystemF(term.body)
      }`;
    case "systemF-type-abs":
      return `#${term.typeVar}=>${prettyPrintSystemF(term.body)}`;
    case "systemF-type-app":
      return `${prettyPrintSystemF(term.term)}[${
        prettyPrintSystemFType(term.typeArg)
      }]`;
  }
}

/**
 * Flattens a left-associated application tree into a list of terms.
 * For example, ((a b) c) becomes [a, b, c].
 * @param term the System F term to flatten
 * @returns an array of terms in left-to-right order
 */
export function flattenSystemFApp(term: SystemFTerm): SystemFTerm[] {
  if (term.kind === "non-terminal") {
    const leftParts = flattenSystemFApp(term.lft);
    return [...leftParts, term.rgt];
  } else {
    return [term];
  }
}

/**
 * Pretty-prints a System F type using ASCII syntax.
 * @param ty the BaseType to pretty-print
 * @returns a human-readable string representation of the type
 */
export function prettyPrintSystemFType(ty: BaseType): string {
  if (ty.kind === "forall") {
    return `#${ty.typeVar}->${prettyPrintSystemFType(ty.body)}`;
  } else if (ty.kind === "non-terminal" && "lft" in ty && "rgt" in ty) {
    return `(${prettyPrintSystemFType(ty.lft)}->${
      prettyPrintSystemFType(ty.rgt)
    })`;
  } else {
    return ty.typeName;
  }
}
