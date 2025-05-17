import { TripLangProgram, SymbolTable, TripLangTerm } from '../trip.js';
import { indexSymbols as indexSymbolsImpl, resolveDefTerm } from './symbolTable.js';
import { elaborateTerms } from './elaboration.js';
import { resolveRefs } from './substitution.js';
import { externalReferences } from './externalReferences.js';
import { emptyAVL, createEmptyAVL, insertAVL, AVLTree } from '../../data/avl/avlNode.js';
import { parseTripLang } from '../../parser/tripLang.js';
import { typecheckSystemF } from '../../index.js';
import { BaseType } from '../../types/types.js';
import { typecheckTypedLambda } from '../../types/typedLambda.js';
import { prettyTerm } from './prettyPrint.js';
import { compareStrings } from '../../data/map/stringMap.js';

export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly stage: 'parse' | 'index' | 'elaborate' | 'resolve' | 'typecheck',
    public readonly cause?: unknown
  ) {
    let causeStr = '';
    if (cause && typeof cause === 'object') {
      const causeObj = cause as Record<string, unknown>;
      if ('term' in causeObj && causeObj.term && typeof causeObj.term === 'object') {
        causeStr = `\nTerm: ${prettyTerm(causeObj.term as TripLangTerm)}`;
      }
      if ('error' in causeObj) {
        causeStr += `\nError: ${String(causeObj.error)}`;
      }
      if ('unresolvedTerms' in causeObj || 'unresolvedTypes' in causeObj) {
        causeStr += '\nUnresolved references:';
        if ('unresolvedTerms' in causeObj) {
          causeStr += `\nTerms: ${JSON.stringify(causeObj.unresolvedTerms, null, 2)}`;
        }
        if ('unresolvedTypes' in causeObj) {
          causeStr += `\nTypes: ${JSON.stringify(causeObj.unresolvedTypes, null, 2)}`;
        }
      }
    } else if (cause !== undefined) {
      causeStr = `\nCause: ${JSON.stringify(cause)}`;
    }
    super(message + causeStr);
    this.name = 'CompilationError';
  }
}

export type ParsedProgram = TripLangProgram & { readonly __moniker: unique symbol };
export type IndexedProgram = TripLangProgram & { readonly __moniker: unique symbol };
export type ElaboratedProgram = TripLangProgram & { readonly __moniker: unique symbol };
export type ResolvedProgram = TripLangProgram & { readonly __moniker: unique symbol };
export type TypecheckedProgram = TripLangProgram & { readonly __moniker: unique symbol };

export interface ParsedProgramWithSymbols {
  program: ParsedProgram;
  symbols: SymbolTable;
  readonly __moniker: unique symbol;
}

export interface IndexedProgramWithSymbols {
  program: IndexedProgram;
  symbols: SymbolTable;
  readonly __moniker: unique symbol;
}

export interface ElaboratedProgramWithSymbols {
  program: ElaboratedProgram;
  symbols: SymbolTable;
  readonly __moniker: unique symbol;
}

export interface TypecheckedProgramWithTypes {
  program: TypecheckedProgram;
  types: AVLTree<string, BaseType>;
  readonly __moniker: unique symbol;
}

export function parse(input: string): ParsedProgram {
  const program = parseTripLang(input);
  return { ...program, __moniker: Symbol() } as ParsedProgram;
}

export function indexSymbols(
  program: ParsedProgram,
  indexFn: (program: ParsedProgram) => SymbolTable
): IndexedProgramWithSymbols {
  const symbols = indexFn(program);
  return {
    program: { ...program, __moniker: Symbol() } as IndexedProgram,
    symbols,
    __moniker: Symbol()
  } as IndexedProgramWithSymbols;
}

export function elaborate(
  programWithSymbols: IndexedProgramWithSymbols,
  elaborateFn: (programWithSymbols: IndexedProgramWithSymbols) => TripLangProgram
): ElaboratedProgramWithSymbols {
  const elaborated = elaborateFn(programWithSymbols);
  const symbols = indexSymbolsImpl(elaborated);
  return {
    program: { ...elaborated, __moniker: Symbol() } as ElaboratedProgram,
    symbols,
    __moniker: Symbol()
  } as ElaboratedProgramWithSymbols;
}

export function resolve(programWithSymbols: ElaboratedProgramWithSymbols): ResolvedProgram {
  const resolved = resolveRefs(programWithSymbols.program, programWithSymbols.symbols);

  for (const resolvedTerm of resolved.terms) {
    const defTerm = resolveDefTerm(resolvedTerm);
    const [ut, uty] = externalReferences(defTerm);
    if (!emptyAVL(ut) || !emptyAVL(uty)) {
      throw new CompilationError(
        'Unresolved external references after resolution',
        'resolve',
        { term: resolvedTerm, unresolvedTerms: ut, unresolvedTypes: uty }
      );
    }
  }

  return { ...resolved, __moniker: Symbol() } as ResolvedProgram;
}

export function typecheck(program: ResolvedProgram): TypecheckedProgramWithTypes {
  let types = createEmptyAVL<string, BaseType>();

  for (const term of program.terms) {
    try {
      switch(term.kind) {
        case 'poly':
          types = insertAVL(types, term.name, typecheckSystemF(term.term), compareStrings);
          break;
        case 'typed':
          types = insertAVL(types, term.name, typecheckTypedLambda(term.term), compareStrings);
          break;
        default:
          break;
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new CompilationError(
          'Type error during typechecking',
          'typecheck',
          { term, error: e }
        );
      }
    }
  }

  return {
    program: { ...program, __moniker: Symbol() } as TypecheckedProgram,
    types,
    __moniker: Symbol()
  } as TypecheckedProgramWithTypes;
}

export function compile(input: string): TypecheckedProgramWithTypes {
  const parsed = parse(input);
  const indexed = indexSymbols(parsed, (p) => indexSymbolsImpl(p));
  const elaborated = elaborate(indexed, (p) => elaborateTerms(p.program, p.symbols));
  const resolved = resolve(elaborated);
  return typecheck(resolved);
}
