/**
 * Core TripLang AST types and definitions.
 *
 * This module defines the fundamental data structures for TripLang programs,
 * including term definitions, type definitions, and symbol tables.
 *
 * @module
 */
import type { SKIExpression } from "../ski/expression.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { BaseType } from "../types/types.ts";

/**
 * Root AST node for a TripLang program.
 */
export interface TripLangProgram {
  kind: "program";
  terms: TripLangTerm[];
}

/**
 * A top-level TripLang definition or directive.
 */
export type TripLangTerm =
  | PolyDefinition
  | TypedDefinition
  | UntypedDefinition
  | CombinatorDefinition
  | TypeDefinition
  | DataDefinition
  | ModuleDefinition
  | ImportDefinition
  | ExportDefinition;

/**
 * Union of possible values contained by TripLang definitions.
 */
export type TripLangValueType =
  | SystemFTerm
  | TypedLambda
  | UntypedLambda
  | SKIExpression
  | BaseType;

/** A polymorphic (System F) term definition. */
export interface PolyDefinition {
  kind: "poly";
  name: string;
  /** Marks a recursive polymorphic definition (desugared via fixpoint). */
  rec?: boolean;
  type?: BaseType;
  term: SystemFTerm;
}

/** A simply-typed lambda term definition. */
export interface TypedDefinition {
  kind: "typed";
  name: string;
  type?: BaseType;
  term: TypedLambda;
}

/** An untyped lambda term definition. */
export interface UntypedDefinition {
  kind: "untyped";
  name: string;
  term: UntypedLambda;
}

/** An SKI combinator term definition. */
export interface CombinatorDefinition {
  kind: "combinator";
  name: string;
  term: SKIExpression;
}

/** A named base or arrow/forall type definition. */
export interface TypeDefinition {
  kind: "type";
  name: string;
  type: BaseType;
}

export interface DataConstructor {
  name: string;
  fields: BaseType[];
}

/** A structural algebraic data type definition. */
export interface DataDefinition {
  kind: "data";
  name: string;
  typeParams: string[];
  constructors: DataConstructor[];
}

export interface DataConstructorInfo {
  dataName: string;
  index: number;
  constructor: DataConstructor;
}

/** Declares the single module name for the program. */
export interface ModuleDefinition {
  kind: "module";
  name: string;
}

/** Declares an imported symbol `name` from module `ref`. */
export interface ImportDefinition {
  kind: "import";
  name: string;
  ref: string;
}

/** Marks a previously defined symbol to be exported. */
export interface ExportDefinition {
  kind: "export";
  name: string;
}

/**
 * Maps names to their definitions for both terms and types.
 */
export interface SymbolTable {
  terms: Map<string, TripLangTerm>;
  types: Map<string, TypeDefinition>;
  data: Map<string, DataDefinition>;
  constructors: Map<string, DataConstructorInfo>;
}
