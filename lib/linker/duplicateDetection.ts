/**
 * Link-time duplicate implementation detector (advisory pass).
 *
 * Detects overlapping or duplicated symbol definitions across modules,
 * emitting grouped diagnostics for refactor consolidation (e.g. moving
 * Bin helpers out of Prelude into a dedicated Bin module).
 */

import type { ProgramSpace } from "./moduleLinker.ts";
import { extractDefinitionValue } from "../meta/frontend/symbolTable.ts";
import { externalReferences } from "../meta/frontend/externalReferences.ts";
import { lower } from "../meta/frontend/termLevel.ts";
import type { TripLangTerm } from "../meta/trip.ts";
import type { SKIExpression } from "../ski/expression.ts";
import { toSKIKey } from "../ski/expression.ts";

export type LinkSeverity = "info" | "warning" | "error";

export interface LinkDiagnostic {
  severity: LinkSeverity;
  code: string;
  message: string;
  primaryModule?: string;
  relatedModules?: string[];
  relatedSymbols?: Array<{ module: string; symbol: string }>;
  hint?: string;
}

export interface DuplicateDetectionOptions {
  enabled?: boolean;
  warnThreshold?: number;
  ignoredModules?: Set<string>;
  commonPrimitiveSymbols?: Set<string>;
  /** Module name -> list of modules it shims for (suppress overlap warnings with those). */
  moduleShimFor?: Record<string, string[]>;
}

export interface LinkOptions {
  diagnostics?: boolean;
  /** When true, run the advisory duplicate-detection pass and emit LDUP001 diagnostics. Does not change linker semantics. */
  duplicateDetection?: DuplicateDetectionOptions;
  /** When true, do not throw on ambiguous export names; resolve (e.g. first module wins) and continue. Separate from duplicateDetection. */
  allowDuplicateExports?: boolean;
}

export interface LinkResult {
  expression: string;
  diagnostics: LinkDiagnostic[];
}

export interface SymbolDef {
  moduleName: string;
  symbolName: string;
  exported: boolean;
  reExport?: boolean;
  normalizedBodyHash?: string;
  dependencyShape?: string[];
}

export interface ModuleInventory {
  moduleName: string;
  symbols: SymbolDef[];
}

const DEFAULT_PRIMITIVES = new Set([
  "id",
  "const",
  "true",
  "false",
  "fst",
  "snd",
]);

function qualifiedName(module: string, name: string): string {
  return `${module}.${name}`;
}

/** Simple stable string hash for fingerprinting (djb2). */
function stringHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return String(h);
}

/**
 * Lowers a term to combinator form and returns its SKI expression, or undefined if lowering fails.
 */
function lowerToCombinator(def: TripLangTerm): SKIExpression | undefined {
  let current: TripLangTerm = def;
  const maxSteps = 10;
  for (let step = 0; step < maxSteps; step++) {
    if (current.kind === "combinator") return current.term;
    try {
      current = lower(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Computes a normalized body hash for a term definition (for Phase 2 body similarity).
 */
function computeBodyHash(
  ps: ProgramSpace,
  moduleName: string,
  symbolName: string,
): string | undefined {
  const module = ps.modules.get(moduleName);
  if (!module) return undefined;
  const def = module.defs.get(symbolName);
  if (!def) return undefined;
  const ski = lowerToCombinator(def);
  if (!ski) return undefined;
  const key = toSKIKey(ski);
  return stringHash(JSON.stringify(key));
}

/**
 * Returns true if the definition is a pure re-export (body is just a reference to an imported symbol).
 */
function isReExport(
  ps: ProgramSpace,
  moduleName: string,
  symbolName: string,
): boolean {
  const module = ps.modules.get(moduleName);
  if (!module) return false;
  const def = module.defs.get(symbolName);
  if (!def) return false;
  const value = extractDefinitionValue(def);
  if (!value) return false;
  const [termRefs] = externalReferences(value);
  if (termRefs.size !== 1) return false;
  const refName = termRefs.keys().next().value;
  if (refName === undefined) return false;
  const termEnv = ps.termEnv.get(moduleName);
  if (!termEnv) return false;
  const qualified = termEnv.get(refName);
  if (!qualified) return false;
  const otherModule = qualified.slice(0, qualified.indexOf("."));
  return otherModule !== moduleName;
}

/**
 * Builds the object inventory from the resolved program space.
 * Only includes exported terms (not types). Skips re-exports when options are provided.
 */
export function buildModuleInventory(
  ps: ProgramSpace,
  _options?: DuplicateDetectionOptions,
): ModuleInventory[] {
  const inventories: ModuleInventory[] = [];

  for (const [moduleName, module] of ps.modules) {
    const symbols: SymbolDef[] = [];
    for (const exportName of module.exports) {
      const q = qualifiedName(moduleName, exportName);
      if (ps.types.has(q)) continue;
      if (!ps.terms.has(q)) continue;
      const reExport = isReExport(ps, moduleName, exportName);
      const normalizedBodyHash = computeBodyHash(ps, moduleName, exportName);
      symbols.push({
        moduleName,
        symbolName: exportName,
        exported: true,
        reExport,
        normalizedBodyHash,
      });
    }
    inventories.push({ moduleName, symbols });
  }
  return inventories;
}

function isPairSuppressed(
  moduleA: string,
  moduleB: string,
  options?: DuplicateDetectionOptions,
): boolean {
  if (options?.ignoredModules?.has(moduleA)) return true;
  if (options?.ignoredModules?.has(moduleB)) return true;
  const shimFor = options?.moduleShimFor;
  if (shimFor) {
    if (shimFor[moduleA]?.includes(moduleB)) return true;
    if (shimFor[moduleB]?.includes(moduleA)) return true;
  }
  return false;
}

/**
 * Runs the duplicate detection pass and appends diagnostics to the given array.
 * Phase 1: exact name overlap, clustered by module pair; re-export and shim suppression; common primitives.
 */
export function runDuplicateDetection(
  _ps: ProgramSpace,
  inventories: ModuleInventory[],
  options: DuplicateDetectionOptions,
  outDiagnostics: LinkDiagnostic[],
): void {
  const commonPrimitives = options.commonPrimitiveSymbols ?? DEFAULT_PRIMITIVES;

  const moduleNames = inventories.map((inv) => inv.moduleName);

  for (let i = 0; i < moduleNames.length; i++) {
    for (let j = i + 1; j < moduleNames.length; j++) {
      const modA = moduleNames[i]!;
      const modB = moduleNames[j]!;
      if (isPairSuppressed(modA, modB, options)) continue;

      const invA = inventories[i]!;
      const invB = inventories[j]!;

      const symbolsA = new Map(
        invA.symbols
          .filter((s) => !s.reExport && !commonPrimitives.has(s.symbolName))
          .map((s) => [s.symbolName, s] as const),
      );
      const symbolsB = new Map(
        invB.symbols
          .filter((s) => !s.reExport && !commonPrimitives.has(s.symbolName))
          .map((s) => [s.symbolName, s] as const),
      );

      const exactOverlap: string[] = [];
      for (const name of symbolsA.keys()) {
        if (symbolsB.has(name)) exactOverlap.push(name);
      }

      if (exactOverlap.length > 0) {
        const relatedSymbols: Array<{ module: string; symbol: string }> = [];
        for (const sym of exactOverlap) {
          relatedSymbols.push({ module: modA, symbol: sym });
          relatedSymbols.push({ module: modB, symbol: sym });
        }
        outDiagnostics.push({
          severity: "warning",
          code: "LDUP001",
          message: `Duplicate exported names across modules: ${
            exactOverlap.join(", ")
          }. Consider consolidating into a single module.`,
          primaryModule: modA,
          relatedModules: [modB],
          relatedSymbols,
          hint:
            "Move shared definitions into one module and re-export or import as needed.",
        });
      }

      // Phase 2: body similarity — same normalized body hash, different names
      const byHashA = new Map<string, SymbolDef[]>();
      const byHashB = new Map<string, SymbolDef[]>();
      for (const s of invA.symbols) {
        if (
          s.reExport || !s.normalizedBodyHash ||
          commonPrimitives.has(s.symbolName)
        ) continue;
        const list = byHashA.get(s.normalizedBodyHash) ?? [];
        list.push(s);
        byHashA.set(s.normalizedBodyHash, list);
      }
      for (const s of invB.symbols) {
        if (
          s.reExport || !s.normalizedBodyHash ||
          commonPrimitives.has(s.symbolName)
        ) continue;
        const list = byHashB.get(s.normalizedBodyHash) ?? [];
        list.push(s);
        byHashB.set(s.normalizedBodyHash, list);
      }
      for (const [hash, listA] of byHashA) {
        const listB = byHashB.get(hash);
        if (!listB || listB.length === 0) continue;
        const allSameName = listA.length === 1 && listB.length === 1 &&
          listA[0]!.symbolName === listB[0]!.symbolName;
        if (allSameName) continue;
        const relatedSymbols: Array<{ module: string; symbol: string }> = [];
        for (const s of listA) {
          relatedSymbols.push({ module: modA, symbol: s.symbolName });
        }
        for (const s of listB) {
          relatedSymbols.push({ module: modB, symbol: s.symbolName });
        }
        outDiagnostics.push({
          severity: "warning",
          code: "LDUP001",
          message: `Same SKI body across modules: ${
            relatedSymbols.map((r) => `${r.module}.${r.symbol}`).join(", ")
          }.`,
          primaryModule: modA,
          relatedModules: [modB],
          relatedSymbols,
          hint:
            "Same encoding after type erasure; may be distinct types (e.g. nil vs Empty). Consolidate only if truly the same abstraction.",
        });
      }
    }
  }
}
