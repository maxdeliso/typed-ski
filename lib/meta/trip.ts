import { AVLTree } from '../data/avl/avlNode.js';
import { SKIExpression } from '../ski/expression.js';
import { UntypedLambda } from '../terms/lambda.js';
import { SystemFTerm } from '../terms/systemF.js';
import { TypedLambda } from '../types/typedLambda.js';
import { BaseType } from '../types/types.js';

export interface TripLangProgram {
  kind: 'program';
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
  kind: 'poly';
  name: string;
  term: SystemFTerm;
}

export interface TypedDefinition {
  kind: 'typed';
  name: string;
  type: BaseType | undefined; // note: can be inferred, but only after resolution
  term: TypedLambda;
}

export interface UntypedDefinition {
  kind: 'untyped';
  name: string;
  term: UntypedLambda;
}

export interface CombinatorDefinition {
  kind: 'combinator';
  name: string;
  term: SKIExpression;
}

export interface TypeDefinition {
  kind: 'type';
  name: string;
  type: BaseType;
}

export interface SymbolTable {
  terms: AVLTree<string, TripLangTerm>;
  types: AVLTree<string, TypeDefinition>;
}
