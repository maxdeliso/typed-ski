#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

/**
 * Read-only export audit: `bun scripts/findUnusedExports.ts` (or its built JS).
 * Roots come from package exports/scripts, explicit Bazel source references,
 * supported maintenance/benchmark commands, tests, and Node's configured hooks.
 * Review the printed roots before removing a candidate. Dynamic consumers and
 * TripLang definitions need a separate audit; this report never deletes code.
 */
import { Node, Project, SyntaxKind } from "ts-morph";
import { join } from "node:path";
import * as fs from "node:fs";

const project = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: { allowJs: true },
});

const dirs = ["lib", "bin", "scripts", "test"];
const files: string[] = [];

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function findFiles(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        if (/\.(?:tsx?|[cm]?js)$/.test(entry.name)) {
          files.push(normalizeFilePath(fullPath));
        }
      } else if (entry.isDirectory()) {
        findFiles(fullPath);
      }
    }
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

for (const dir of dirs) findFiles(dir);

console.log(`Analyzing ${files.length} files...`);

for (const file of files) {
  try {
    const content = fs.readFileSync(file, "utf8");
    project.createSourceFile(file, content);
  } catch (e) {
    console.error(`Failed to read ${file}: ${e}`);
  }
}

type AuditRoot = {
  file: string;
  context: Set<string>;
  exports?: readonly string[];
};

const apiRoots = new Map<string, AuditRoot>();
const toolRoots = new Map<string, AuditRoot>();
const lifecycleRoots = new Map<string, AuditRoot>();
const rootWarnings = new Set<string>();

function sourcePath(path: string): string {
  const normalized = normalizeFilePath(path)
    .replace(/^\.\//, "")
    .replace(/^ts_out\//, "");
  if (normalized.endsWith(".js")) {
    const typescript = normalized.replace(/\.js$/, ".ts");
    if (files.includes(typescript)) return typescript;
  }
  return normalized;
}

function addRoot(
  roots: Map<string, AuditRoot>,
  path: string,
  context: string,
  exports?: readonly string[],
): void {
  const file = sourcePath(path);
  if (!project.getSourceFile(file)) {
    rootWarnings.add(`${context}: source not found (${file})`);
    return;
  }
  const root = roots.get(file);
  if (root) {
    root.context.add(context);
  } else {
    roots.set(file, { file, context: new Set([context]), exports });
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

function sourceReferences(text: string): string[] {
  const paths = [
    ...text.matchAll(
      /(?<![\w/.-])(?:(?:%s\/|ts_out\/)?(?:lib|bin|scripts|test)|\/(?:scripts|test))\/[\w./-]+\.(?:tsx?|[cm]?js)\b/g,
    ),
  ].map((match) => match[0].replace(/^(?:%s\/|\/)/, ""));
  const labels = [
    ...text.matchAll(
      /\/\/(?:lib|bin|scripts|test)(?:\/[\w/-]+)?:[\w.-]+\.(?:tsx?|[cm]?js)\b/g,
    ),
  ].map((match) => match[0].slice(2).replace(":", "/"));
  return [...paths, ...labels];
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  exports?: unknown;
  bin?: unknown;
  scripts?: Record<string, string>;
};
for (const path of stringValues(packageJson.exports)) {
  addRoot(apiRoots, path, "package.json exports");
}
for (const path of stringValues(packageJson.bin)) {
  addRoot(apiRoots, path, "package.json bin");
}
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  for (const path of sourceReferences(command)) {
    addRoot(toolRoots, path, `package.json script ${name}`);
  }
}

// Bazel executes some tools directly instead of going through package scripts.
for (const file of [
  "BUILD.bazel",
  ...fs
    .readdirSync("bazel")
    .filter((name) => name.endsWith(".bzl"))
    .map((name) => join("bazel", name)),
]) {
  for (const path of sourceReferences(fs.readFileSync(file, "utf8"))) {
    addRoot(toolRoots, path, normalizeFilePath(file));
  }
}

// Ad-hoc supported commands are roots even without a package-script alias.
for (const [file, context] of [
  ["scripts/findUnusedExports.ts", "read-only maintenance audit"],
  ["scripts/runtimePerformance.ts", "docs/runtime-performance-trial.md"],
  ["test/avlMiniCoreBenchmark.ts", "supported MiniCore AVL benchmark"],
] as const) {
  addRoot(toolRoots, file, context);
}

// Node imports these exports by name, outside the TypeScript import graph.
function configuredHookPath(node: Node): string | undefined {
  if (Node.isStringLiteral(node)) return node.getLiteralText();
  if (Node.isIdentifier(node)) {
    for (const definition of node.getDefinitions()) {
      const declaration = definition.getDeclarationNode();
      if (declaration && Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();
        if (initializer) return configuredHookPath(initializer);
      }
    }
  }
  if (
    Node.isCallExpression(node) &&
    /(?:^|\.)(?:join|resolve)$/.test(node.getExpression().getText())
  ) {
    const parts = node
      .getArguments()
      .filter(Node.isStringLiteral)
      .map((argument) => argument.getLiteralText());
    if (parts.length > 0) return parts.join("/");
  }
  return undefined;
}

for (const root of toolRoots.values()) {
  const sourceFile = project.getSourceFileOrThrow(root.file);
  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const args = call.getArguments();
    const flagIndex = args.findIndex(
      (argument) =>
        Node.isStringLiteral(argument) &&
        argument.getLiteralText() === "--test-global-setup",
    );
    if (flagIndex < 0) continue;
    const pathNode = args[flagIndex + 1];
    const path = pathNode && configuredHookPath(pathNode);
    if (path) {
      addRoot(lifecycleRoots, path, `${root.file} --test-global-setup`, [
        "globalSetup",
        "globalTeardown",
      ]);
    } else {
      rootWarnings.add(`${root.file}: cannot resolve --test-global-setup path`);
    }
  }
}

const TEST_ROOTS: AuditRoot[] = files
  .filter((f) => f.startsWith("test/") && f.endsWith(".test.ts"))
  .map((file) => ({ file, context: new Set(["test suite"]) }));
const API_ROOTS = [...apiRoots.values()];
const TOOL_ROOTS = [...toolRoots.values()];
const LIFECYCLE_ROOTS = [...lifecycleRoots.values()];

console.log("\nConfigured roots:");
for (const [label, roots] of [
  ["Public package/bin API", API_ROOTS],
  ["Maintenance/build/benchmark tools", TOOL_ROOTS],
  ["Node test lifecycle", LIFECYCLE_ROOTS],
] as const) {
  console.log(`  ${label}:`);
  for (const root of roots.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(
      `    - ${root.file}${root.exports ? ` [${root.exports.join(", ")}]` : ""} (${[...root.context].join("; ")})`,
    );
  }
}
console.log(`  Test suite: ${TEST_ROOTS.length} *.test.ts files`);
for (const warning of [...rootWarnings].sort())
  console.warn(`  ROOT WARNING: ${warning}`);

function isInternal(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isJSDocable(current)) {
      if (
        current
          .getJsDocs()
          .some((doc: any) => doc.getText().includes("@internal"))
      )
        return true;
    }
    if (Node.isVariableDeclaration(current)) {
      const statement = current.getVariableStatement();
      if (
        statement &&
        statement
          .getJsDocs()
          .some((doc: any) => doc.getText().includes("@internal"))
      ) {
        return true;
      }
    }
    if (Node.isSourceFile(current)) break;
    current = current.getParent();
  }
  return false;
}

function traceReachability(roots: readonly AuditRoot[]): Set<Node> {
  const reachable = new Set<Node>();
  const queue: Node[] = [];

  for (const root of roots) {
    const sourceFile = project.getSourceFile(root.file);
    if (!sourceFile) continue;

    for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
      if (root.exports && !root.exports.includes(name)) continue;
      for (const decl of declarations) {
        if (!reachable.has(decl)) {
          reachable.add(decl);
          queue.push(decl);
        }
      }
    }

    sourceFile.forEachDescendant((node: Node) => {
      if (
        Node.isStatement(node) &&
        !Node.isExportDeclaration(node) &&
        !Node.isExportSpecifier(node)
      ) {
        node.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id: any) => {
          id.getDefinitions().forEach((def: any) => {
            const decl = def.getDeclarationNode();
            if (decl && !reachable.has(decl)) {
              reachable.add(decl);
              queue.push(decl);
            }
          });
        });
      }
    });
  }

  let processed = 0;
  while (processed < queue.length) {
    const current = queue[processed++]!;
    current.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id: any) => {
      id.getDefinitions().forEach((def: any) => {
        const decl = def.getDeclarationNode();
        if (decl && !reachable.has(decl)) {
          const sourceFile = decl.getSourceFile();
          if (
            sourceFile &&
            !sourceFile.getFilePath().includes("node_modules")
          ) {
            reachable.add(decl);
            queue.push(decl);
          }
        }
      });
    });
  }

  return reachable;
}

console.log("Tracing package/bin reachability...");
const productionReachable = traceReachability(API_ROOTS);

console.log("Tracing maintenance/build/benchmark reachability...");
const toolReachable = traceReachability(TOOL_ROOTS);

console.log("Tracing test reachability...");
const testReachable = traceReachability([...TEST_ROOTS, ...LIFECYCLE_ROOTS]);

const stats = {
  totallyDead: [] as string[],
  leakedInternal: [] as string[],
  missingInternalTag: [] as string[],
  wellBehavedInternal: [] as string[],
  publicApi: [] as string[],
  prodInternalExport: [] as string[],
  toolExport: [] as string[],
  lifecycleExport: [] as string[],
};

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath().substring(1);
  if (apiRoots.has(filePath)) continue;
  if (filePath.endsWith(".d.ts")) continue;

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const decl of declarations) {
      const isProd = productionReachable.has(decl);
      const isTest = testReachable.has(decl);
      const isTool = toolReachable.has(decl);
      const tagged = isInternal(decl);
      const location = `${filePath}:${name}`;

      const isExportedFromRoot = API_ROOTS.some((root) => {
        const sf = project.getSourceFile(root.file);
        const exportedDecls = sf?.getExportedDeclarations().get(name) ?? [];
        return exportedDecls.some(
          (exportedDecl: Node) => exportedDecl === decl,
        );
      });

      const isLifecycleExport = LIFECYCLE_ROOTS.some(
        (root) => root.file === filePath && root.exports?.includes(name),
      );
      if (isLifecycleExport) {
        stats.lifecycleExport.push(location);
      } else if (!isProd && !isTest && !isTool) {
        stats.totallyDead.push(location);
      } else if (isProd && tagged) {
        if (isExportedFromRoot) {
          stats.leakedInternal.push(location);
        } else {
          stats.wellBehavedInternal.push(location);
        }
      } else if (isProd && !tagged) {
        if (isExportedFromRoot) {
          stats.publicApi.push(location);
        } else {
          stats.prodInternalExport.push(location);
        }
      } else if (isTool) {
        stats.toolExport.push(location);
      } else if (isTest) {
        if (tagged || filePath.startsWith("test/")) {
          stats.wellBehavedInternal.push(location);
        } else {
          stats.missingInternalTag.push(location);
        }
      }
    }
  }
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

console.log("\n=== REACHABILITY REPORT ===\n");

const totallyDead = unique(stats.totallyDead);
if (totallyDead.length > 0) {
  console.log(
    "UNREACHABLE FROM CONFIGURED ROOTS (Review candidates; no automatic deletion):",
  );
  totallyDead.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const leaked = unique(stats.leakedInternal);
if (leaked.length > 0) {
  console.log(
    "LEAKED INTERNALS (Marked @internal but exported by public package/bin API):",
  );
  leaked.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const missing = unique(stats.missingInternalTag);
if (missing.length > 0) {
  console.log("MISSING @internal TAG (Used only by TESTS):");
  missing.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const prodInternal = unique(stats.prodInternalExport);
if (prodInternal.length > 0) {
  console.log(
    "PACKAGE/BIN-REACHABLE INTERNAL EXPORTS (Not part of configured root API):",
  );
  prodInternal.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

for (const [label, entries] of [
  [
    "TOOL-REACHABLE EXPORTS (Maintenance/build/benchmarks; not public API)",
    stats.toolExport,
  ],
  ["NODE TEST LIFECYCLE EXPORTS", stats.lifecycleExport],
] as const) {
  const locations = unique([...entries]);
  if (locations.length === 0) continue;
  console.log(`${label}:`);
  locations.forEach((location) => console.log(`  - ${location}`));
  console.log("");
}

console.log(
  "Scope: TypeScript/JavaScript exports only. Dynamic consumers, TripLang entrypoints, C runtime symbols, and data fixtures require separate review.",
);

console.log(`SUMMARY:
  - Public API Symbols:    ${unique(stats.publicApi).length}
  - Prod Internal Exports: ${unique(stats.prodInternalExport).length}
  - Well-behaved Internals: ${unique(stats.wellBehavedInternal).length}
  - Tool Exports:          ${unique(stats.toolExport).length}
  - Lifecycle Exports:     ${unique(stats.lifecycleExport).length}
  - Root Warnings:         ${rootWarnings.size}
  - Issues Found:          ${
    totallyDead.length + leaked.length + missing.length
  }
`);
