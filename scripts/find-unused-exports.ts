#!/usr/bin/env -S deno run -A

// deno-lint-ignore no-import-prefix no-unversioned-import
import { Node, Project } from "npm:ts-morph";
import { join } from "std/path";

const project = new Project({
  useInMemoryFileSystem: true,
});

// Add source files
const dirs = ["lib", "bin", "test", "server"];
const files: string[] = [];

for (const dir of dirs) {
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (
        entry.isFile &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        files.push(join(dir, entry.name));
      } else if (entry.isDirectory) {
        // Simple 1-level recursion for now, adjust if deeper structure needed
        try {
          for (const sub of Deno.readDirSync(join(dir, entry.name))) {
            if (
              sub.isFile &&
              (sub.name.endsWith(".ts") || sub.name.endsWith(".tsx"))
            ) {
              files.push(join(dir, entry.name, sub.name));
            } else if (sub.isDirectory) {
              // 2-level recursion
              try {
                for (
                  const sub2 of Deno.readDirSync(
                    join(dir, entry.name, sub.name),
                  )
                ) {
                  if (
                    sub2.isFile &&
                    (sub2.name.endsWith(".ts") || sub2.name.endsWith(".tsx"))
                  ) {
                    files.push(join(dir, entry.name, sub.name, sub2.name));
                  }
                }
              } catch {
                // Ignore error
              }
            }
          }
        } catch {
          // Ignore error
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(e);
    }
  }
}

console.log(`Analyzing ${files.length} files...`);

for (const file of files) {
  const content = Deno.readTextFileSync(file);
  project.createSourceFile(file, content);
}

const entryPoints = [
  "lib/index.ts",
  "bin/tripc.ts",
  "bin/genForest.ts",
  "bin/genSvg.ts",
  "bin/genTypeSvg.ts",
];

const unusedExports: string[] = [];

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath().substring(1); // Remove leading slash
  if (entryPoints.includes(filePath)) continue;
  if (filePath.endsWith(".d.ts")) continue;

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    let isUsed = false;

    // Check if it's used in other files
    for (const decl of declarations) {
      if (Node.isReferenceFindable(decl)) {
        const refs = decl.findReferencesAsNodes();
        // Filter refs: ignore self-references (declarations themselves) and internal usage in the same file
        const externalRefs = refs.filter((ref) => {
          const refSourceFile = ref.getSourceFile();
          return refSourceFile !== sourceFile;
        });

        if (externalRefs.length > 0) {
          isUsed = true;
          break;
        }
      }
    }

    if (!isUsed) {
      unusedExports.push(`${filePath}: ${name}`);
    }
  }
}

if (unusedExports.length > 0) {
  console.log("Potential unused exports:");
  unusedExports.forEach((e) => console.log(e));
} else {
  console.log("No unused exports found.");
}
