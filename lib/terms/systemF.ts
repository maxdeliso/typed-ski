import { ConsCell } from '../cons.js';
import { SystemFType } from '../types/systemF.js';

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

export const mkSystemFApp = (lft: SystemFTerm, rgt: SystemFTerm): SystemFTerm =>
  ({ kind: 'non-terminal', lft, rgt });

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

export function prettyPrintSystemF(term: SystemFTerm): string {
  switch (term.kind) {
    case 'non-terminal': {
      const parts = flattenSystemFApp(term);
      return `(${parts.map(prettyPrintSystemF).join(' ')})`;
    }
    case 'systemF-var':
      return term.name;
    case 'systemF-abs':
      return `λ${term.name}:${prettyPrintSystemFType(term.typeAnnotation)}.${prettyPrintSystemF(term.body)}`;
    case 'systemF-type-abs':
      return `Λ${term.typeVar}.${prettyPrintSystemF(term.body)}`;
    case 'systemF-type-app':
      return `${prettyPrintSystemF(term.term)}[${prettyPrintSystemFType(term.typeArg)}]`;
  }
}

function flattenSystemFApp(term: SystemFTerm): SystemFTerm[] {
  if (term.kind === 'non-terminal') {
    const leftParts = flattenSystemFApp(term.lft);
    return [...leftParts, term.rgt];
  } else {
    return [term];
  }
}

export function prettyPrintSystemFType(ty: SystemFType): string {
  if (ty.kind === 'forall') {
    return `∀${ty.typeVar}.${prettyPrintSystemFType(ty.body)}`;
  } else if (ty.kind === 'non-terminal' && 'lft' in ty && 'rgt' in ty) {
    return `(${prettyPrintSystemFType(ty.lft)}→${prettyPrintSystemFType(ty.rgt)})`;
  } else {
    return ty.typeName;
  }
}
