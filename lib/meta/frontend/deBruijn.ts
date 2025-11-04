/**
 * De Bruijn Index Conversion
 *
 * This module provides functionality to convert TripLang's abstract syntax trees
 * into a De Bruijn index representation. This representation is name-independent
 * for bound variables, making it ideal for $\alpha$-normalized structural hashing
 * and equivalence checking.
 *
 * @module
 */

import type { TripLangValueType } from "../trip.ts";

/**
 * A bound variable reference using a De Bruijn index.
 * The index represents the number of binders to traverse upward to reach the binding site.
 */
export interface DeBruijnVar {
  kind: "DbVar";
  index: number;
}

/**
 * A free term variable identified by its original name.
 */
export interface DeBruijnFreeVar {
  kind: "DbFreeVar";
  name: string;
}

/**
 * A free type variable identified by its original name.
 */
export interface DeBruijnFreeTypeVar {
  kind: "DbFreeTypeVar";
  name: string;
}

/**
 * An untyped lambda abstraction: λ body
 */
export interface DeBruijnAbs {
  kind: "DbAbs";
  body: DeBruijnTerm;
}

/**
 * A System F term abstraction: λx: T. body
 */
export interface DeBruijnSysFAbs {
  kind: "DbSysFAbs";
  typeAnnotation: DeBruijnTerm;
  body: DeBruijnTerm;
}

/**
 * A typed lambda abstraction: λx: T. body
 */
export interface DeBruijnTypedAbs {
  kind: "DbTypedAbs";
  type: DeBruijnTerm;
  body: DeBruijnTerm;
}

/**
 * A System F type abstraction: ΛX. body
 */
export interface DeBruijnTyAbs {
  kind: "DbTyAbs";
  body: DeBruijnTerm;
}

/**
 * A universal type: ∀X. body
 */
export interface DeBruijnForall {
  kind: "DbForall";
  body: DeBruijnTerm;
}

/**
 * A term application: left right
 */
export interface DeBruijnApp {
  kind: "DbApp";
  left: DeBruijnTerm;
  right: DeBruijnTerm;
}

/**
 * A type application: term [typeArg]
 */
export interface DeBruijnTyApp {
  kind: "DbTyApp";
  term: DeBruijnTerm;
  typeArg: DeBruijnTerm;
}

/**
 * A terminal symbol (S, K, I).
 */
export interface DeBruijnTerminal {
  kind: "DbTerminal";
  sym: string;
}

/**
 * A De Bruijn term represents a TripLang value in name-independent form.
 * Bound variables are represented by indices, while free variables retain their names.
 */
export type DeBruijnTerm =
  | DeBruijnVar
  | DeBruijnFreeVar
  | DeBruijnFreeTypeVar
  | DeBruijnAbs
  | DeBruijnSysFAbs
  | DeBruijnTypedAbs
  | DeBruijnTyAbs
  | DeBruijnForall
  | DeBruijnApp
  | DeBruijnTyApp
  | DeBruijnTerminal;

/**
 * Recursively converts a TripLangValueType AST into a De Bruijn representation.
 * Bound variables are replaced with numeric indices, and free variables are
 * identified by their original names.
 *
 * @param term The AST node to convert.
 * @param termCtx An array of bound term variable names, where index 0 is the
 * most recent (innermost) binder.
 * @param typeCtx An array of bound type variable names, managed similarly to
 * termCtx.
 * @returns A typed De Bruijn term structure.
 */
function toDeBruijnInternal(
  term: TripLangValueType,
  termCtx: string[],
  typeCtx: string[],
): DeBruijnTerm {
  switch (term.kind) {
    case "lambda-var":
    case "systemF-var": {
      const idx = termCtx.indexOf(term.name);
      return (idx === -1)
        ? { kind: "DbFreeVar", name: term.name }
        : { kind: "DbVar", index: idx };
    }
    case "type-var": {
      const idx = typeCtx.indexOf(term.typeName);
      return (idx === -1)
        ? { kind: "DbFreeTypeVar", name: term.typeName }
        : { kind: "DbVar", index: idx };
    }
    case "lambda-abs":
      return {
        kind: "DbAbs",
        body: toDeBruijnInternal(
          term.body,
          [term.name, ...termCtx],
          typeCtx,
        ),
      };
    case "systemF-abs":
      return {
        kind: "DbSysFAbs",
        typeAnnotation: toDeBruijnInternal(term.typeAnnotation, termCtx, typeCtx),
        body: toDeBruijnInternal(term.body, [term.name, ...termCtx], typeCtx),
      };
    case "typed-lambda-abstraction":
      return {
        kind: "DbTypedAbs",
        type: toDeBruijnInternal(term.ty, termCtx, typeCtx),
        body: toDeBruijnInternal(term.body, [term.varName, ...termCtx], typeCtx),
      };
    case "systemF-type-abs":
      return {
        kind: "DbTyAbs",
        body: toDeBruijnInternal(
          term.body,
          termCtx,
          [term.typeVar, ...typeCtx],
        ),
      };
    case "forall":
      return {
        kind: "DbForall",
        body: toDeBruijnInternal(
          term.body,
          termCtx,
          [term.typeVar, ...typeCtx],
        ),
      };
    case "non-terminal":
      return {
        kind: "DbApp",
        left: toDeBruijnInternal(term.lft, termCtx, typeCtx),
        right: toDeBruijnInternal(term.rgt, termCtx, typeCtx),
      };
    case "systemF-type-app":
      return {
        kind: "DbTyApp",
        term: toDeBruijnInternal(term.term, termCtx, typeCtx),
        typeArg: toDeBruijnInternal(term.typeArg, termCtx, typeCtx),
      };
    case "terminal":
      return { kind: "DbTerminal", sym: term.sym };
  }
}

/**
 * Converts a TripLangValueType AST into a name-independent
 * De Bruijn index representation suitable for stable hashing.
 *
 * Example:
 * - `λx. x` becomes `{ kind: "DbAbs", body: { kind: "DbVar", index: 0 } }`
 * - `λy. y` becomes `{ kind: "DbAbs", body: { kind: "DbVar", index: 0 } }`
 * - `λx. λy. x` becomes `{ kind: "DbAbs", body: { kind: "DbAbs", body: { kind: "DbVar", index: 1 } } }`
 * - `λx. y` becomes `{ kind: "DbAbs", body: { kind: "DbFreeVar", name: "y" } }`
 *
 * @param term The TripLang value to convert.
 * @returns A typed De Bruijn term structure.
 */
export function toDeBruijn(term: TripLangValueType): DeBruijnTerm {
  return toDeBruijnInternal(term, [], []);
}

