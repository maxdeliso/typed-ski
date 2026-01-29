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
import type { TripLangTerm, TripLangValueType } from "../meta/trip.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import type { TypedLambda } from "../types/typedLambda.ts";
import type { UntypedLambda } from "../terms/lambda.ts";
import { externalReferences } from "../meta/frontend/externalReferences.ts";
import { extractDefinitionValue } from "../meta/frontend/symbolTable.ts";
import { lower } from "../meta/frontend/termLevel.ts";
import {
  freeTermVars,
  substituteTermHygienicBatch,
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
 * Caches results to avoid repeated string operations
 */
const moduleInfoCache = new Map<QualifiedName, {
  moduleName: string;
  localName: string;
  module: LoadedModule;
}>();

function getModuleInfo(ps: ProgramSpace, qualified: QualifiedName) {
  const cached = moduleInfoCache.get(qualified);
  if (cached) {
    // Verify module still exists (should always be true, but be safe)
    if (ps.modules.has(cached.moduleName)) {
      return cached;
    }
  }

  const lastDotIndex = qualified.lastIndexOf(".");
  const moduleName = qualified.slice(0, lastDotIndex);
  const localName = qualified.slice(lastDotIndex + 1);
  const module = ps.modules.get(moduleName);
  if (!module) {
    throw new Error(
      `Module '${moduleName}' not found for qualified name '${qualified}'`,
    );
  }
  const result = { moduleName, localName, module };
  moduleInfoCache.set(qualified, result);
  return result;
}

/**
 * Clears the module info cache - call this when starting a new linking operation
 */
function clearModuleInfoCache(): void {
  moduleInfoCache.clear();
}

/**
 * Creates a shallow copy of program space structure, but shares module definitions
 * to avoid expensive deep copying. Definitions are mutated in-place during resolution.
 */
function shallowCopyProgramSpace(ps: ProgramSpace): ProgramSpace {
  const resolvedPS: ProgramSpace = {
    modules: new Map(),
    terms: new Map(ps.terms), // Shallow copy - terms will be updated
    types: new Map(ps.types), // Shallow copy - types will be updated
    termEnv: new Map(),
    typeEnv: new Map(),
  };

  // Copy modules - share the defs Map but we'll mutate it
  for (const [moduleName, module] of ps.modules) {
    resolvedPS.modules.set(moduleName, {
      ...module,
      defs: new Map(module.defs), // Only copy the defs map structure
    });
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
 * Tarjan's algorithm for finding strongly connected components (iterative version)
 * Avoids recursion stack overflow and is more efficient
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

  // Iterative stack-based implementation
  const workStack: Array<{
    node: QualifiedName;
    phase: "enter" | "process";
    deps?: QualifiedName[];
    depIndex?: number;
  }> = [];

  for (const node of graph.keys()) {
    if (index.has(node)) continue;

    workStack.push({ node, phase: "enter" });

    while (workStack.length > 0) {
      const work = workStack.pop()!;

      if (work.phase === "enter") {
        // First visit to this node
        index.set(work.node, currentIndex);
        lowlink.set(work.node, currentIndex);
        currentIndex++;
        stack.push(work.node);
        onStack.add(work.node);

        const deps = Array.from(graph.get(work.node) || []);
        workStack.push({
          node: work.node,
          phase: "process",
          deps,
          depIndex: 0,
        });
      } else {
        // Processing dependencies
        const deps = work.deps!;
        let depIndex = work.depIndex!;

        while (depIndex < deps.length) {
          const dep = deps[depIndex];
          if (!index.has(dep)) {
            // Recurse into dependency
            workStack.push({
              node: work.node,
              phase: "process",
              deps,
              depIndex: depIndex + 1,
            });
            workStack.push({ node: dep, phase: "enter" });
            break;
          } else if (onStack.has(dep)) {
            lowlink.set(
              work.node,
              Math.min(lowlink.get(work.node)!, index.get(dep)!),
            );
          }
          depIndex++;
        }

        if (depIndex >= deps.length) {
          // Finished processing all dependencies
          if (lowlink.get(work.node) === index.get(work.node)) {
            const scc: QualifiedName[] = [];
            let w: QualifiedName;
            do {
              w = stack.pop()!;
              onStack.delete(w);
              scc.push(w);
            } while (w !== work.node);
            sccs.push(scc);
          }
          // Update parent's lowlink if we have a parent
          if (workStack.length > 0) {
            const parent = workStack[workStack.length - 1];
            if (parent.phase === "process") {
              lowlink.set(
                parent.node,
                Math.min(lowlink.get(parent.node)!, lowlink.get(work.node)!),
              );
            }
          }
        }
      }
    }
  }

  return sccs;
}

/**
 * Performs iterative substitution on a single definition until no new external references appear.
 * Uses export index for fast candidate module lookup.
 */
function substituteDependencies(
  def: TripLangTerm,
  moduleName: string,
  localName: string,
  ps: ProgramSpace,
  exportIndex: Map<string, Set<string>>,
  verbose = false,
): TripLangTerm {
  const defValue = extractDefinitionValue(def);
  if (!defValue) return def;

  // Cache external references computation
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
  if (resolvedDefinition.kind === "poly" && resolvedDefinition.rec) {
    currentExternalTermRefs = currentExternalTermRefs.filter((ref) =>
      ref !== localName
    );
  }
  let iteration = 0;
  const MAX_ITERATIONS = 20; // Prevent infinite loops

  while (currentExternalTermRefs.length > 0 && iteration < MAX_ITERATIONS) {
    const iterationStartTime = performance.now();

    if (verbose && currentExternalTermRefs.length > 0) {
      console.error(
        `  Term resolution iteration ${iteration} for ${moduleName}.${localName}: resolving terms [${
          currentExternalTermRefs.join(", ")
        }]`,
      );
    }

    // 1. COLLECT replacements
    const replacements = new Map<string, TripLangTerm>();
    const pendingRefs = new Set<string>();

    for (const termRef of currentExternalTermRefs) {
      // Self-ref check
      if (
        termRef === localName && resolvedDefinition.kind === "poly" &&
        resolvedDefinition.rec
      ) {
        continue;
      }

      const targetQualified = termEnv.get(termRef);
      if (targetQualified) {
        // It's an import (in termEnv)
        const targetTerm = ps.terms.get(targetQualified);
        if (targetTerm) {
          replacements.set(termRef, targetTerm);
        } else {
          pendingRefs.add(termRef);
        }
      } else {
        // Check if it's a local definition
        const module = ps.modules.get(moduleName)!;
        if (module.defs.has(termRef)) {
          const localTerm = module.defs.get(termRef)!;
          replacements.set(termRef, localTerm);
        } else {
          // It's a cross-module reference
          const candidateModules = exportIndex.get(termRef)
            ? Array.from(exportIndex.get(termRef)!)
            : [];

          if (candidateModules.length === 0) {
            const candidatesText = " (no modules export this symbol)";
            throw new Error(
              `Symbol '${termRef}' is not defined in module '${moduleName}' and is not imported${candidatesText}`,
            );
          } else if (candidateModules.length === 1) {
            // Unambiguous: resolve it
            const modName = candidateModules[0];
            const qualified = qualifiedName(modName, termRef);
            const targetTerm = ps.terms.get(qualified);
            if (targetTerm) {
              replacements.set(termRef, targetTerm);
            } else {
              pendingRefs.add(termRef);
            }
          } else {
            // Ambiguous - keep pending
            const candidatesText = ` (candidate modules: ${
              candidateModules.join(", ")
            })`;
            const fixHint = ` To fix: add 'import ${
              candidateModules[0]
            } ${termRef}' or use qualified name '${
              candidateModules[0]
            }.${termRef}'.`;
            throw new Error(
              `Symbol '${termRef}' is not defined in module '${moduleName}' and is not imported${candidatesText}${fixHint}`,
            );
          }
        }
      }
    }

    // 2. BATCH SUBSTITUTION
    if (replacements.size > 0) {
      // Build a map of name -> value for the batch substitution
      const valueSubstitutions = new Map<string, TripLangValueType>();
      for (const [name, term] of replacements) {
        const value = extractDefinitionValue(term);
        if (value) {
          valueSubstitutions.set(name, value);
        }
      }

      if (valueSubstitutions.size > 0) {
        // Calculate union of free vars for capture checking (CACHED!)
        const combinedFVs = new Set<string>();
        for (const val of valueSubstitutions.values()) {
          // This is now fast because freeTermVars uses the WeakMap cache
          const fvs = freeTermVars(val);
          for (const fv of fvs) combinedFVs.add(fv);
        }

        // Apply batch substitution directly to the definition value
        const defValue = extractDefinitionValue(resolvedDefinition);
        if (defValue) {
          const newDefValue = substituteTermHygienicBatch(
            defValue,
            valueSubstitutions,
            combinedFVs,
          );

          // Reconstruct the term with the new value
          if (newDefValue !== defValue) {
            switch (resolvedDefinition.kind) {
              case "poly":
                resolvedDefinition = {
                  ...resolvedDefinition,
                  term: newDefValue as SystemFTerm,
                };
                break;
              case "typed":
                resolvedDefinition = {
                  ...resolvedDefinition,
                  term: newDefValue as TypedLambda,
                };
                break;
              case "untyped":
                resolvedDefinition = {
                  ...resolvedDefinition,
                  term: newDefValue as UntypedLambda,
                };
                break;
            }
          }
        }
      }

      // 3. Re-calculate refs (Fast because untouched subtrees are identity-preserved)
      const [newTermRefs, _newTypeRefs] = externalReferences(
        extractDefinitionValue(resolvedDefinition)!,
      );

      // Update for next iteration
      const nextExternalTermRefs = new Set<string>();
      for (const ref of newTermRefs.keys()) {
        nextExternalTermRefs.add(ref);
      }
      // Add back pending refs that we couldn't resolve
      for (const ref of pendingRefs) {
        nextExternalTermRefs.add(ref);
      }

      if (resolvedDefinition.kind === "poly" && resolvedDefinition.rec) {
        nextExternalTermRefs.delete(localName);
      }

      // Check if we made progress
      const refsChanged =
        nextExternalTermRefs.size !== currentExternalTermRefs.length ||
        Array.from(nextExternalTermRefs).some((ref) =>
          !currentExternalTermRefs.includes(ref)
        );

      if (!refsChanged) {
        if (verbose) {
          console.error(
            `  Term resolution converged for ${moduleName}.${localName} after ${iteration} iterations (no new references)`,
          );
        }
        break;
      }

      currentExternalTermRefs = Array.from(nextExternalTermRefs);

      if (verbose) {
        console.error(
          `  Batch resolved ${replacements.size} terms in ${
            (performance.now() - iterationStartTime).toFixed(2)
          }ms`,
        );
      }
    } else {
      // No progress possible
      if (verbose) {
        console.error(
          `  Term resolution converged for ${moduleName}.${localName} after ${iteration} iterations (no substitutions available)`,
        );
      }
      break;
    }

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
    let changed = false; // Track if any substitution actually occurred

    for (const typeRef of currentExternalTypeRefs) {
      const targetQualified = typeEnv.get(typeRef);

      // Case 1: Resolution via Environment (Imports)
      if (targetQualified) {
        const targetType = ps.types.get(targetQualified);
        if (targetType) {
          const oldDef = resolvedDefinition; // Capture state before substitution
          resolvedDefinition = substituteTripLangTypeDirect(
            resolvedDefinition,
            targetType,
          );
          // FIX: Only mark as changed if substitution actually happened
          if (resolvedDefinition !== oldDef) {
            changed = true;
            // Check for new external references after substitution
            const [_newTermRefs, newTypeRefs] = externalReferences(
              extractDefinitionValue(resolvedDefinition)!,
            );
            const newExternalTypeRefs = Array.from(newTypeRefs.keys());
            newExternalTypeRefs.forEach((ref) => nextExternalTypeRefs.add(ref));
          }
        }
      } else {
        // Case 2: Local Resolution / Candidates
        const module = ps.modules.get(moduleName)!;
        if (module.defs.has(typeRef)) {
          const localType = module.defs.get(typeRef)!;

          // FIX: Robust Self-Reference Check
          // We are already looking at the current module's defs, so strictly check the name.
          const isSelfReference = typeRef === localName;

          if (isSelfReference) {
            // Skip self-references to prevent infinite loops
            continue;
          }

          // Handle Type Aliases (Substitution)
          if (localType.kind === "type") {
            const oldDef = resolvedDefinition; // Capture state before substitution
            resolvedDefinition = substituteTripLangTypeDirect(
              resolvedDefinition,
              localType,
            );
            // FIX: Only mark as changed if substitution actually happened
            if (resolvedDefinition !== oldDef) {
              changed = true;
              // Check for new external references after substitution
              const [_newTermRefs, newTypeRefs] = externalReferences(
                extractDefinitionValue(resolvedDefinition)!,
              );
              const newExternalTypeRefs = Array.from(newTypeRefs.keys());
              newExternalTypeRefs.forEach((ref) =>
                nextExternalTypeRefs.add(ref)
              );
            }
          }
          // Handle Data Types: For data definitions, we don't substitute/expand,
          // so we don't mark 'changed'. If all refs are data types or self-refs,
          // 'changed' remains false and we break the loop.
        } else {
          // Use export index for fast lookup instead of iterating all modules
          const candidateModules = exportIndex.get(typeRef)
            ? Array.from(exportIndex.get(typeRef)!)
            : [];

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

    // BREAK IF STABLE: If nothing changed, we've converged (e.g., all remaining refs
    // are data types or self-references that we can't/won't substitute).
    // This prevents infinite loops when encountering large structures with data type refs.
    if (!changed) {
      if (verbose) {
        console.error(
          `  Type resolution converged for ${moduleName}.${localName} after ${typeIteration} iterations (no substitutions occurred)`,
        );
      }
      break;
    }

    // Update for next iteration
    currentExternalTypeRefs = [...nextExternalTypeRefs];
    typeIteration++;
  }

  if (typeIteration >= MAX_TYPE_ITERATIONS) {
    const remainingTypes = currentExternalTypeRefs.join(", ");
    throw new Error(
      `Too many iterations (${typeIteration}) resolving external type references for definition ${moduleName}.${localName} - possible circular dependency. Remaining unresolved types: [${remainingTypes}]`,
    );
  }

  return resolvedDefinition;
}

/**
 * Resolves a single Strongly Connected Component (SCC), iterating to a fixpoint if it's a cycle.
 * Uses hash caching to avoid redundant computations.
 */
function resolveSCC(
  scc: QualifiedName[],
  ps: ProgramSpace,
  exportIndex: Map<string, Set<string>>,
  hashCache: Map<TripLangTerm, string>,
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
      localName,
      ps,
      exportIndex,
      verbose,
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

    // Store current definitions and module info before iteration to avoid stale references
    // We need to snapshot all definitions first, then process them, to ensure
    // each definition is processed using the state from the start of this iteration.
    const snapshots = new Map<
      QualifiedName,
      {
        moduleName: string;
        localName: string;
        module: LoadedModule;
        currentDef: TripLangTerm;
      }
    >();
    for (const qualified of scc) {
      const { moduleName, localName, module } = getModuleInfo(ps, qualified);
      snapshots.set(qualified, {
        moduleName,
        localName,
        module,
        currentDef: module.defs.get(localName)!,
      });
    }

    // Process all definitions using the snapshots
    for (const qualified of scc) {
      const snapshot = snapshots.get(qualified)!;

      // Use cached hash if available, otherwise compute and cache
      let prevHash = hashCache.get(snapshot.currentDef);
      if (!prevHash) {
        prevHash = computeTermHash(snapshot.currentDef);
        hashCache.set(snapshot.currentDef, prevHash);
      }

      const newDef = substituteDependencies(
        snapshot.currentDef,
        snapshot.moduleName,
        snapshot.localName,
        ps,
        exportIndex,
        verbose,
      );

      // Use cached hash if available, otherwise compute and cache
      let newHash = hashCache.get(newDef);
      if (!newHash) {
        newHash = computeTermHash(newDef);
        hashCache.set(newDef, newHash);
      }

      if (prevHash !== newHash) {
        hasChanged = true;
        snapshot.module.defs.set(snapshot.localName, newDef);
        setGlobal(ps, qualified, newDef);
        // Update cache entry for the qualified name
        hashCache.delete(snapshot.currentDef);
        hashCache.set(newDef, newHash);
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
 * Builds a reverse index: symbol name -> set of modules that export it
 * This avoids iterating through all modules when looking for candidates
 */
function buildExportIndex(ps: ProgramSpace): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [moduleName, module] of ps.modules) {
    for (const exportName of module.exports) {
      if (!index.has(exportName)) {
        index.set(exportName, new Set());
      }
      index.get(exportName)!.add(moduleName);
    }
  }
  return index;
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

  clearModuleInfoCache();
  const resolvedPS = shallowCopyProgramSpace(programSpace);
  const exportIndex = buildExportIndex(resolvedPS);
  // Pre-lower poly/typed terms to untyped to avoid recursive inlining loops.
  for (const module of resolvedPS.modules.values()) {
    for (const [name, def] of module.defs) {
      if (def.kind === "poly" || def.kind === "typed") {
        const lowered = lower(def);
        module.defs.set(name, lowered);
        setGlobal(resolvedPS, qualifiedName(module.name, name), lowered);
      }
    }
  }
  const dependencyGraph = buildDependencyGraph(resolvedPS);
  const sccs = tarjanSCC(dependencyGraph).reverse(); // Topological sort

  if (verbose) {
    console.error(`Built dependency graph with ${dependencyGraph.size} nodes`);
    console.error(`Found ${sccs.length} strongly connected components`);
  }

  // Create hash cache to avoid redundant computations
  const hashCache = new Map<TripLangTerm, string>();

  for (const scc of sccs) {
    resolveSCC(scc, resolvedPS, exportIndex, hashCache, verbose);
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
