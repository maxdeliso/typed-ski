/**
 * Symbol table management for TripLang programs.
 *
 * This module provides functionality for building and managing symbol tables
 * for TripLang programs, including indexing terms and types and extracting
 * definition values.
 *
 * @module
 */
import { unparseType } from "../../parser/type.ts";
import type { BaseType } from "../../types/types.ts";
import type {
  DataConstructorInfo,
  DataDefinition,
  SymbolTable,
  TripLangProgram,
  TripLangTerm,
  TripLangValueType,
  TypeDefinition,
} from "../trip.ts";
import { CompilationError } from "./errors.ts";

export interface IndexSymbolsOptions {
  /**
   * ADT metadata indexed by imported module name.
   * This is typically sourced from imported `.tripc` objects.
   */
  importedDataDefinitionsByModule?:
    | ReadonlyMap<string, ReadonlyArray<DataDefinition>>
    | Readonly<Record<string, ReadonlyArray<DataDefinition>>>;
}

function cloneType(type: BaseType): BaseType {
  switch (type.kind) {
    case "type-var":
      return { kind: "type-var", typeName: type.typeName };
    case "type-app":
      return {
        kind: "type-app",
        fn: cloneType(type.fn),
        arg: cloneType(type.arg),
      };
    case "forall":
      return {
        kind: "forall",
        typeVar: type.typeVar,
        body: cloneType(type.body),
      };
    case "non-terminal":
      return {
        kind: "non-terminal",
        lft: cloneType(type.lft),
        rgt: cloneType(type.rgt),
      };
  }
}

function cloneDataDefinition(dataDef: DataDefinition): DataDefinition {
  return {
    kind: "data",
    name: dataDef.name,
    typeParams: [...dataDef.typeParams],
    constructors: dataDef.constructors.map((ctor) => ({
      name: ctor.name,
      fields: ctor.fields.map(cloneType),
    })),
  };
}

function normalizeImportedDataDefinitionsByModule(
  options: IndexSymbolsOptions,
): ReadonlyMap<string, ReadonlyArray<DataDefinition>> {
  const imported = options.importedDataDefinitionsByModule;
  if (!imported) {
    return new Map();
  }
  if (imported instanceof Map) {
    return imported;
  }
  return new Map(Object.entries(imported));
}

function findDataDefinitionForImportedSymbol(
  importedDataDefinitions: ReadonlyArray<DataDefinition>,
  importedSymbol: string,
): DataDefinition | undefined {
  const direct = importedDataDefinitions.find((dataDef) =>
    dataDef.name === importedSymbol
  );
  if (direct) {
    return direct;
  }
  return importedDataDefinitions.find((dataDef) =>
    dataDef.constructors.some((ctor) => ctor.name === importedSymbol)
  );
}

function indexImportedConstructors(
  program: TripLangProgram,
  dataMap: Map<string, DataDefinition>,
  constructorMap: Map<string, DataConstructorInfo>,
  importedDataDefinitionsByModule: ReadonlyMap<
    string,
    ReadonlyArray<DataDefinition>
  >,
): void {
  for (const term of program.terms) {
    if (term.kind !== "import") {
      continue;
    }

    const importedDataDefinitions = importedDataDefinitionsByModule.get(
      term.name,
    );
    if (!importedDataDefinitions) {
      continue;
    }

    const dataDef = findDataDefinitionForImportedSymbol(
      importedDataDefinitions,
      term.ref,
    );
    if (!dataDef) {
      continue;
    }

    if (!dataMap.has(dataDef.name)) {
      dataMap.set(dataDef.name, cloneDataDefinition(dataDef));
    }

    const ctorIndex = dataDef.constructors.findIndex((ctor) =>
      ctor.name === term.ref
    );
    if (ctorIndex < 0) {
      continue;
    }

    if (constructorMap.has(term.ref)) {
      // Preserve local definitions and allow idempotent duplicate imports.
      continue;
    }

    const ctor = dataDef.constructors[ctorIndex]!;
    constructorMap.set(term.ref, {
      dataName: dataDef.name,
      index: ctorIndex,
      constructor: {
        name: ctor.name,
        fields: ctor.fields.map(cloneType),
      },
    });
  }
}

/**
 * Builds a symbol table for a TripLang program, ensuring all term and type names are unique.
 *
 * @throws CompilationError when a duplicate term or type definition is encountered
 * @param program the TripLang program
 * @returns a `SymbolTable` containing Maps of term and type definitions by name
 */
export function indexSymbols(
  program: TripLangProgram,
  options: IndexSymbolsOptions = {},
): SymbolTable {
  const termMap = new Map<string, TripLangTerm>();
  const tyMap = new Map<string, TypeDefinition>();
  const dataMap = new Map<string, DataDefinition>();
  const constructorMap = new Map<string, DataConstructorInfo>();
  const importsSet = new Set<string>();

  // First pass: collect imports
  for (const term of program.terms) {
    if (term.kind === "import") {
      importsSet.add(term.ref);
    }
  }

  // Second pass: index definitions
  for (const term of program.terms) {
    switch (term.kind) {
      case "poly":
      case "typed":
      case "untyped":
      case "combinator":
      case "native":
        {
          if (termMap.has(term.name)) {
            throw new CompilationError(
              `Duplicate definition: ${term.name}`,
              "index",
              { term },
            );
          }

          termMap.set(term.name, term);
        }
        break;
      case "type":
        {
          const typeDef = term;
          if (tyMap.has(term.name)) {
            throw new CompilationError(
              `Duplicate type: ${unparseType(typeDef.type)}`,
              "index",
              { typeDef },
            );
          }

          tyMap.set(term.name, typeDef);
        }
        break;
      case "data":
        if (dataMap.has(term.name)) {
          throw new CompilationError(
            `Duplicate data definition: ${term.name}`,
            "index",
            { term },
          );
        }
        dataMap.set(term.name, term);
        term.constructors.forEach((ctor, index) => {
          if (constructorMap.has(ctor.name)) {
            throw new CompilationError(
              `Duplicate constructor definition: ${ctor.name}`,
              "index",
              { term, ctor },
            );
          }
          constructorMap.set(ctor.name, {
            dataName: term.name,
            index,
            constructor: ctor,
          });
        });
        break;
    }
  }

  // Third pass: enrich with imported constructor metadata from .tripc files.
  indexImportedConstructors(
    program,
    dataMap,
    constructorMap,
    normalizeImportedDataDefinitionsByModule(options),
  );

  return {
    terms: termMap,
    types: tyMap,
    data: dataMap,
    constructors: constructorMap,
    imports: importsSet,
  };
}

/**
 * Extracts the value part of a TripLang definition.
 *
 * For term definitions, returns the term; for type definitions, returns the type.
 * For module/import/export declarations, returns `undefined`.
 *
 * @param tt a TripLang term/definition
 * @returns the contained value (term or type), or `undefined` if not applicable
 */
export function extractDefinitionValue(
  tt: TripLangTerm,
): TripLangValueType | undefined {
  switch (tt.kind) {
    case "poly":
    case "typed":
    case "untyped":
    case "combinator":
      return tt.term;
    case "native":
      return undefined;
    case "type":
      return tt.type;
    case "data":
      return undefined;
    case "module":
    case "import":
    case "export":
      return undefined;
  }
}
