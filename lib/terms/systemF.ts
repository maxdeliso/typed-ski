import { ConsCell } from '../cons.ts';
import { SystemFType } from '../types/systemF.ts';

/**
 * A term variable.
 */
export interface SystemFVar {
  kind: 'systemF-var';
  name: string;
}

export const mkSystemFVar = (name: string): SystemFVar => ({
  kind: 'systemF-var',
  name,
});

/**
 * A term abstraction: λx: T. t
 */
export interface SystemFAbs {
  kind: 'systemF-abs';
  name: string;
  typeAnnotation: SystemFType;
  body: SystemFTerm;
}

export const mkSystemFAbs = (
  name: string,
  typeAnnotation: SystemFType,
  body: SystemFTerm
): SystemFAbs => ({
  kind: 'systemF-abs',
  name,
  typeAnnotation,
  body,
});

/**
 * A type abstraction: ΛX. t
 */
export interface SystemFTAbs {
  kind: 'systemF-type-abs';
  typeVar: string;
  body: SystemFTerm;
}

export const mkSystemFTAbs = (
  typeVar: string,
  body: SystemFTerm
): SystemFTAbs => ({
  kind: 'systemF-type-abs',
  typeVar,
  body,
});

/**
 * A type application node. Represents applying a term to a type argument as in: t [T]
 */
export interface SystemFTypeApp {
  kind: 'systemF-type-app';
  term: SystemFTerm;
  typeArg: SystemFType;
}

export const mkSystemFTypeApp = (
  term: SystemFTerm,
  typeArg: SystemFType
): SystemFTypeApp => ({
  kind: 'systemF-type-app',
  term,
  typeArg,
});

/**
 * A System F term is one of:
 *  - a variable,
 *  - a term abstraction,
 *  - a type abstraction,
 *  - a type application, or
 *  - a term application (represented as a cons cell over SystemFTerm).
 */
export type SystemFTerm =
  | SystemFVar
  | SystemFAbs
  | SystemFTAbs
  | SystemFTypeApp
  | ConsCell<SystemFTerm>;
