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
  LambdaDefinition,
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
import {
  resolveExternalProgramReferences,
  resolveExternalTermReferences,
} from "./substitution.ts";
import { externalReferences } from "./externalReferences.ts";
import { parseTripLang } from "../../parser/tripLang.ts";
import { expandDataDefinitions } from "./data.ts";
import { emptySystemFContext, typecheckSystemF } from "../../types/systemF.ts";
import type { BaseType } from "../../types/types.ts";
import { CompilationError } from "./errors.ts";
import { lower } from "./termLevel.ts";

type ParsedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
type IndexedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
type ElaboratedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
type ResolvedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};
type TypecheckedProgram = TripLangProgram & {
  readonly __moniker: unique symbol;
};

interface IndexedProgramWithSymbols {
  program: IndexedProgram;
  symbols: SymbolTable;
  readonly __moniker: unique symbol;
}

interface ElaboratedProgramWithSymbols {
  program: ElaboratedProgram;
  symbols: SymbolTable;
  readonly __moniker: unique symbol;
}

interface TypecheckedProgramWithTypes {
  program: TypecheckedProgram;
  types: Map<string, BaseType>;
  readonly __moniker: unique symbol;
}

function collectImportedSymbols(program: TripLangProgram): Set<string> {
  const importedSymbols = new Set<string>();
  for (const term of program.terms) {
    if (term.kind === "import") {
      importedSymbols.add(term.ref);
    }
  }
  return importedSymbols;
}

function isRecursivePolyReference(symbols: SymbolTable, name: string): boolean {
  const term = symbols.terms.get(name);
  return term?.kind === "poly" && term.rec === true;
}

function collectRecursivePolyTypes(
  program: TripLangProgram,
): Map<string, BaseType> {
  const recursivePolyTypes = new Map<string, BaseType>();
  for (const term of program.terms) {
    if (term.kind === "poly" && term.rec && term.type) {
      recursivePolyTypes.set(term.name, term.type);
    }
  }
  return recursivePolyTypes;
}

function createSystemFTypecheckContext(
  typeAliases: Map<string, BaseType>,
  recursivePolyTypes: Map<string, BaseType>,
) {
  const ctx = emptySystemFContext(typeAliases);
  for (const [name, type] of recursivePolyTypes) {
    ctx.termCtx.set(name, type);
  }
  return ctx;
}

/**
 * Parses TripLang source into a `ParsedProgram`, validating that exactly one module is declared.
 * @throws CompilationError if zero or multiple module definitions are present
 */
function parse(input: string): ParsedProgram {
  const program = parseTripLang(input);

  // Validate module constraints
  const moduleDefinitions = program.terms.filter(
    (term) => term.kind === "module",
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
function indexSymbols(
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
function elaborate(
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
function resolve(
  programWithSymbols: ElaboratedProgramWithSymbols,
): ResolvedProgram {
  const importedSymbols = collectImportedSymbols(programWithSymbols.program);

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
      unresolvedTerms = unresolvedTerms.filter(
        (term) => term !== resolvedTerm.name,
      );
    }
    const unresolvedTypes = Array.from(uty.keys());

    const nonImportedUnresolvedTerms = unresolvedTerms.filter(
      (term) =>
        !importedSymbols.has(term) &&
        !isRecursivePolyReference(programWithSymbols.symbols, term),
    );
    const nonImportedUnresolvedTypes = unresolvedTypes.filter(
      (type) => !importedSymbols.has(type),
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
 * Typechecks System F definitions in a resolved program.
 * Skips terms that reference imported symbols which remain unresolved by design.
 * @throws CompilationError wrapping type errors with term context
 */
function typecheck(program: ResolvedProgram): TypecheckedProgramWithTypes {
  const importedSymbols = collectImportedSymbols(program);

  // Build type alias map from program's type definitions
  const typeAliases = new Map<string, BaseType>();
  for (const term of program.terms) {
    if (term.kind === "type") {
      typeAliases.set(term.name, term.type);
    }
  }
  const recursivePolyTypes = collectRecursivePolyTypes(program);

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
        const hasUnresolvedImportedSymbols =
          unresolvedTerms.some((term) => importedSymbols.has(term)) ||
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
            const ctx = createSystemFTypecheckContext(
              typeAliases,
              recursivePolyTypes,
            );
            ctx.termCtx.set(term.name, term.type);
            const [ty] = typecheckSystemF(ctx, term.term);
            types.set(term.name, ty);
          } else {
            const ctx = createSystemFTypecheckContext(
              typeAliases,
              recursivePolyTypes,
            );
            const [ty] = typecheckSystemF(ctx, term.term);
            types.set(term.name, ty);
          }
          break;
        case "native":
          types.set(term.name, term.type);
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
  const elaborated = elaborate(indexed, (p) =>
    elaborateTerms(p.program, p.symbols),
  );
  const resolved = resolve(elaborated);
  return typecheck(resolved);
}

function findTerm(program: TripLangProgram, id: string): TripLangTerm {
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
 */
export function resolvePoly(
  prog: TypecheckedProgramWithTypes,
  id: string,
): PolyDefinition {
  const term = findTerm(prog.program, id);
  assertKind(term, "poly");
  return term;
}

/**
 * Resolves a definition to the internal lambda stage, lowering recursive poly
 * references through the fixpoint encoding so the result is executable.
 */
export function resolveLambda(
  prog: TypecheckedProgramWithTypes,
  id: string,
): LambdaDefinition {
  const term = findTerm(prog.program, id);
  const lambda =
    term.kind === "lambda"
      ? term
      : term.kind === "poly"
        ? lower(term)
        : undefined;

  if (!lambda || lambda.kind !== "lambda") {
    throw new CompilationError(
      `Expected term '${id}' to resolve to kind 'lambda', got '${term.kind}'`,
      "resolve",
      { term },
    );
  }

  const symbols = indexSymbolsImpl(prog.program);
  const importedSymbols = collectImportedSymbols(prog.program);
  const resolved = resolveExternalTermReferences(
    lambda,
    symbols,
    importedSymbols,
  );

  if (resolved.kind !== "lambda") {
    throw new CompilationError(
      `Expected resolved term '${id}' to be of kind 'lambda', got '${resolved.kind}'`,
      "resolve",
      { term: resolved },
    );
  }

  return resolved;
}
