import { AVLTree } from "../data/avl/avlNode.ts";
import { SKIExpression } from "../ski/expression.ts";
import { UntypedLambda } from "../terms/lambda.ts";
import { SystemFTerm } from "../terms/systemF.ts";
import { TypedLambda } from "../types/typedLambda.ts";
import { BaseType } from "../types/types.ts";

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
