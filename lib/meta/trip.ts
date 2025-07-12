import type { AVLTree } from "../data/avl/avlNode.ts";
import type { SKIExpression } from "../ski/expression.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { BaseType } from "../types/types.ts";

export interface TripLangProgram {
  kind: "program";
  terms: TripLangTerm[];
}

export type TripLangTerm =
  | PolyDefinition
  | TypedDefinition
  | UntypedDefinition
  | CombinatorDefinition
  | TypeDefinition
  | ModuleDefinition
  | ImportDefinition
  | ExportDefinition;

export type TripLangValueType =
  | SystemFTerm
  | TypedLambda
  | UntypedLambda
  | SKIExpression
  | BaseType;

export interface PolyDefinition {
  kind: "poly";
  name: string;
  type?: BaseType;
  term: SystemFTerm;
}

export interface TypedDefinition {
  kind: "typed";
  name: string;
  type?: BaseType;
  term: TypedLambda;
}

export interface UntypedDefinition {
  kind: "untyped";
  name: string;
  term: UntypedLambda;
}

export interface CombinatorDefinition {
  kind: "combinator";
  name: string;
  term: SKIExpression;
}

export interface TypeDefinition {
  kind: "type";
  name: string;
  type: BaseType;
}

export interface ModuleDefinition {
  kind: "module";
  name: string;
}

export interface ImportDefinition {
  kind: "import";
  name: string;
  ref: string;
}

export interface ExportDefinition {
  kind: "export";
  name: string;
}

export interface SymbolTable {
  terms: AVLTree<string, TripLangTerm>;
  types: AVLTree<string, TypeDefinition>;
}
