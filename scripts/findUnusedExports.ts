#!/usr/bin/env -S deno run -A

import { Node, Project, SyntaxKind } from "ts-morph";
import { join } from "std/path";

const project = new Project({
  useInMemoryFileSystem: true,
});

const dirs = ["lib", "bin", "test", "server"];
const files: string[] = [];

function findFiles(dir: string, depth = 0) {
  try {
    for (const entry of Deno.readDirSync(dir)) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile) {
        if (
          entry.name.endsWith(".ts") ||
          entry.name.endsWith(".tsx") ||
          (dir.startsWith("server") && entry.name.endsWith(".js"))
        ) {
          files.push(fullPath);
        }
      } else if (entry.isDirectory) {
        findFiles(fullPath, depth + 1);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(e);
    }
  }
}

for (const dir of dirs) findFiles(dir);

console.log(`Analyzing ${files.length} files...`);

for (const file of files) {
  try {
    const content = Deno.readTextFileSync(file);
    project.createSourceFile(file, content);
  } catch (e) {
    console.error(`Failed to read ${file}: ${e}`);
  }
}

const PROD_ROOTS = [
  "lib/index.ts",
  "bin/tripc.ts",
  "server/serveWorkbench.ts",
  "server/webglForest.ts",
];
const TEST_ROOTS = files.filter((f) => f.startsWith("test/"));

function isInternal(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isJSDocable(current)) {
      if (
        current.getJsDocs().some((doc) => doc.getText().includes("@internal"))
      ) {
        return true;
      }
    }
    if (Node.isVariableDeclaration(current)) {
      const statement = current.getVariableStatement();
      if (
        statement &&
        statement.getJsDocs().some((doc) => doc.getText().includes("@internal"))
      ) {
        return true;
      }
    }
    if (Node.isSourceFile(current)) break;
    current = current.getParent();
  }
  return false;
}

function traceReachability(rootFiles: string[]): Set<Node> {
  const reachable = new Set<Node>();
  const queue: Node[] = [];

  for (const rootFile of rootFiles) {
    const sourceFile = project.getSourceFile(rootFile);
    if (!sourceFile) continue;

    for (const declarations of sourceFile.getExportedDeclarations().values()) {
      for (const decl of declarations) {
        if (!reachable.has(decl)) {
          reachable.add(decl);
          queue.push(decl);
        }
      }
    }

    sourceFile.forEachDescendant((node) => {
      if (
        Node.isStatement(node) && !Node.isExportDeclaration(node) &&
        !Node.isExportSpecifier(node)
      ) {
        node.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id) => {
          id.getDefinitions().forEach((def) => {
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
    current.getDescendantsOfKind(SyntaxKind.Identifier).forEach((id) => {
      id.getDefinitions().forEach((def) => {
        const decl = def.getDeclarationNode();
        if (decl && !reachable.has(decl)) {
          const sourceFile = decl.getSourceFile();
          if (
            sourceFile && !sourceFile.getFilePath().includes("node_modules")
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

console.log("Tracing production reachability...");
const productionReachable = traceReachability(PROD_ROOTS);

console.log("Tracing test reachability...");
const testReachable = traceReachability(TEST_ROOTS);

const stats = {
  totallyDead: [] as string[],
  leakedInternal: [] as string[],
  missingInternalTag: [] as string[],
  wellBehavedInternal: [] as string[],
  publicApi: [] as string[],
  serverOnly: [] as string[],
};

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath().substring(1);
  if (PROD_ROOTS.includes(filePath)) continue;
  if (filePath.endsWith(".d.ts")) continue;

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const decl of declarations) {
      const isProd = productionReachable.has(decl);
      const isTest = testReachable.has(decl);
      const tagged = isInternal(decl);
      const location = `${filePath}:${name}`;

      const isExportedFromRoot = PROD_ROOTS.some((root) => {
        const sf = project.getSourceFile(root);
        return sf?.getExportedDeclarations().has(name);
      });

      if (!isProd && !isTest) {
        const isServer = files.filter((f) => f.startsWith("server/")).some(
          (f) => {
            const content = Deno.readTextFileSync(f);
            return content.includes(name);
          },
        );
        if (isServer) stats.serverOnly.push(location);
        else stats.totallyDead.push(location);
      } else if (isProd && tagged) {
        if (isExportedFromRoot) {
          stats.leakedInternal.push(location);
        } else {
          stats.wellBehavedInternal.push(location);
        }
      } else if (isProd && !tagged) {
        stats.publicApi.push(location);
      } else if (!isProd && isTest) {
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
  console.log("TOTALLY UNREACHABLE (Safe to delete):");
  totallyDead.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const leaked = unique(stats.leakedInternal);
if (leaked.length > 0) {
  console.log("LEAKED INTERNALS (Marked @internal but used by PROD):");
  leaked.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const missing = unique(stats.missingInternalTag);
if (missing.length > 0) {
  console.log("MISSING @internal TAG (Used only by TESTS):");
  missing.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

const server = unique(stats.serverOnly);
if (server.length > 0) {
  console.log("SERVER-ONLY (Used by workbench JS):");
  server.forEach((e) => console.log(`  - ${e}`));
  console.log("");
}

console.log(`SUMMARY:
  - Public API Symbols:    ${unique(stats.publicApi).length}
  - Well-behaved Internals: ${unique(stats.wellBehavedInternal).length}
  - Issues Found:          ${
  totallyDead.length + leaked.length + missing.length
}
`);
