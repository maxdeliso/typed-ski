/**
 * TripLang compilation pipeline and error handling.
 *
 * This module provides the complete compilation pipeline for TripLang programs:
 * parse → index → elaborate → resolve → typecheck. It also defines compilation
 * errors and utility functions for working with compiled programs.
 *
 * @module
 */
import type {
  PolyDefinition,
  SymbolTable,
  TripLangProgram,
  TripLangTerm,
  TripLangValueType,
} from "../trip.ts";
import {
  extractDefinitionValue,
  indexSymbols as indexSymbolsImpl,
} from "./symbolTable.ts";
import { elaborateTerms } from "./elaboration.ts";
import { resolveExternalProgramReferences } from "./substitution.ts";
import { externalReferences } from "./externalReferences.ts";
import { parseTripLang } from "../../parser/tripLang.ts";
import { expandDataDefinitions } from "./data.ts";
import { emptySystemFContext, typecheckSystemF } from "../../types/systemF.ts";
import type { BaseType } from "../../types/types.ts";
import { typecheckTypedLambda } from "../../types/typedLambda.ts";
import { unparseTerm } from "./unparse.ts";

export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly stage:
      | "parse"
      | "index"
      | "elaborate"
      | "resolve"
      | "typecheck",
    public override readonly cause?: unknown,
  ) {
    let causeStr = "";
    if (cause && typeof cause === "object") {
      const causeObj = cause as Record<string, unknown>;
      if (
        "term" in causeObj && causeObj.term && typeof causeObj.term === "object"
      ) {
        causeStr = `\nTerm: ${unparseTerm(causeObj.term as TripLangTerm)}`;
      }
      if ("error" in causeObj) {
        causeStr += `\nError: ${String(causeObj.error)}`;
      }
      if ("unresolvedTerms" in causeObj || "unresolvedTypes" in causeObj) {
        causeStr += "\nUnresolved references:";
        if ("unresolvedTerms" in causeObj) {
          causeStr += `\nTerms: ${
            JSON.stringify(causeObj.unresolvedTerms, null, 2)
          }`;
        }
        if ("unresolvedTypes" in causeObj) {
          causeStr += `\nTypes: ${
            JSON.stringify(causeObj.unresolvedTypes, null, 2)
          }`;
        }
      }
    } else if (cause !== undefined) {
      causeStr = `\nCause: ${JSON.stringify(cause)}`;
    }
    super(message + causeStr);
    this.name = "CompilationError";
  }
}

export type ParsedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
export type IndexedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
export type ElaboratedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
export type ResolvedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
export type TypecheckedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};

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
  types: Map<string, BaseType>;
  readonly __moniker: unique symbol;
}

/**
 * Parses TripLang source into a `ParsedProgram`, validating that exactly one module is declared.
 * @throws CompilationError if zero or multiple module definitions are present
 */
export function parse(input: string): ParsedProgram {
  const program = parseTripLang(input);

  // Validate module constraints
  const moduleDefinitions = program.terms.filter((term) =>
    term.kind === "module"
  );

  if (moduleDefinitions.length === 0) {
    throw new CompilationError(
      "No module definition found. Each program must have exactly one module definition.",
      "parse",
    );
  }

  if (moduleDefinitions.length > 1) {
    const moduleNames = moduleDefinitions.map((m) => m.name).join(", ");
    throw new CompilationError(
      `Multiple module definitions found: ${moduleNames}. Each program must have exactly one module definition.`,
      "parse",
    );
  }

  const expanded = expandDataDefinitions(program);
  return { ...expanded, __moniker: Symbol() } as ParsedProgram;
}

/**
 * Runs symbol indexing for a parsed program using a provided indexing function.
 */
export function indexSymbols(
  program: ParsedProgram,
  indexFn: (program: ParsedProgram) => SymbolTable,
): IndexedProgramWithSymbols {
  const symbols = indexFn(program);
  return {
    program: { ...program, __moniker: Symbol() } as IndexedProgram,
    symbols,
    __moniker: Symbol(),
  } as IndexedProgramWithSymbols;
}

/**
 * Elaborates a program (e.g., desugaring, annotation propagation) and re-indexes symbols.
 */
export function elaborate(
  programWithSymbols: IndexedProgramWithSymbols,
  elaborateFn: (
    programWithSymbols: IndexedProgramWithSymbols,
  ) => TripLangProgram,
): ElaboratedProgramWithSymbols {
  const elaborated = elaborateFn(programWithSymbols);
  const symbols = indexSymbolsImpl(elaborated);
  return {
    program: { ...elaborated, __moniker: Symbol() } as ElaboratedProgram,
    symbols,
    __moniker: Symbol(),
  } as ElaboratedProgramWithSymbols;
}

/**
 * Resolves external references within a program, ensuring unimported references are bound.
 * @throws CompilationError when unresolved references remain after resolution
 */
export function resolve(
  programWithSymbols: ElaboratedProgramWithSymbols,
): ResolvedProgram {
  // Collect imported symbol names
  // TripLang syntax: "import <module> <symbol>" (e.g., "import Prelude zero")
  // Parser produces: {name: moduleName, ref: symbolName}
  // We track the symbol name (ref) so we can skip resolution for imported symbols
  const importedSymbols = new Set<string>();
  for (const term of programWithSymbols.program.terms) {
    if (term.kind === "import") {
      importedSymbols.add(term.ref);
    }
  }

  const resolved = resolveExternalProgramReferences(
    programWithSymbols.program,
    programWithSymbols.symbols,
  );

  for (const resolvedTerm of resolved.terms) {
    const definitionValue = extractDefinitionValue(resolvedTerm);
    if (definitionValue === undefined) {
      continue;
    }
    const [ut, uty] = externalReferences(definitionValue);

    // Check for unresolved terms that are not imported
    let unresolvedTerms = Array.from(ut.keys());
    if (resolvedTerm.kind === "poly" && resolvedTerm.rec) {
      unresolvedTerms = unresolvedTerms.filter((term) =>
        term !== resolvedTerm.name
      );
    }
    const unresolvedTypes = Array.from(uty.keys());

    const nonImportedUnresolvedTerms = unresolvedTerms.filter((term) =>
      !importedSymbols.has(term)
    );
    const nonImportedUnresolvedTypes = unresolvedTypes.filter((type) =>
      !importedSymbols.has(type)
    );

    if (
      nonImportedUnresolvedTerms.length > 0 ||
      nonImportedUnresolvedTypes.length > 0
    ) {
      // Create filtered Maps with only non-imported unresolved references
      const filteredTerms = new Map<string, TripLangValueType>();
      const filteredTypes = new Map<string, BaseType>();

      for (const term of nonImportedUnresolvedTerms) {
        const termValue = ut.get(term);
        if (termValue) {
          filteredTerms.set(term, termValue);
        }
      }

      for (const type of nonImportedUnresolvedTypes) {
        const typeValue = uty.get(type);
        if (typeValue) {
          filteredTypes.set(type, typeValue);
        }
      }

      throw new CompilationError(
        "Unresolved external references after resolution",
        "resolve",
        {
          term: resolvedTerm,
          unresolvedTerms: filteredTerms,
          unresolvedTypes: filteredTypes,
        },
      );
    }
  }

  return { ...resolved, __moniker: Symbol() } as ResolvedProgram;
}

/**
 * Typechecks System F and simply typed lambda definitions in a resolved program.
 * Skips terms that reference imported symbols which remain unresolved by design.
 * @throws CompilationError wrapping type errors with term context
 */
export function typecheck(
  program: ResolvedProgram,
): TypecheckedProgramWithTypes {
  // Collect imported symbol names
  // TripLang syntax: "import <module> <symbol>" (e.g., "import Prelude zero")
  // Parser produces: {name: moduleName, ref: symbolName}
  // We track the symbol name (ref) to skip typechecking for unresolved imported symbols
  const importedSymbols = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      importedSymbols.add(term.ref);
    }
  }

  // Build type alias map from program's type definitions
  const typeAliases = new Map<string, BaseType>();
  for (const term of program.terms) {
    if (term.kind === "type") {
      typeAliases.set(term.name, term.type);
    }
  }

  const types = new Map<string, BaseType>();

  for (const term of program.terms) {
    try {
      // Check if the term contains unresolved imported symbols
      const definitionValue = extractDefinitionValue(term);
      if (definitionValue !== undefined) {
        const [ut, uty] = externalReferences(definitionValue);
        const unresolvedTerms = Array.from(ut.keys());
        const unresolvedTypes = Array.from(uty.keys());

        // Check if any unresolved references are imported symbols
        const hasUnresolvedImportedSymbols = unresolvedTerms.some((term) =>
          importedSymbols.has(term)
        ) ||
          unresolvedTypes.some((type) => importedSymbols.has(type));

        if (hasUnresolvedImportedSymbols) {
          // Skip typechecking for terms with unresolved imported symbols
          continue;
        }
      }

      switch (term.kind) {
        case "poly":
          if (term.rec) {
            if (!term.type) {
              throw new CompilationError(
                `Recursive polymorphic definition '${term.name}' requires an explicit type annotation`,
                "typecheck",
                { term },
              );
            }
            const ctx = emptySystemFContext(typeAliases);
            ctx.termCtx.set(term.name, term.type);
            const [ty] = typecheckSystemF(ctx, term.term);
            types.set(term.name, ty);
          } else {
            const [ty] = typecheckSystemF(
              emptySystemFContext(typeAliases),
              term.term,
            );
            types.set(term.name, ty);
          }
          break;
        case "typed":
          types.set(term.name, typecheckTypedLambda(term.term));
          break;
        default:
          break;
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new CompilationError(
          "Type error during typechecking",
          "typecheck",
          { term, error: e },
        );
      }
    }
  }

  return {
    program: { ...program, __moniker: Symbol() } as TypecheckedProgram,
    types,
    __moniker: Symbol(),
  } as TypecheckedProgramWithTypes;
}

/**
 * Full TripLang pipeline: parse → index → elaborate → resolve → typecheck.
 * @param input source code for a TripLang program
 * @returns the typechecked program along with inferred types for definitions
 */
export function compile(input: string): TypecheckedProgramWithTypes {
  const parsed = parse(input);
  const indexed = indexSymbols(parsed, (p) => indexSymbolsImpl(p));
  const elaborated = elaborate(
    indexed,
    (p) => elaborateTerms(p.program, p.symbols),
  );
  const resolved = resolve(elaborated);
  return typecheck(resolved);
}

function findTerm(
  program: TripLangProgram,
  id: string,
): TripLangTerm {
  const term = program.terms.find((t) => t.name === id);
  if (!term) {
    throw new CompilationError(
      `No term named ${id} found in program`,
      "resolve",
    );
  }
  return term;
}

function assertKind<T extends TripLangTerm["kind"]>(
  term: TripLangTerm,
  expected: T,
): asserts term is Extract<TripLangTerm, { kind: T }> {
  if (term.kind !== expected) {
    throw new CompilationError(
      `Expected term '${term.name}' to be of kind '${expected}', got '${term.kind}'`,
      "resolve",
      { term },
    );
  }
}

/**
 * Resolves a polymorphic definition by name from a typechecked program.
 *
 * Looks up a definition with the given name in the program and ensures it is
 * a polymorphic (System F) definition. Throws an error if the definition
 * is not found or is not a polymorphic definition.
 *
 * @param prog the typechecked program containing the definition
 * @param id the name of the definition to resolve
 * @returns the polymorphic definition
 * @throws CompilationError if the definition is not found or not polymorphic
 */
export function resolvePoly(
  prog: TypecheckedProgramWithTypes,
  id: string,
): PolyDefinition {
  const term = findTerm(prog.program, id);
  assertKind(term, "poly");
  return term;
}

export function resolveTyped(
  prog: TypecheckedProgramWithTypes,
  id: string,
) {
  const term = findTerm(prog.program, id);
  assertKind(term, "typed");
  return term;
}

export function resolveUntyped(
  prog: TypecheckedProgramWithTypes,
  id: string,
) {
  const term = findTerm(prog.program, id);
  assertKind(term, "untyped");
  return term;
}

export function resolveCombinator(
  prog: TypecheckedProgramWithTypes,
  id: string,
) {
  const term = findTerm(prog.program, id);
  assertKind(term, "combinator");
  return term;
}
