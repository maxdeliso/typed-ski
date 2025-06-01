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
  | TypeDefinition;

export type TripLangDefType =
  | SystemFTerm
  | TypedLambda
  | UntypedLambda
  | SKIExpression
  | BaseType;

export interface PolyDefinition {
  kind: "poly";
  name: string;
  term: SystemFTerm;
}

export interface TypedDefinition {
  kind: "typed";
  name: string;
  type: BaseType | undefined; // note: can be inferred, but only after resolution
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

export interface SymbolTable {
  terms: AVLTree<string, TripLangTerm>;
  types: AVLTree<string, TypeDefinition>;
}
