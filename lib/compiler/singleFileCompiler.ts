/**
 * Single-File TripLang Compiler
 *
 * This module provides the core functionality for compiling a single .trip file
 * into a .tripc object file. This is Phase 1 of the TripLang module system.
 *
 * @module
 */
import { parseTripLang } from "../parser/tripLang.ts";
import { expandDataDefinitions } from "../meta/frontend/data.ts";
import { indexSymbols as indexSymbolsImpl } from "../meta/frontend/symbolTable.ts";
import { elaborateTerms } from "../meta/frontend/elaboration.ts";
import type {
  DataDefinition,
  ExportDefinition,
  ImportDefinition,
  ModuleDefinition,
  TripLangProgram,
  TripLangTerm,
} from "../meta/trip.ts";
import type { ModuleImport, TripCObject } from "./objectFile.ts";
import { serializeTripCObject } from "./objectFile.ts";
import {
  compareAscii,
  compareAsciiTuple,
  sortedStrings,
} from "../shared/canonical.ts";

/**
 * Compilation error specific to the single-file compiler
 */
export class SingleFileCompilerError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "SingleFileCompilerError";
  }
}

/**
 * Optional inputs that enrich single-file compilation with imported-module
 * metadata (for ADT constructor ordering and exhaustive match checks).
 */
export interface CompileToObjectFileOptions {
  /** Imported module objects available during compilation. */
  importedModules?: ReadonlyArray<TripCObject>;
}

type NamedDefinitionTerm = Exclude<
  TripLangTerm,
  ModuleDefinition | ImportDefinition | ExportDefinition
>;

function isNamedDefinitionTerm(
  term: TripLangTerm,
): term is NamedDefinitionTerm {
  return term.kind !== "module" && term.kind !== "import" &&
    term.kind !== "export";
}

/**
 * Extracts module information from a parsed TripLang program
 */
function extractModuleInfo(program: TripLangProgram): {
  moduleName: string;
  imports: ModuleImport[];
  exports: string[];
} {
  const moduleDefs = program.terms.filter((term): term is ModuleDefinition =>
    term.kind === "module"
  );

  if (moduleDefs.length === 0) {
    throw new SingleFileCompilerError(
      "No module definition found. Each program must have exactly one module definition.",
    );
  }

  if (moduleDefs.length > 1) {
    const moduleNames = moduleDefs.map((m) => m.name).join(", ");
    throw new SingleFileCompilerError(
      `Multiple module definitions found: ${moduleNames}. Each program must have exactly one module definition.`,
    );
  }

  const moduleName = moduleDefs[0]!.name;

  // Extract imports
  // TripLang syntax: "import <module> <symbol>" (e.g., "import Prelude zero")
  // Parser produces: {name: moduleName, ref: symbolName}
  // Object file format needs: {name: symbolName, from: moduleName}
  // So we swap: name becomes the symbol, from becomes the module
  const imports: ModuleImport[] = program.terms
    .filter((term): term is ImportDefinition => term.kind === "import")
    .map((imp) => ({ name: imp.ref, from: imp.name }))
    .sort((left, right) =>
      compareAsciiTuple([left.from, left.name], [right.from, right.name])
    );

  // Extract exports
  const exports: string[] = sortedStrings(
    program.terms
      .filter((term): term is ExportDefinition => term.kind === "export")
      .map((exp) => exp.name),
  );

  return { moduleName, imports, exports };
}

/**
 * Extracts all definitions from a parsed TripLang program
 */
function extractDefinitions(
  program: TripLangProgram,
): Record<string, TripLangTerm> {
  const definitions: Record<string, TripLangTerm> = {};
  const orderedDefinitions = program.terms
    .filter(isNamedDefinitionTerm)
    .sort((left, right) => compareAscii(left.name, right.name));

  for (const term of orderedDefinitions) {
    // Skip non-definition terms
    definitions[term.name] = term;
  }

  return definitions;
}

/**
 * Extracts structural ADT metadata from a parsed TripLang program.
 */
function extractDataDefinitions(program: TripLangProgram): DataDefinition[] {
  return program.terms.filter((term): term is DataDefinition =>
    term.kind === "data"
  ).sort((left, right) => compareAscii(left.name, right.name));
}

function buildImportedDataDefinitionsByModule(
  options: CompileToObjectFileOptions,
): Map<string, ReadonlyArray<DataDefinition>> {
  const byModule = new Map<string, ReadonlyArray<DataDefinition>>();
  const importedModules = [...(options.importedModules ?? [])].sort((
    left,
    right,
  ) => compareAscii(left.module, right.module));
  for (const moduleObject of importedModules) {
    byModule.set(moduleObject.module, moduleObject.dataDefinitions);
  }
  return byModule;
}

/**
 * Compiles a single TripLang source string to a TripCObject.
 *
 * This function implements Phase 1 of the TripLang compilation pipeline:
 * Parse → Index → Elaborate → Serialize (skips Resolution for Phase 2)
 *
 * @param source The TripLang source code
 * @returns The compiled object file
 * @throws SingleFileCompilerError if compilation fails
 */
export function compileToObjectFile(
  source: string,
  options: CompileToObjectFileOptions = {},
): TripCObject {
  try {
    // Parse the program
    const parsedProgram = expandDataDefinitions(parseTripLang(source));

    // Extract module information
    const { moduleName, imports, exports } = extractModuleInfo(parsedProgram);

    // Index symbols
    const symbolTable = indexSymbolsImpl(parsedProgram, {
      importedDataDefinitionsByModule: buildImportedDataDefinitionsByModule(
        options,
      ),
    });

    // Elaborate terms (desugaring, annotation propagation)
    const elaboratedProgram = elaborateTerms(parsedProgram, symbolTable);

    // Extract definitions from elaborated program
    const definitions = extractDefinitions(elaboratedProgram);
    const dataDefinitions = extractDataDefinitions(parsedProgram);

    // Create and return object file
    return {
      module: moduleName,
      imports,
      exports,
      definitions,
      dataDefinitions,
    };
  } catch (error) {
    if (error instanceof SingleFileCompilerError) {
      throw error;
    } else {
      throw new SingleFileCompilerError(`Compilation failed: ${error}`, error);
    }
  }
}

/**
 * Compiles a single TripLang source string to a serialized .tripc object file.
 *
 * @param source The TripLang source code
 * @returns JSON string representation of the object file
 * @throws SingleFileCompilerError if compilation fails
 */
export function compileToObjectFileString(
  source: string,
  options: CompileToObjectFileOptions = {},
): string {
  const objectFile = compileToObjectFile(source, options);
  return serializeTripCObject(objectFile);
}
