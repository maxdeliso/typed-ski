/**
 * Bootstrap compiler module registry.
 *
 * The self-hosted Trip compiler lives in bootstrap/src/ as .trip
 * modules. This file is the single source of truth for their
 * name -> path mapping, extending the four public Trip modules from
 * lib/tripModules.ts.
 *
 * @module
 */
import { join } from "node:path";
import { workspaceRoot } from "../shared/workspaceRoot.ts";
import { loadTripModuleObject } from "../tripSourceLoader.ts";
import type { TripCObject } from "./objectFile.ts";
import {
  tripModuleSourcePath,
  type PublicTripModuleName,
} from "../tripModules.ts";

export type BootstrapTripModuleName =
  | "Lexer"
  | "Parser"
  | "Core"
  | "DataEnv"
  | "CoreToLower"
  | "Unparse"
  | "Lowering"
  | "Bridge"
  | "Llvm"
  | "BundleSummary"
  | "BundleParseSummary"
  | "BundleInventory"
  | "ModuleEnv"
  | "CoreToMini"
  | "MiniCore"
  | "MiniVerify"
  | "Anf"
  | "AnfLlvm"
  | "Compiler"
  | "Telemetry";

export type CompilerTripModuleName =
  | PublicTripModuleName
  | BootstrapTripModuleName;

const BOOTSTRAP_MODULE_FILES: Record<BootstrapTripModuleName, string> = {
  Lexer: "lexer.trip",
  Parser: "parser.trip",
  Core: "core.trip",
  DataEnv: "dataEnv.trip",
  CoreToLower: "coreToLower.trip",
  Unparse: "unparse.trip",
  Lowering: "lowering.trip",
  Bridge: "bridge.trip",
  Llvm: "llvm.trip",
  BundleSummary: "bundleSummary.trip",
  BundleParseSummary: "bundleParseSummary.trip",
  BundleInventory: "bundleInventory.trip",
  ModuleEnv: "moduleEnv.trip",
  CoreToMini: "coreToMini.trip",
  MiniCore: "miniCore.trip",
  MiniVerify: "miniVerify.trip",
  Anf: "anf.trip",
  AnfLlvm: "anfLlvm.trip",
  Compiler: "index.trip",
  Telemetry: "telemetry.trip",
};

export const ALL_COMPILER_TRIP_MODULE_NAMES: readonly CompilerTripModuleName[] =
  [
    "Prelude",
    "Nat",
    "Bin",
    "Avl",
    ...(Object.keys(BOOTSTRAP_MODULE_FILES) as BootstrapTripModuleName[]),
  ];

function isBootstrapModule(
  name: CompilerTripModuleName,
): name is BootstrapTripModuleName {
  return Object.hasOwn(BOOTSTRAP_MODULE_FILES, name);
}

export function isKnownCompilerTripModule(
  name: string,
): name is CompilerTripModuleName {
  return ALL_COMPILER_TRIP_MODULE_NAMES.includes(
    name as CompilerTripModuleName,
  );
}

export function compilerTripModuleSourcePath(
  name: CompilerTripModuleName,
): string {
  if (isBootstrapModule(name)) {
    return join(
      workspaceRoot,
      "bootstrap",
      "src",
      BOOTSTRAP_MODULE_FILES[name],
    );
  }
  return tripModuleSourcePath(name);
}

export function loadCompilerTripModule(
  name: CompilerTripModuleName,
): Promise<TripCObject> {
  return loadTripModuleObject(compilerTripModuleSourcePath(name));
}
