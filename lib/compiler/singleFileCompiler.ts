/**
 * Single-File TripLang Compiler
 *
 * This module provides the core functionality for compiling a single .trip file
 * into a .tripc object file. This is Phase 1 of the TripLang module system.
 *
 * @module
 */
import { parseTripLang } from "../parser/tripLang.ts";
import { indexSymbols as indexSymbolsImpl } from "../meta/frontend/symbolTable.ts";
import { elaborateTerms } from "../meta/frontend/elaboration.ts";
import type {
  ExportDefinition,
  ImportDefinition,
  ModuleDefinition,
  TripLangProgram,
  TripLangTerm,
} from "../meta/trip.ts";
import type { ModuleImport, TripCObject } from "./objectFile.ts";
import { serializeTripCObject } from "./objectFile.ts";

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

  const moduleName = moduleDefs[0].name;

  // Extract imports
  // TripLang syntax: "import <module> <symbol>" (e.g., "import Prelude zero")
  // Parser produces: {name: moduleName, ref: symbolName}
  // Object file format needs: {name: symbolName, from: moduleName}
  // So we swap: name becomes the symbol, from becomes the module
  const imports: ModuleImport[] = program.terms
    .filter((term): term is ImportDefinition => term.kind === "import")
    .map((imp) => ({ name: imp.ref, from: imp.name }));

  // Extract exports
  const exports: string[] = program.terms
    .filter((term): term is ExportDefinition => term.kind === "export")
    .map((exp) => exp.name);

  return { moduleName, imports, exports };
}

/**
 * Extracts all definitions from a parsed TripLang program
 */
function extractDefinitions(
  program: TripLangProgram,
): Record<string, TripLangTerm> {
  const definitions: Record<string, TripLangTerm> = {};

  for (const term of program.terms) {
    // Skip non-definition terms
    if (
      term.kind === "module" || term.kind === "import" || term.kind === "export"
    ) {
      continue;
    }

    // Extract the name from definition terms
    let name: string;
    switch (term.kind) {
      case "poly":
      case "typed":
      case "untyped":
      case "combinator":
      case "type":
        name = term.name;
        break;
      default:
        // Skip unknown term types
        continue;
    }

    definitions[name] = term;
  }

  return definitions;
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
export function compileToObjectFile(source: string): TripCObject {
  try {
    // Parse the program
    const parsedProgram = parseTripLang(source);

    // Extract module information
    const { moduleName, imports, exports } = extractModuleInfo(parsedProgram);

    // Index symbols
    const symbolTable = indexSymbolsImpl(parsedProgram);

    // Elaborate terms (desugaring, annotation propagation)
    const elaboratedProgram = elaborateTerms(parsedProgram, symbolTable);

    // Extract definitions from elaborated program
    const definitions = extractDefinitions(elaboratedProgram);

    // Create and return object file
    return {
      module: moduleName,
      imports,
      exports,
      definitions,
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
export function compileToObjectFileString(source: string): string {
  const objectFile = compileToObjectFile(source);
  return serializeTripCObject(objectFile);
}
