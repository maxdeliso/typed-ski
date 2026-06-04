import { stat, readFile, writeFile } from "node:fs/promises";
import { resolve, extname, basename, dirname } from "node:path";
import { parseTripLang } from "../parser/tripLang.ts";
import { externalReferences } from "../meta/frontend/externalReferences.ts";
import type { TripLangProgram, TripLangTerm } from "../meta/trip.ts";
import type { BaseType } from "../types/types.ts";
import type { SystemFTerm } from "../terms/systemF.ts";
import {
  discoverTripFiles,
  formatTripSource,
  lexTrip,
  partitionDecls,
  isComment,
  type Token,
} from "./index.ts";

interface Definition {
  moduleName: string;
  name: string;
  kind: string;
  definedSymbols: string[]; // e.g. ["M.foo"] or ["M.List", "M.nil", "M.cons"]
  term: TripLangTerm;
  group: Token[];
  filePath: string;
  referencedSymbols: Set<string>;
}

function collectMatchConstructors(
  term: SystemFTerm,
  constructors: Set<string>,
): void {
  if (!term) return;
  switch (term.kind) {
    case "systemF-abs":
      collectMatchConstructors(term.body, constructors);
      break;
    case "systemF-type-abs":
      collectMatchConstructors(term.body, constructors);
      break;
    case "systemF-type-app":
      collectMatchConstructors(term.term, constructors);
      break;
    case "non-terminal":
      collectMatchConstructors(term.lft, constructors);
      collectMatchConstructors(term.rgt, constructors);
      break;
    case "systemF-let":
      collectMatchConstructors(term.value, constructors);
      collectMatchConstructors(term.body, constructors);
      break;
    case "systemF-match":
      collectMatchConstructors(term.scrutinee, constructors);
      for (const arm of term.arms) {
        constructors.add(arm.constructorName);
        collectMatchConstructors(arm.body, constructors);
      }
      break;
  }
}

function getGroupInfo(
  group: Token[],
): { kind: string; name?: string; ref?: string } | undefined {
  const nonComments = group.filter((t) => !isComment(t));
  if (nonComments.length === 0) return undefined;
  const first = nonComments[0]!;
  const kind = first.text;
  let name: string | undefined;
  let ref: string | undefined;

  if (kind === "module" || kind === "export") {
    name = nonComments[1]?.text;
  } else if (kind === "import") {
    name = nonComments[1]?.text;
    ref = nonComments[2]?.text;
  } else if (kind === "opaque" && nonComments[1]?.text === "type") {
    name = nonComments[2]?.text;
  } else if (kind === "poly" && nonComments[1]?.text === "rec") {
    name = nonComments[2]?.text;
  } else {
    name = nonComments[1]?.text;
  }
  return { kind, name, ref };
}

export async function pruneUnreachableTripCode(
  inputPath: string,
  entryPointsArg: string | string[],
  options: { verbose?: boolean } = {},
): Promise<void> {
  const entryPoints =
    typeof entryPointsArg === "string"
      ? entryPointsArg
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : entryPointsArg;

  const resolvedPath = resolve(inputPath);
  const pathStats = await stat(resolvedPath);
  let files: string[] = [];

  if (pathStats.isFile()) {
    if (extname(resolvedPath) === ".trip") {
      files = [resolvedPath];
    }
  } else {
    files = await discoverTripFiles([resolvedPath]);
  }

  if (files.length === 0) {
    throw new Error(`No TripLang files found under: ${inputPath}`);
  }

  if (options.verbose) {
    console.log(`Analyzing ${files.length} files...`);
  }

  // 1. Parse all files and map groups to AST terms
  const moduleFileMap = new Map<string, string>(); // moduleName -> filePath
  const moduleTermsMap = new Map<
    string,
    { term: TripLangTerm; group: Token[] }[]
  >();
  const moduleNameMap = new Map<string, string>(); // filePath -> moduleName

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const program = parseTripLang(content);
    const tokens = lexTrip(content);
    const groups = partitionDecls(tokens);

    let moduleName: string | undefined;
    const termGroups: { term: TripLangTerm; group: Token[] }[] = [];
    let termIdx = 0;

    for (const group of groups) {
      const info = getGroupInfo(group);
      if (!info) continue;

      if (info.kind === "module" && info.name) {
        moduleName = info.name;
      }

      const term = program.terms[termIdx++];
      if (!term) {
        throw new Error(`More token groups than AST terms in ${file}`);
      }

      termGroups.push({ term, group });
    }

    if (!moduleName) {
      throw new Error(`Module declaration missing in file: ${file}`);
    }

    moduleFileMap.set(moduleName, file);
    moduleTermsMap.set(moduleName, termGroups);
    moduleNameMap.set(file, moduleName);
  }

  // 2. Build global definition registry and name resolution maps
  // globalDefinitions: maps "ModuleName.SymbolName" -> Definition
  const globalDefinitions = new Map<string, Definition>();
  // nameResolutionMaps: maps moduleName -> (localName -> globalSymbolName)
  const nameResolutionMaps = new Map<string, Map<string, string>>();

  for (const [moduleName, termGroups] of moduleTermsMap.entries()) {
    const resMap = new Map<string, string>();
    nameResolutionMaps.set(moduleName, resMap);

    const filePath = moduleFileMap.get(moduleName)!;

    for (const { term, group } of termGroups) {
      if (
        term.kind === "poly" ||
        term.kind === "combinator" ||
        term.kind === "native" ||
        term.kind === "type" ||
        term.kind === "data"
      ) {
        const definedSymbols: string[] = [];
        if (term.kind === "data") {
          definedSymbols.push(`${moduleName}.${term.name}`);
          resMap.set(term.name, `${moduleName}.${term.name}`);
          for (const ctor of term.constructors) {
            definedSymbols.push(`${moduleName}.${ctor.name}`);
            resMap.set(ctor.name, `${moduleName}.${ctor.name}`);
          }
        } else {
          definedSymbols.push(`${moduleName}.${term.name}`);
          resMap.set(term.name, `${moduleName}.${term.name}`);
        }

        const def: Definition = {
          moduleName,
          name: term.name,
          kind: term.kind,
          definedSymbols,
          term,
          group,
          filePath,
          referencedSymbols: new Set<string>(),
        };

        for (const sym of definedSymbols) {
          globalDefinitions.set(sym, def);
        }
      }
    }
  }

  // Collect all exported symbols across all modules to support global/implicit name resolution
  const globalExports = new Map<string, string[]>();
  for (const [moduleName, termGroups] of moduleTermsMap.entries()) {
    if (moduleName === "DataEnv") {
      console.log(
        "DataEnv terms kinds in reachability.ts:",
        termGroups.map((x) => x.term.kind),
      );
    }
    for (const { term } of termGroups) {
      if (term.kind === "export") {
        console.log(`FOUND EXPORT in ${moduleName}: ${term.name}`);
        const list = globalExports.get(term.name) || [];
        list.push(moduleName);
        globalExports.set(term.name, list);
      }
    }
  }

  // Add imports to the name resolution maps
  for (const [moduleName, termGroups] of moduleTermsMap.entries()) {
    const resMap = nameResolutionMaps.get(moduleName)!;
    for (const { term } of termGroups) {
      if (term.kind === "import") {
        // e.g. import Prelude List
        // term.name is Prelude, term.ref is List
        // So List resolves to Prelude.List
        resMap.set(term.ref, `${term.name}.${term.ref}`);
      }
    }
  }

  // 3. Resolve references for each definition
  for (const def of globalDefinitions.values()) {
    const resMap = nameResolutionMaps.get(def.moduleName)!;
    const refs = new Set<string>();

    const handleType = (type: BaseType, bound: string[] = []) => {
      if (!type) return;
      const [, typeRefs] = externalReferences(type);
      for (const name of typeRefs.keys()) {
        if (!bound.includes(name)) {
          refs.add(name);
        }
      }
    };

    if (def.term.kind === "poly") {
      if (def.term.type) {
        handleType(def.term.type);
      }
      const [termRefs, typeRefs] = externalReferences(def.term.term);
      for (const name of termRefs.keys()) {
        refs.add(name);
      }
      for (const name of typeRefs.keys()) {
        refs.add(name);
      }
      collectMatchConstructors(def.term.term, refs);
    } else if (def.term.kind === "type") {
      handleType(def.term.type);
    } else if (def.term.kind === "native") {
      handleType(def.term.type);
    } else if (def.term.kind === "data") {
      const bound = def.term.typeParams;
      for (const ctor of def.term.constructors) {
        for (const field of ctor.fields) {
          handleType(field, bound);
        }
      }
    }

    // Resolve refs to global symbols using local name resolution map,
    // falling back to global/implicit resolution if exported by exactly one module.
    if (def.name === "elaborateMatchWith") {
      console.log("DEBUG elaborateMatchWith collected refs:", Array.from(refs));
    }
    for (const ref of refs) {
      let resolvedSym = resMap.get(ref);
      if (!resolvedSym) {
        const exportingModules = globalExports.get(ref);
        if (exportingModules && exportingModules.length === 1) {
          resolvedSym = `${exportingModules[0]}.${ref}`;
        }
      }
      if (def.name === "elaborateMatchWith" && ref === "ctorAdtName") {
        console.log("DEBUG: resolved ctorAdtName to:", resolvedSym);
      }

      if (resolvedSym) {
        def.referencedSymbols.add(resolvedSym);
      } else {
        // If not in resolution map, it could be a primitive combinator (e.g. S, K, I)
        // or a built-in type. We can just keep it unresolved/ignored.
      }
    }
  }

  // 4. Resolve the entry points
  const resolvedEntryPoints: string[] = [];
  for (const entryPoint of entryPoints) {
    let resolvedEntryPoint: string | undefined;
    if (entryPoint.includes(".")) {
      if (globalDefinitions.has(entryPoint)) {
        resolvedEntryPoint = entryPoint;
      }
    } else {
      // Search for entry point in any module
      const candidates: string[] = [];
      for (const sym of globalDefinitions.keys()) {
        if (sym.endsWith(`.${entryPoint}`)) {
          candidates.push(sym);
        }
      }
      if (candidates.length === 1) {
        resolvedEntryPoint = candidates[0];
      } else if (candidates.length > 1) {
        // Prioritize Compiler module if it exists
        const compilerCand = candidates.find((c) => c.startsWith("Compiler."));
        if (compilerCand) {
          resolvedEntryPoint = compilerCand;
        } else {
          throw new Error(
            `Ambiguous entry point '${entryPoint}'. Candidates: ${candidates.join(", ")}`,
          );
        }
      }
    }

    if (!resolvedEntryPoint) {
      throw new Error(
        `Entry point '${entryPoint}' not found in the parsed codebase.`,
      );
    }
    resolvedEntryPoints.push(resolvedEntryPoint);
  }

  if (options.verbose) {
    console.log(`Resolved entry points to: ${resolvedEntryPoints.join(", ")}`);
  }

  // 5. Run DFS/BFS transitively
  const reachableSymbols = new Set<string>();
  const queue = [...resolvedEntryPoints];

  while (queue.length > 0) {
    const sym = queue.pop()!;
    if (reachableSymbols.has(sym)) continue;

    reachableSymbols.add(sym);
    const def = globalDefinitions.get(sym);
    if (def) {
      // Any symbol defined by this definition is also reachable
      for (const s of def.definedSymbols) {
        reachableSymbols.add(s);
      }
      // Add referenced symbols to queue
      for (const ref of def.referencedSymbols) {
        if (!reachableSymbols.has(ref)) {
          queue.push(ref);
        }
      }
    }
  }

  if (options.verbose) {
    console.log(`Found ${reachableSymbols.size} reachable symbols:`);
    for (const sym of Array.from(reachableSymbols).sort()) {
      console.log(`  - ${sym}`);
    }
  }

  // 6. Rewrite files
  for (const file of files) {
    const moduleName = moduleNameMap.get(file)!;
    const termGroups = moduleTermsMap.get(moduleName)!;

    // Collect all referenced symbols from kept definitions in this module to know which imports to keep
    const referencedByKept = new Set<string>();
    // Wait, the entry points themselves are considered referenced/kept
    for (const rep of resolvedEntryPoints) {
      referencedByKept.add(rep);
    }

    for (const { term } of termGroups) {
      if (
        term.kind === "poly" ||
        term.kind === "combinator" ||
        term.kind === "native" ||
        term.kind === "type" ||
        term.kind === "data"
      ) {
        const sym = `${moduleName}.${term.name}`;
        if (reachableSymbols.has(sym)) {
          const def = globalDefinitions.get(sym);
          if (def) {
            for (const ref of def.referencedSymbols) {
              referencedByKept.add(ref);
            }
          }
        }
      }
    }

    const keptGroups: Token[][] = [];

    for (const { term, group } of termGroups) {
      if (term.kind === "module") {
        keptGroups.push(group);
      } else if (term.kind === "import") {
        const importTarget = `${term.name}.${term.ref}`;
        if (referencedByKept.has(importTarget)) {
          keptGroups.push(group);
        }
      } else if (term.kind === "export") {
        const exportTarget = `${moduleName}.${term.name}`;
        if (reachableSymbols.has(exportTarget)) {
          keptGroups.push(group);
        }
      } else {
        const sym = `${moduleName}.${term.name}`;
        if (reachableSymbols.has(sym)) {
          keptGroups.push(group);
        }
      }
    }

    // Format and rewrite
    const lines: string[] = [];
    for (let i = 0; i < keptGroups.length; i++) {
      // formatDecl formats individual declarations.
      // Wait, formatTripSource expects a whole file. But we can just use our token list or
      // join groups with newlines and format everything together!
      // Let's see: formatTripSource reformats the entire source text nicely.
      // So if we reconstruct the source from the kept tokens, and then format it:
      const groupTokens = keptGroups[i]!;
      let groupSource = "";
      for (const token of groupTokens) {
        groupSource += token.text;
        if (token.kind === "lineComment") {
          groupSource += "\n";
        } else {
          groupSource += " ";
        }
      }
      lines.push(groupSource.trimEnd());
    }

    const reconstructed = lines.join("\n\n") + "\n";
    const { formatted } = formatTripSource(reconstructed);

    await writeFile(file, formatted, "utf8");
    if (options.verbose) {
      console.log(`Pruned and wrote ${file}`);
    }
  }
}
