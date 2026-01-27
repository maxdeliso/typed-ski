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
import { unparseSKI } from "../ski/expression.ts";
import { toDeBruijn } from "../meta/frontend/deBruijn.ts";

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
 * Creates the initial program space and populates global indices.
 */
function initializeProgramSpace(modules: LoadedModule[]): ProgramSpace {
  const ps: ProgramSpace = {
    modules: new Map(),
    terms: new Map(),
    types: new Map(),
    termEnv: new Map(),
    typeEnv: new Map(),
  };

  for (const module of modules) {
    ps.modules.set(module.name, module);
    ps.termEnv.set(module.name, new Map());
    ps.typeEnv.set(module.name, new Map());

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
      setGlobal(ps, qualified, definition);
    }
  }
  return ps;
}

/**
 * Validates that no symbol is exported by more than one module.
 */
function validateExports(ps: ProgramSpace): void {
  const globalExports = new Map<string, Set<string>>(); // name -> set of modules exporting it

  for (const [moduleName, module] of ps.modules) {
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
}

/**
 * Builds the local environments for each module from its imports.
 */
function buildEnvironments(ps: ProgramSpace): void {
  for (const [moduleName, module] of ps.modules) {
    const termEnv = ps.termEnv.get(moduleName)!;
    const typeEnv = ps.typeEnv.get(moduleName)!;

    for (const imp of module.imports) {
      const target = qualifiedName(imp.from, imp.name);
      const origin = ps.modules.get(imp.from);

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
      const inferredKind = inferImportKind(ps, imp.from, imp.name);

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
}

/**
 * Creates and populates a complete program space from loaded modules.
 */
export function createProgramSpace(modules: LoadedModule[]): ProgramSpace {
  const programSpace = initializeProgramSpace(modules);
  validateExports(programSpace);
  buildEnvironments(programSpace);
  return programSpace;
}

/**
 * Helper to get module info from a qualified name
 */
function getModuleInfo(ps: ProgramSpace, qualified: QualifiedName) {
  const lastDotIndex = qualified.lastIndexOf(".");
  const moduleName = qualified.slice(0, lastDotIndex);
  const localName = qualified.slice(lastDotIndex + 1);
  const module = ps.modules.get(moduleName);
  if (!module) {
    throw new Error(
      `Module '${moduleName}' not found for qualified name '${qualified}'`,
    );
  }
  return { moduleName, localName, module };
}

/**
 * Creates a deep copy of a program space to avoid mutation during resolution
 */
function deepCopyProgramSpace(ps: ProgramSpace): ProgramSpace {
  const resolvedPS: ProgramSpace = {
    modules: new Map(),
    terms: new Map(),
    types: new Map(),
    termEnv: new Map(),
    typeEnv: new Map(),
  };

  // Copy modules
  for (const [moduleName, module] of ps.modules) {
    resolvedPS.modules.set(moduleName, {
      ...module,
      defs: new Map(module.defs),
    });
  }

  // Copy global indices
  for (const [qualified, term] of ps.terms) {
    resolvedPS.terms.set(qualified, term);
  }
  for (const [qualified, type] of ps.types) {
    resolvedPS.types.set(qualified, type);
  }

  // Copy environments
  for (const [moduleName, env] of ps.termEnv) {
    resolvedPS.termEnv.set(moduleName, new Map(env));
  }
  for (const [moduleName, env] of ps.typeEnv) {
    resolvedPS.typeEnv.set(moduleName, new Map(env));
  }

  return resolvedPS;
}

const BIGINT_JSON_REPLACER = (_key: string, value: unknown) => {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  return value;
};

/**
 * Computes a stable hash for a TripLang term using canonical ordering
 */
function computeTermHash(term: TripLangTerm): string {
  const value = extractDefinitionValue(term);
  if (!value) {
    // For non-value terms like module/import/export,
    // the old stringify is fine as they have no binders.
    return JSON.stringify(term, (_key, value) => {
      if (typeof value === "bigint") {
        return `${value.toString()}n`;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) {
          sorted[k] = value[k];
        }
        return sorted;
      }
      return value;
    });
  }

  // Convert to De Bruijn representation first
  const deBruijnAST = toDeBruijn(value);

  // Now stringify the name-independent AST.
  // The simple stringify is fine; it's already canonical.
  return JSON.stringify(deBruijnAST, BIGINT_JSON_REPLACER);
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
      for (const refName of termRefs.keys()) {
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
      for (const refName of typeRefs.keys()) {
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
 * Performs iterative substitution on a single definition until no new external references appear.
 */
function substituteDependencies(
  def: TripLangTerm,
  moduleName: string,
  ps: ProgramSpace,
): TripLangTerm {
  const defValue = extractDefinitionValue(def);
  if (!defValue) return def;

  const [termRefs, typeRefs] = externalReferences(defValue);
  const externalTermRefs = Array.from(termRefs.keys());
  const externalTypeRefs = Array.from(typeRefs.keys());

  if (externalTermRefs.length === 0 && externalTypeRefs.length === 0) {
    return def;
  }

  let resolvedDefinition = def;
  const termEnv = ps.termEnv.get(moduleName)!;

  // Resolve term references iteratively until no new external references appear
  let currentExternalTermRefs = externalTermRefs;
  let iteration = 0;
  const MAX_ITERATIONS = 10; // Prevent infinite loops

  while (currentExternalTermRefs.length > 0 && iteration < MAX_ITERATIONS) {
    const nextExternalTermRefs = new Set<string>();

    for (const termRef of currentExternalTermRefs) {
      const targetQualified = termEnv.get(termRef);
      if (targetQualified) {
        const targetTerm = ps.terms.get(targetQualified);
        if (targetTerm) {
          resolvedDefinition = substituteTripLangTermDirect(
            resolvedDefinition,
            targetTerm,
            termRef,
          );
          // Check for new external references after substitution
          const [newTermRefs, _newTypeRefs] = externalReferences(
            extractDefinitionValue(resolvedDefinition)!,
          );
          const newExternalTermRefs = Array.from(newTermRefs.keys());
          newExternalTermRefs.forEach((ref) => nextExternalTermRefs.add(ref));
        }
      } else {
        // Check if it's a local definition
        const module = ps.modules.get(moduleName)!;
        if (module.defs.has(termRef)) {
          const localTerm = module.defs.get(termRef)!;
          resolvedDefinition = substituteTripLangTermDirect(
            resolvedDefinition,
            localTerm,
            termRef,
          );
          // Check for new external references after substitution
          const [newTermRefs, _newTypeRefs] = externalReferences(
            extractDefinitionValue(resolvedDefinition)!,
          );
          const newExternalTermRefs = Array.from(newTermRefs.keys());
          newExternalTermRefs.forEach((ref) => nextExternalTermRefs.add(ref));
        } else {
          // Find candidate modules that export this symbol
          const candidateModules: string[] = [];
          for (const [candidateModuleName, candidateModule] of ps.modules) {
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
            `Symbol '${termRef}' is not defined in module '${moduleName}' and is not imported${candidatesText}${fixHint}`,
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
    const nextExternalTypeRefs = new Set<string>();
    const typeEnv = ps.typeEnv.get(moduleName)!;

    for (const typeRef of currentExternalTypeRefs) {
      const targetQualified = typeEnv.get(typeRef);
      if (targetQualified) {
        const targetType = ps.types.get(targetQualified);
        if (targetType) {
          resolvedDefinition = substituteTripLangTypeDirect(
            resolvedDefinition,
            targetType,
          );
          // Check for new external references after substitution
          const [_newTermRefs, newTypeRefs] = externalReferences(
            extractDefinitionValue(resolvedDefinition)!,
          );
          const newExternalTypeRefs = Array.from(newTypeRefs.keys());
          newExternalTypeRefs.forEach((ref) => nextExternalTypeRefs.add(ref));
        }
      } else {
        // Check if it's a local type definition
        const module = ps.modules.get(moduleName)!;
        if (module.defs.has(typeRef)) {
          const localType = module.defs.get(typeRef)!;
          if (localType.kind === "type") {
            resolvedDefinition = substituteTripLangTypeDirect(
              resolvedDefinition,
              localType,
            );
            // Check for new external references after substitution
            const [_newTermRefs, newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTypeRefs = Array.from(newTypeRefs.keys());
            newExternalTypeRefs.forEach((ref) => nextExternalTypeRefs.add(ref));
          }
        } else {
          // Find candidate modules that export this type
          const candidateModules: string[] = [];
          for (const [candidateModuleName, candidateModule] of ps.modules) {
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
            `Symbol '${typeRef}' is not defined in module '${moduleName}' and is not imported${candidatesText}${fixHint}`,
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
 * Resolves a single Strongly Connected Component (SCC), iterating to a fixpoint if it's a cycle.
 */
function resolveSCC(
  scc: QualifiedName[],
  ps: ProgramSpace,
  verbose: boolean,
): void {
  if (verbose) console.error(`Processing SCC: ${scc.join(", ")}`);

  // Simple case: no cycle
  if (scc.length === 1) {
    const qualified = scc[0];
    const { moduleName, localName, module } = getModuleInfo(ps, qualified);
    const resolvedDef = substituteDependencies(
      module.defs.get(localName)!,
      moduleName,
      ps,
    );
    module.defs.set(localName, resolvedDef);
    setGlobal(ps, qualified, resolvedDef);
    return;
  }

  // Cycle case: iterate to a fixpoint
  let iteration = 0;
  const maxIterations = 100;
  while (iteration++ < maxIterations) {
    let hasChanged = false;

    // Store current definitions before iteration to avoid stale references
    const currentDefinitions = new Map<QualifiedName, TripLangTerm>();
    for (const qualified of scc) {
      const { moduleName: _moduleName, localName, module } = getModuleInfo(
        ps,
        qualified,
      );
      currentDefinitions.set(qualified, module.defs.get(localName)!);
    }

    for (const qualified of scc) {
      const { moduleName, localName, module } = getModuleInfo(ps, qualified);
      const currentDef = currentDefinitions.get(qualified)!;
      const prevHash = computeTermHash(currentDef);

      const newDef = substituteDependencies(currentDef, moduleName, ps);
      const newHash = computeTermHash(newDef);

      if (prevHash !== newHash) {
        hasChanged = true;
        module.defs.set(localName, newDef);
        setGlobal(ps, qualified, newDef);
      }
    }
    if (!hasChanged) {
      if (verbose) console.error(`SCC resolved in ${iteration} iterations.`);
      return;
    }
  }

  throw new Error(
    `Circular dependency in SCC could not be resolved: ${scc.join(", ")}`,
  );
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

  const resolvedPS = deepCopyProgramSpace(programSpace);
  const dependencyGraph = buildDependencyGraph(resolvedPS);
  const sccs = tarjanSCC(dependencyGraph).reverse(); // Topological sort

  if (verbose) {
    console.error(`Built dependency graph with ${dependencyGraph.size} nodes`);
    console.error(`Found ${sccs.length} strongly connected components`);
  }

  for (const scc of sccs) {
    resolveSCC(scc, resolvedPS, verbose);
  }

  // Sanity check: verify that all exported definitions have no external references
  for (const [moduleName, module] of resolvedPS.modules) {
    for (const exportName of module.exports) {
      const definition = module.defs.get(exportName);
      if (definition) {
        const definitionValue = extractDefinitionValue(definition);
        if (definitionValue) {
          const [termRefs, typeRefs] = externalReferences(definitionValue);
          const externalTermRefs = Array.from(termRefs.keys());
          const externalTypeRefs = Array.from(typeRefs.keys());

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
                  JSON.stringify(
                    definitionValue,
                    BIGINT_JSON_REPLACER,
                    2,
                  )
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

  return resolvedPS;
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
      const externalTermRefs = Array.from(termRefs.keys());
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
  return unparseSKI(skiExpression);
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
