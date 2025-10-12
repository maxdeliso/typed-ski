/**
 * Module Linker for TripLang
 *
 * This module implements the core linking functionality that:
 * 1. Loads multiple .tripc files into a program space
 * 2. Resolves cross-module dependencies
 * 3. Produces a single runnable SKI expression
 */

import type {
  ModuleImport as _ModuleImport,
  TripCObject,
} from "../compiler/objectFile.ts";
import type { TripLangTerm } from "../meta/trip.ts";
import { externalReferences } from "../meta/frontend/externalReferences.ts";
import { extractDefinitionValue } from "../meta/frontend/symbolTable.ts";
import { lower } from "../meta/frontend/termLevel.ts";
import {
  substituteTripLangTermDirect,
  substituteTripLangTypeDirect,
} from "../meta/frontend/substitution.ts";
import { keyValuePairs } from "../data/avl/avlNode.ts";
import { prettyPrint } from "../ski/expression.ts";

/**
 * Qualified name type for module.symbol references
 *
 * Format: "moduleName.symbolName"
 */
export type QualifiedName = string;

/**
 * Symbol identity combining module and local name
 */
export interface SymbolId {
  module: string;
  name: string;
}

/**
 * Import specification with optional alias
 */
export interface ImportSpec {
  from: string;
  name: string;
  as?: string;
  kind: "term" | "type";
}

/**
 * Represents a loaded module in the program space
 */
export interface LoadedModule {
  /** The module name */
  name: string;
  /** The TripCObject data */
  object: TripCObject;
  /** All definitions in this module, indexed by local symbol name */
  defs: Map<string, TripLangTerm>;
  /** Set of exported local names */
  exports: Set<string>;
  /** Array of imports with explicit module qualification */
  imports: ImportSpec[];
}

/**
 * Represents the global program space containing all loaded modules
 */
export interface ProgramSpace {
  /** Map from module name to loaded module */
  modules: Map<string, LoadedModule>;
  /** Global term index by qualified name */
  terms: Map<QualifiedName, TripLangTerm>;
  /** Global type index by qualified name */
  types: Map<QualifiedName, TripLangTerm>;
  /** Per-module term environment mapping local names to qualified targets */
  termEnv: Map<string, Map<string, QualifiedName>>;
  /** Per-module type environment mapping local names to qualified targets */
  typeEnv: Map<string, Map<string, QualifiedName>>;
}

/**
 * Helper function to create qualified names
 */
function qualifiedName(module: string, name: string): QualifiedName {
  return `${module}.${name}`;
}

/**
 * Helper function to set global definitions respecting kind (term vs type)
 */
function setGlobal(ps: ProgramSpace, q: QualifiedName, def: TripLangTerm) {
  if (def.kind === "type") ps.types.set(q, def);
  else ps.terms.set(q, def);
}

/**
 * Infers import kind from origin module's exports
 */
function inferImportKind(
  ps: ProgramSpace,
  from: string,
  name: string,
): "term" | "type" {
  const q = qualifiedName(from, name);
  if (ps.types.has(q)) {
    return "type";
  }
  if (ps.terms.has(q)) {
    return "term";
  }
  throw new Error(`No symbol '${q}' to import`);
}

/**
 * Loads a TripCObject into the program space
 */
export function loadModule(
  object: TripCObject,
  moduleName: string,
): LoadedModule {
  const defs = new Map<string, TripLangTerm>();
  for (const [name, def] of Object.entries(object.definitions)) {
    defs.set(name, def);
  }

  const exports = new Set(object.exports);

  // Convert imports to ImportSpec format
  const imports: ImportSpec[] = object.imports.map((imp) => ({
    from: imp.from,
    name: imp.name,
    as: imp.name, // Default alias is the same as the name
    kind: "term" as const, // Will be inferred later in createProgramSpace
  }));

  return {
    name: moduleName,
    object,
    defs,
    exports,
    imports,
  };
}

/**
 * Creates a program space from multiple loaded modules
 */
export function createProgramSpace(modules: LoadedModule[]): ProgramSpace {
  const programSpace: ProgramSpace = {
    modules: new Map(),
    terms: new Map(),
    types: new Map(),
    termEnv: new Map(),
    typeEnv: new Map(),
  };

  // Load all modules into the program space
  for (const module of modules) {
    programSpace.modules.set(module.name, module);

    // Initialize per-module environments
    programSpace.termEnv.set(module.name, new Map());
    programSpace.typeEnv.set(module.name, new Map());

    // Check for duplicate local definitions within the module
    const seenDefs = new Set<string>();
    for (const [localName, _definition] of module.defs) {
      if (seenDefs.has(localName)) {
        throw new Error(
          `Duplicate definition '${localName}' in module '${module.name}'`,
        );
      }
      seenDefs.add(localName);
    }

    // Add all definitions to the global qualified indices
    for (const [localName, definition] of module.defs) {
      const qualified = qualifiedName(module.name, localName);
      const definitionValue = extractDefinitionValue(definition);

      if (definitionValue) {
        if (definition.kind === "type") {
          programSpace.types.set(qualified, definition);
        } else {
          programSpace.terms.set(qualified, definition);
        }
      }
    }
  }

  // Validate exports and detect duplicates
  const globalExports = new Map<string, Set<string>>(); // name -> set of modules exporting it

  for (const [moduleName, module] of programSpace.modules) {
    for (const exportName of module.exports) {
      if (!globalExports.has(exportName)) {
        globalExports.set(exportName, new Set());
      }
      globalExports.get(exportName)!.add(moduleName);
    }
  }

  // Check for duplicate exports across modules
  for (const [exportName, exportingModules] of globalExports) {
    if (exportingModules.size > 1) {
      const modules = Array.from(exportingModules).join(", ");
      throw new Error(
        `Ambiguous export '${exportName}' found in multiple modules: ${modules}. Use qualified imports or rename exports.`,
      );
    }
  }

  // Build per-module environments from imports (validate exports and infer kinds)
  for (const [moduleName, module] of programSpace.modules) {
    const termEnv = programSpace.termEnv.get(moduleName)!;
    const typeEnv = programSpace.typeEnv.get(moduleName)!;

    for (const imp of module.imports) {
      const target = qualifiedName(imp.from, imp.name);
      const origin = programSpace.modules.get(imp.from);

      if (!origin) {
        throw new Error(
          `Module '${imp.from}' not found (imported by '${moduleName}')`,
        );
      }

      if (!origin.exports.has(imp.name)) {
        throw new Error(
          `'${target}' is not exported but imported by '${moduleName}'`,
        );
      }

      // Infer import kind from origin module's exports
      const inferredKind = inferImportKind(programSpace, imp.from, imp.name);

      // Update the import spec with inferred kind
      imp.kind = inferredKind;

      const localName = imp.as ?? imp.name;

      if (imp.kind === "term") {
        if (termEnv.has(localName)) {
          throw new Error(
            `Duplicate import '${localName}' in module '${moduleName}'`,
          );
        }
        termEnv.set(localName, target);
      } else {
        if (typeEnv.has(localName)) {
          throw new Error(
            `Duplicate import '${localName}' in module '${moduleName}'`,
          );
        }
        typeEnv.set(localName, target);
      }
    }
  }

  return programSpace;
}

/**
 * Computes a stable hash for a TripLang term using canonical ordering
 */
function computeTermHash(term: TripLangTerm): string {
  // Create a canonical representation with sorted object keys
  const canonical = JSON.stringify(term, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Sort object keys for consistent ordering
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });

  // TODO: Move to α-normalized structural hashing later to avoid pointless toggling under renames
  // Simple hash - in production, use a proper hash function like murmur3
  return canonical;
}

/**
 * Builds dependency graph for resolution
 */
function buildDependencyGraph(
  programSpace: ProgramSpace,
): Map<QualifiedName, Set<QualifiedName>> {
  const graph = new Map<QualifiedName, Set<QualifiedName>>();

  // Initialize graph with all qualified definitions
  for (const [qualified, _] of programSpace.terms) {
    graph.set(qualified, new Set());
  }
  for (const [qualified, _] of programSpace.types) {
    graph.set(qualified, new Set());
  }

  // Add edges based on external references
  for (const [moduleName, module] of programSpace.modules) {
    const termEnv = programSpace.termEnv.get(moduleName)!;
    const typeEnv = programSpace.typeEnv.get(moduleName)!;

    for (const [localName, definition] of module.defs) {
      const definitionValue = extractDefinitionValue(definition);
      if (!definitionValue) continue;

      const currentQualified = qualifiedName(moduleName, localName);
      const [termRefs, typeRefs] = externalReferences(definitionValue);

      // Add term dependencies
      for (const [refName, _] of keyValuePairs(termRefs)) {
        // Check for external imports first
        const targetQualified = termEnv.get(refName);
        if (targetQualified) {
          graph.get(currentQualified)?.add(targetQualified);
        } else {
          // Check for local definitions within the same module
          const localTarget = module.defs.has(refName)
            ? qualifiedName(moduleName, refName)
            : undefined;
          if (localTarget) {
            graph.get(currentQualified)?.add(localTarget);
          }
        }
      }

      // Add type dependencies
      for (const [refName, _] of keyValuePairs(typeRefs)) {
        // Check for external imports first
        const targetQualified = typeEnv.get(refName);
        if (targetQualified) {
          graph.get(currentQualified)?.add(targetQualified);
        } else {
          // Check for local type definitions within the same module
          const localTypeTarget = qualifiedName(moduleName, refName);
          if (programSpace.types.has(localTypeTarget)) {
            graph.get(currentQualified)?.add(localTypeTarget);
          }
        }
      }
    }
  }

  return graph;
}

/**
 * Tarjan's algorithm for finding strongly connected components
 */
function tarjanSCC(
  graph: Map<QualifiedName, Set<QualifiedName>>,
): QualifiedName[][] {
  const index = new Map<QualifiedName, number>();
  const lowlink = new Map<QualifiedName, number>();
  const onStack = new Set<QualifiedName>();
  const stack: QualifiedName[] = [];
  const sccs: QualifiedName[][] = [];
  let currentIndex = 0;

  function strongconnect(node: QualifiedName): void {
    index.set(node, currentIndex);
    lowlink.set(node, currentIndex);
    currentIndex++;
    stack.push(node);
    onStack.add(node);

    const deps = graph.get(node) || new Set();
    for (const dep of deps) {
      if (!index.has(dep)) {
        strongconnect(dep);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(dep)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const scc: QualifiedName[] = [];
      let w: QualifiedName;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== node);
      sccs.push(scc);
    }
  }

  for (const node of graph.keys()) {
    if (!index.has(node)) {
      strongconnect(node);
    }
  }

  return sccs;
}

/**
 * Resolves cross-module dependencies using dependency graph fixpoint algorithm
 */
export function resolveCrossModuleDependencies(
  programSpace: ProgramSpace,
  verbose = false,
): ProgramSpace {
  if (verbose) {
    console.error("Resolving cross-module dependencies...");
  }

  // Deep copy the program space
  const resolvedProgramSpace: ProgramSpace = {
    modules: new Map(),
    terms: new Map(),
    types: new Map(),
    termEnv: new Map(),
    typeEnv: new Map(),
  };

  // Copy modules
  for (const [moduleName, module] of programSpace.modules) {
    resolvedProgramSpace.modules.set(moduleName, {
      ...module,
      defs: new Map(module.defs),
    });
  }

  // Copy global indices
  for (const [qualified, term] of programSpace.terms) {
    resolvedProgramSpace.terms.set(qualified, term);
  }
  for (const [qualified, type] of programSpace.types) {
    resolvedProgramSpace.types.set(qualified, type);
  }

  // Copy environments
  for (const [moduleName, env] of programSpace.termEnv) {
    resolvedProgramSpace.termEnv.set(moduleName, new Map(env));
  }
  for (const [moduleName, env] of programSpace.typeEnv) {
    resolvedProgramSpace.typeEnv.set(moduleName, new Map(env));
  }

  // Build dependency graph
  const dependencyGraph = buildDependencyGraph(resolvedProgramSpace);

  if (verbose) {
    console.error(`Built dependency graph with ${dependencyGraph.size} nodes`);
  }

  // Tarjan's SCC algorithm - reverse to get topological order
  const sccs = tarjanSCC(dependencyGraph).reverse();

  if (verbose) {
    console.error(`Found ${sccs.length} strongly connected components`);
  }

  // Process each SCC
  for (const scc of sccs) {
    if (verbose) {
      console.error(`Processing SCC: ${scc.join(", ")}`);
    }

    // For single nodes, resolve once
    if (scc.length === 1) {
      const qualified = scc[0];
      const lastDotIndex = qualified.lastIndexOf(".");
      const moduleName = qualified.slice(0, lastDotIndex);
      const localName = qualified.slice(lastDotIndex + 1);
      const module = resolvedProgramSpace.modules.get(moduleName)!;
      const definition = module.defs.get(localName)!;

      const resolvedDef = resolveDefinitionOnce(
        definition,
        moduleName,
        resolvedProgramSpace,
        verbose,
      );
      module.defs.set(localName, resolvedDef);
      setGlobal(resolvedProgramSpace, qualified, resolvedDef);
    } else {
      // For cycles, iterate until fixpoint
      const prevHashes = new Map<QualifiedName, string>();
      let iteration = 0;
      const maxIterations = 100; // Reasonable limit for cycles

      // Initialize hashes
      for (const qualified of scc) {
        const lastDotIndex = qualified.lastIndexOf(".");
        const moduleName = qualified.slice(0, lastDotIndex);
        const localName = qualified.slice(lastDotIndex + 1);
        const definition = resolvedProgramSpace.modules.get(moduleName)!.defs
          .get(localName)!;
        prevHashes.set(qualified, computeTermHash(definition));
      }

      while (iteration < maxIterations) {
        let changed = false;
        iteration++;

        if (verbose) {
          console.error(`  SCC iteration ${iteration}`);
        }

        for (const qualified of scc) {
          const lastDotIndex = qualified.lastIndexOf(".");
          const moduleName = qualified.slice(0, lastDotIndex);
          const localName = qualified.slice(lastDotIndex + 1);
          const module = resolvedProgramSpace.modules.get(moduleName)!;
          const definition = module.defs.get(localName)!;

          const resolvedDef = resolveDefinitionOnce(
            definition,
            moduleName,
            resolvedProgramSpace,
            verbose,
          );
          const newHash = computeTermHash(resolvedDef);

          if (newHash !== prevHashes.get(qualified)) {
            changed = true;
            module.defs.set(localName, resolvedDef);
            setGlobal(resolvedProgramSpace, qualified, resolvedDef);
            prevHashes.set(qualified, newHash);
          }
        }

        if (!changed) break;
      }

      if (iteration >= maxIterations) {
        throw new Error(
          `Circular dependency detected in SCC: ${
            scc.join(", ")
          }. Consider using explicit recursion constructs.`,
        );
      }

      if (verbose) {
        console.error(`SCC resolved in ${iteration} iterations`);
      }
    }
  }

  // Sanity check: verify that all exported definitions have no external references
  for (const [moduleName, module] of resolvedProgramSpace.modules) {
    for (const exportName of module.exports) {
      const definition = module.defs.get(exportName);
      if (definition) {
        const definitionValue = extractDefinitionValue(definition);
        if (definitionValue) {
          const [termRefs, typeRefs] = externalReferences(definitionValue);
          const externalTermRefs = keyValuePairs(termRefs).map((kvp) => kvp[0]);
          const externalTypeRefs = keyValuePairs(typeRefs).map((kvp) => kvp[0]);

          if (externalTermRefs.length > 0 || externalTypeRefs.length > 0) {
            console.warn(
              `Warning: Exported definition '${
                qualifiedName(moduleName, exportName)
              }' still has external references: terms=[${
                externalTermRefs.join(", ")
              }], types=[${externalTypeRefs.join(", ")}]`,
            );
            if (verbose) {
              console.error(
                `  Definition value: ${
                  JSON.stringify(definitionValue, null, 2)
                }`,
              );
            }
          }
        }
      }
    }
  }

  if (verbose) {
    console.error("Cross-module resolution completed");
  }

  return resolvedProgramSpace;
}

/**
 * Resolves a single definition once using the current program space
 */
function resolveDefinitionOnce(
  definition: TripLangTerm,
  moduleName: string,
  programSpace: ProgramSpace,
  _verbose = false,
): TripLangTerm {
  const definitionValue = extractDefinitionValue(definition);
  if (!definitionValue) {
    return definition;
  }

  const [termRefs, typeRefs] = externalReferences(definitionValue);
  const externalTermRefs = keyValuePairs(termRefs).map((kvp) => kvp[0]);
  const externalTypeRefs = keyValuePairs(typeRefs).map((kvp) => kvp[0]);

  if (_verbose && externalTermRefs.length > 0) {
    console.error(
      `  Definition has external references: ${externalTermRefs.join(", ")}`,
    );
  }

  if (externalTermRefs.length === 0 && externalTypeRefs.length === 0) {
    return definition;
  }

  const termEnv = programSpace.termEnv.get(moduleName)!;

  if (_verbose && externalTermRefs.length > 0) {
    console.error(
      `  Term environment contains: ${Array.from(termEnv.keys()).join(", ")}`,
    );
    console.error(
      `  Program space terms: ${
        Array.from(programSpace.terms.keys()).join(", ")
      }`,
    );
  }

  let resolvedDefinition = definition;

  // Resolve term references iteratively until no new external references appear
  let currentExternalTermRefs = externalTermRefs;
  let iteration = 0;
  const MAX_ITERATIONS = 10; // Prevent infinite loops

  while (currentExternalTermRefs.length > 0 && iteration < MAX_ITERATIONS) {
    if (_verbose && iteration > 0) {
      console.error(
        `  Iteration ${iteration}: resolving ${currentExternalTermRefs.length} external references: ${
          currentExternalTermRefs.join(", ")
        }`,
      );
    }

    const nextExternalTermRefs = new Set<string>();

    for (const termRef of currentExternalTermRefs) {
      const targetQualified = termEnv.get(termRef);
      if (targetQualified) {
        const targetTerm = programSpace.terms.get(targetQualified);
        if (targetTerm) {
          if (_verbose) {
            console.error(
              `Resolving external reference '${termRef}' -> '${targetQualified}'`,
            );
            console.error(
              `  Before substitution: ${
                JSON.stringify(
                  extractDefinitionValue(resolvedDefinition),
                  null,
                  2,
                )
              }`,
            );
          }
          resolvedDefinition = substituteTripLangTermDirect(
            resolvedDefinition,
            targetTerm,
            termRef,
          );
          if (_verbose) {
            console.error(
              `  After substitution: ${
                JSON.stringify(
                  extractDefinitionValue(resolvedDefinition),
                  null,
                  2,
                )
              }`,
            );
            // Check for new external references after substitution
            const [newTermRefs, _newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTermRefs = keyValuePairs(newTermRefs).map((kvp) =>
              kvp[0]
            );
            if (newExternalTermRefs.length > 0) {
              console.error(
                `  New external references after substitution: ${
                  newExternalTermRefs.join(", ")
                }`,
              );
              newExternalTermRefs.forEach((ref) =>
                nextExternalTermRefs.add(ref)
              );
            }
          } else {
            // Always check for new external references, even without verbose logging
            const [newTermRefs, _newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTermRefs = keyValuePairs(newTermRefs).map((kvp) =>
              kvp[0]
            );
            newExternalTermRefs.forEach((ref) => nextExternalTermRefs.add(ref));
          }
        } else {
          if (_verbose) {
            console.error(
              `Warning: target term '${targetQualified}' not found in program space`,
            );
          }
        }
      } else {
        // Check if it's a local definition
        const module = programSpace.modules.get(moduleName)!;
        if (module.defs.has(termRef)) {
          const localTerm = module.defs.get(termRef)!;
          if (_verbose) {
            console.error(`Resolving local reference '${termRef}'`);
            console.error(
              `  Before substitution: ${
                JSON.stringify(
                  extractDefinitionValue(resolvedDefinition),
                  null,
                  2,
                )
              }`,
            );
          }
          resolvedDefinition = substituteTripLangTermDirect(
            resolvedDefinition,
            localTerm,
            termRef,
          );
          if (_verbose) {
            console.error(
              `  After substitution: ${
                JSON.stringify(
                  extractDefinitionValue(resolvedDefinition),
                  null,
                  2,
                )
              }`,
            );
            // Check for new external references after substitution
            const [newTermRefs, _newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTermRefs = keyValuePairs(newTermRefs).map((kvp) =>
              kvp[0]
            );
            if (newExternalTermRefs.length > 0) {
              console.error(
                `  New external references after substitution: ${
                  newExternalTermRefs.join(", ")
                }`,
              );
              newExternalTermRefs.forEach((ref) =>
                nextExternalTermRefs.add(ref)
              );
            }
          } else {
            // Always check for new external references, even without verbose logging
            const [newTermRefs, _newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTermRefs = keyValuePairs(newTermRefs).map((kvp) =>
              kvp[0]
            );
            newExternalTermRefs.forEach((ref) => nextExternalTermRefs.add(ref));
          }
        } else {
          if (_verbose) {
            console.error(
              `Warning: reference '${termRef}' not found in term environment or local definitions`,
            );
            console.error(
              `  Available in termEnv: ${
                Array.from(termEnv.keys()).join(", ")
              }`,
            );
            console.error(
              `  Available in module.defs: ${
                Array.from(module.defs.keys()).join(", ")
              }`,
            );
          }
          // Find candidate modules that export this symbol
          const candidateModules: string[] = [];
          for (
            const [candidateModuleName, candidateModule] of programSpace.modules
          ) {
            if (candidateModule.exports.has(termRef)) {
              candidateModules.push(candidateModuleName);
            }
          }

          const candidatesText = candidateModules.length > 0
            ? ` (candidate modules: ${candidateModules.join(", ")})`
            : " (no modules export this symbol)";

          const fixHint = candidateModules.length > 0
            ? ` To fix: add 'import ${
              candidateModules[0]
            } ${termRef}' or use qualified name '${
              candidateModules[0]
            }.${termRef}'.`
            : "";

          throw new Error(
            `Unresolved term symbol '${termRef}' in module '${moduleName}'${candidatesText}${fixHint}`,
          );
        }
      }
    }

    // Update for next iteration
    currentExternalTermRefs = [...nextExternalTermRefs];
    iteration++;
  }

  if (iteration >= MAX_ITERATIONS) {
    throw new Error(
      `Too many iterations (${iteration}) resolving external references for definition - possible circular dependency`,
    );
  }

  // Resolve type references iteratively until no new external references appear
  let currentExternalTypeRefs = externalTypeRefs;
  let typeIteration = 0;
  const MAX_TYPE_ITERATIONS = 10; // Prevent infinite loops

  while (
    currentExternalTypeRefs.length > 0 && typeIteration < MAX_TYPE_ITERATIONS
  ) {
    if (_verbose && typeIteration > 0) {
      console.error(
        `  Type iteration ${typeIteration}: resolving ${currentExternalTypeRefs.length} external type references: ${
          currentExternalTypeRefs.join(", ")
        }`,
      );
    }

    const nextExternalTypeRefs = new Set<string>();
    const typeEnv = programSpace.typeEnv.get(moduleName)!;

    for (const typeRef of currentExternalTypeRefs) {
      const targetQualified = typeEnv.get(typeRef);
      if (targetQualified) {
        const targetType = programSpace.types.get(targetQualified);
        if (targetType) {
          if (_verbose) {
            console.error(
              `Resolving external type reference '${typeRef}' -> '${targetQualified}'`,
            );
          }
          resolvedDefinition = substituteTripLangTypeDirect(
            resolvedDefinition,
            targetType,
          );
          // Check for new external references after substitution
          const [_newTermRefs, newTypeRefs] = externalReferences(
            extractDefinitionValue(resolvedDefinition)!,
          );
          const newExternalTypeRefs = keyValuePairs(newTypeRefs).map((kvp) =>
            kvp[0]
          );
          newExternalTypeRefs.forEach((ref) => nextExternalTypeRefs.add(ref));
        } else {
          if (_verbose) {
            console.error(
              `Warning: target type '${targetQualified}' not found in program space`,
            );
          }
        }
      } else {
        // Check if it's a local type definition
        const module = programSpace.modules.get(moduleName)!;
        if (module.defs.has(typeRef)) {
          const localType = module.defs.get(typeRef)!;
          if (localType.kind === "type") {
            if (_verbose) {
              console.error(`Resolving local type reference '${typeRef}'`);
            }
            resolvedDefinition = substituteTripLangTypeDirect(
              resolvedDefinition,
              localType,
            );
            // Check for new external references after substitution
            const [_newTermRefs, newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTypeRefs = keyValuePairs(newTypeRefs).map((kvp) =>
              kvp[0]
            );
            newExternalTypeRefs.forEach((ref) => nextExternalTypeRefs.add(ref));
          }
        } else {
          // Find candidate modules that export this type
          const candidateModules: string[] = [];
          for (
            const [candidateModuleName, candidateModule] of programSpace.modules
          ) {
            if (candidateModule.exports.has(typeRef)) {
              candidateModules.push(candidateModuleName);
            }
          }

          const candidatesText = candidateModules.length > 0
            ? ` (candidate modules: ${candidateModules.join(", ")})`
            : " (no modules export this type)";

          const fixHint = candidateModules.length > 0
            ? ` To fix: add 'import ${
              candidateModules[0]
            } ${typeRef}' or use qualified name '${
              candidateModules[0]
            }.${typeRef}'.`
            : "";

          throw new Error(
            `Unresolved type symbol '${typeRef}' in module '${moduleName}'${candidatesText}${fixHint}`,
          );
        }
      }
    }

    // Update for next iteration
    currentExternalTypeRefs = [...nextExternalTypeRefs];
    typeIteration++;
  }

  if (typeIteration >= MAX_TYPE_ITERATIONS) {
    throw new Error(
      `Too many iterations (${typeIteration}) resolving external type references for definition - possible circular dependency`,
    );
  }

  return resolvedDefinition;
}

/**
 * Finds the main function in the program space
 */
export function findMainFunction(
  programSpace: ProgramSpace,
): TripLangTerm | null {
  // Look for exactly one exported main function
  const mainCandidates: TripLangTerm[] = [];

  for (const [_moduleName, module] of programSpace.modules) {
    if (module.exports.has("main") && module.defs.has("main")) {
      const mainDef = module.defs.get("main")!;
      mainCandidates.push(mainDef);
    }
  }

  if (mainCandidates.length === 0) {
    return null;
  }

  if (mainCandidates.length > 1) {
    throw new Error(
      `Multiple 'main' functions found across modules. Expected exactly one exported 'main'.`,
    );
  }

  const main = mainCandidates[0];
  if (main.kind === "type") {
    throw new Error("Exported 'main' is a type; expected a term/function.");
  }

  return main;
}

/**
 * Lowers a TripLang term through the pipeline to produce SKI expression
 */
export function lowerToSKI(term: TripLangTerm, verbose = false): string {
  if (verbose) {
    console.error("Lowering main function through the pipeline...");
  }

  let current = term;
  let level = 0;
  const MAX_LEVELS = 3; // poly→typed→untyped→comb suggests ≤3 unless lowering can re-introduce higher levels

  // Lower through the pipeline: poly -> typed -> untyped -> combinator
  while (current.kind !== "combinator") {
    if (verbose) {
      console.error(`  Level ${level}: ${current.kind} -> lowering...`);
    }

    // Debug: check for external references before lowering
    if (verbose && current.kind === "untyped") {
      const [termRefs, _typeRefs] = externalReferences(current.term);
      const externalTermRefs = keyValuePairs(termRefs).map((kvp) => kvp[0]);
      if (externalTermRefs.length > 0) {
        console.error(
          `  Warning: untyped term still has external references: ${
            externalTermRefs.join(", ")
          }`,
        );
      }
    }

    current = lower(current);
    level++;

    // Safety check to prevent infinite loops
    if (level > MAX_LEVELS) {
      throw new Error(
        `Too many lowering steps (${level}) - possible circular dependency or lowering re-introducing higher levels`,
      );
    }
  }

  if (verbose) {
    console.error(`  Final level: ${current.kind}`);
  }

  // Extract the SKI expression and pretty print it
  const skiExpression = current.term;
  return prettyPrint(skiExpression);
}

/**
 * Main linking function that orchestrates the entire process
 */
export function linkModules(
  modules: Array<{ name: string; object: TripCObject }>,
  verbose = false,
): string {
  if (verbose) {
    console.error(`Linking ${modules.length} modules...`);
  }

  // Step 1: Load modules into program space
  const loadedModules = modules.map(({ name, object }) =>
    loadModule(object, name)
  );
  let programSpace = createProgramSpace(loadedModules);

  if (verbose) {
    const totalSymbols = programSpace.terms.size + programSpace.types.size;
    console.error(
      `Loaded ${programSpace.modules.size} modules with ${totalSymbols} total symbols`,
    );
  }

  // Step 2: Resolve cross-module dependencies
  programSpace = resolveCrossModuleDependencies(programSpace, verbose);

  // Step 3: Find the main function
  const mainFunction = findMainFunction(programSpace);
  if (!mainFunction) {
    throw new Error("No 'main' function found in any of the modules");
  }

  if (verbose) {
    console.error("Found main function, lowering to SKI...");
  }

  // Step 4: Lower main function to SKI expression
  const skiExpression = lowerToSKI(mainFunction, verbose);

  if (verbose) {
    console.error("Linking complete!");
  }

  return skiExpression;
}
