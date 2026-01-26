#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * System F Term and Type SVG Generator
 *
 * Generates SVG visualizations of both the term structure (Church numerals).
 * Creates DOT files and converts them to SVG.
 */

import { parseSystemF } from "../lib/parser/systemFTerm.ts";
import { forall, typecheck } from "../lib/types/systemF.ts";
import { unparseSystemFType } from "../lib/parser/systemFType.ts";
import { systemFToTypedLambda } from "../lib/meta/frontend/lowering.ts";
import { unparseTypedLambda } from "../lib/parser/typedLambda.ts";
import type { BaseType } from "../lib/types/types.ts";
import type { TypedLambda } from "../lib/types/typedLambda.ts";
import { arrow, mkTypeVariable } from "../lib/types/types.ts";
import { VERSION } from "../lib/shared/version.ts";

interface CLIArgs {
  outputDir: string;
  verbose: boolean;
  concurrency: number;
}

function parseArgs(): CLIArgs {
  const args = Deno.args;

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    Deno.exit(0);
  }

  if (args.includes("--version")) {
    console.log(`genTypeSvg v${VERSION}`);
    Deno.exit(0);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");

  // Parse concurrency option
  const concurrencyIndex = args.findIndex((arg) =>
    arg.startsWith("--concurrency=")
  );
  const concurrency = concurrencyIndex !== -1
    ? Number.parseInt(args[concurrencyIndex].split("=")[1], 10)
    : 64;

  const outputDir = "type_svg";

  return { outputDir, verbose, concurrency };
}

function printHelp(): void {
  console.log(`System F Type SVG Generator v${VERSION}

USAGE:
    genTypeSvg [options]

OPTIONS:
    --verbose, -v           Enable verbose output
    --concurrency=N         Number of concurrent sfdp processes (default: 64)
    --help, -h              Show this help message
    --version               Show version information

EXAMPLES:
    genTypeSvg                    # Generate SVG for numbers 0-9
    genTypeSvg -v                 # Generate with verbose output
    genTypeSvg --concurrency=32   # Use 32 concurrent processes

OUTPUT:
    Creates a directory 'type_svg' containing:
    - DOT files for each number (type_0.dot, type_1.dot, ...)
    - SVG files for each number (type_0.svg, type_1.svg, ...)
    - Each visualization shows both the term structure (Church numeral) and type structure
    - Generated using Graphviz's neato layout algorithm

REQUIREMENTS:
    - Graphviz with neato command must be installed
`);
}

/**
 * Recursively expands Nat type variables to their full definition: ∀X . (X → X) → X → X
 */
function expandNatTypes(ty: BaseType): BaseType {
  if (ty.kind === "type-var" && ty.typeName === "Nat") {
    const X = mkTypeVariable("X");
    return forall(
      "X",
      arrow(
        arrow(X, X),
        arrow(X, X),
      ),
    );
  } else if (ty.kind === "non-terminal") {
    return arrow(
      expandNatTypes(ty.lft),
      expandNatTypes(ty.rgt),
    );
  } else if (ty.kind === "forall") {
    return forall(ty.typeVar, expandNatTypes(ty.body));
  }
  return ty;
}

/**
 * Recursively expands Nat types in a TypedLambda term
 */
function expandNatTypesInTerm(term: TypedLambda): TypedLambda {
  switch (term.kind) {
    case "lambda-var":
      return term;
    case "typed-lambda-abstraction":
      return {
        kind: "typed-lambda-abstraction",
        varName: term.varName,
        ty: expandNatTypes(term.ty),
        body: expandNatTypesInTerm(term.body),
      };
    case "non-terminal":
      return {
        kind: "non-terminal",
        lft: expandNatTypesInTerm(term.lft),
        rgt: expandNatTypesInTerm(term.rgt),
      };
  }
}

/**
 * Converts a TypedLambda term and its type to a combined DOT graph representation
 */
function termAndTypeToDot(
  term: TypedLambda,
  overallType: BaseType,
  number: number,
): string {
  let nodeCounter = 0;
  const termNodeIds = new Map<TypedLambda, string>();
  const typeNodeIds = new Map<BaseType, string>();
  const edges: string[] = [];
  const nodeLabels: Map<string, string> = new Map();
  const nodeColors: Map<string, string> = new Map();
  const nodeShapes: Map<string, string> = new Map();

  // Prefix for term nodes
  const TERM_PREFIX = "t";
  // Prefix for type nodes
  const TYPE_PREFIX = "ty";

  function getTermNodeId(term: TypedLambda): string {
    if (!termNodeIds.has(term)) {
      const id = `${TERM_PREFIX}${nodeCounter++}`;
      termNodeIds.set(term, id);
      return id;
    }
    return termNodeIds.get(term)!;
  }

  function getTypeNodeId(ty: BaseType): string {
    if (!typeNodeIds.has(ty)) {
      const id = `${TYPE_PREFIX}${nodeCounter++}`;
      typeNodeIds.set(ty, id);
      return id;
    }
    return typeNodeIds.get(ty)!;
  }

  function traverseTerm(term: TypedLambda, parentId: string | null): void {
    const nodeId = getTermNodeId(term);

    // Create label for this term node
    let label: string;
    let color: string;
    let shape: string = "box";

    switch (term.kind) {
      case "lambda-var":
        label = term.name;
        color = "#4a5568"; // dark gray
        shape = "ellipse";
        break;
      case "typed-lambda-abstraction": {
        label = `λ${term.varName}`;
        color = "#2d3748"; // darker gray
        shape = "diamond";
        // Add edge to the type of this abstraction
        const paramTypeId = getTypeNodeId(term.ty);
        edges.push(
          `  ${nodeId} -> ${paramTypeId} [style=dashed, color="#718096", label=":"];`,
        );
        traverseType(term.ty, null);
        break;
      }
      case "non-terminal":
        label = "@";
        color = "#1a202c"; // almost black
        shape = "circle";
        break;
    }
    nodeLabels.set(nodeId, label);
    nodeColors.set(nodeId, color);
    nodeShapes.set(nodeId, shape);

    // Create edge from parent if exists
    if (parentId !== null) {
      edges.push(`  ${parentId} -> ${nodeId};`);
    }

    // Traverse children
    if (term.kind === "typed-lambda-abstraction") {
      traverseTerm(term.body, nodeId);
    } else if (term.kind === "non-terminal") {
      traverseTerm(term.lft, nodeId);
      traverseTerm(term.rgt, nodeId);
    }
  }

  function traverseType(ty: BaseType, parentId: string | null): void {
    const nodeId = getTypeNodeId(ty);

    // Create label for this type node
    let label: string;
    let color: string;
    let shape: string = "box";

    switch (ty.kind) {
      case "type-var":
        label = ty.typeName;
        color = "#553c9a"; // dark purple
        shape = "ellipse";
        break;
      case "forall":
        label = `∀${ty.typeVar}`;
        color = "#6b46c1"; // deep purple
        shape = "diamond";
        break;
      case "non-terminal":
        label = "→";
        color = "#7c2d12"; // dark red/brown
        shape = "circle";
        break;
    }
    nodeLabels.set(nodeId, label);
    nodeColors.set(nodeId, color);
    nodeShapes.set(nodeId, shape);

    // Create edge from parent if exists
    if (parentId !== null) {
      edges.push(`  ${parentId} -> ${nodeId} [style=dashed, color="#718096"];`);
    }

    // Traverse children
    if (ty.kind === "forall") {
      traverseType(ty.body, nodeId);
    } else if (ty.kind === "non-terminal") {
      traverseType(ty.lft, nodeId);
      traverseType(ty.rgt, nodeId);
    }
  }

  // Start traversal from term root
  const termRootId = getTermNodeId(term);
  traverseTerm(term, null);

  // Add overall type as a separate cluster
  const overallTypeId = getTypeNodeId(overallType);
  traverseType(overallType, null);

  // Connect term root to overall type with constraint to keep them together
  edges.push(
    `  ${termRootId} -> ${overallTypeId} [style=bold, color="#9f7aea", label="::", constraint=false];`,
  );

  // Build DOT content
  const termStr = unparseTypedLambda(term);
  const typeStr = unparseSystemFType(overallType);

  let dotContent = `digraph "TermAndType_${number}" {\n`;
  // Escape quotes and special characters for the label
  const escapedTermStr = termStr.replace(/"/g, '\\"').replace(/\n/g, " ");
  const escapedTypeStr = typeStr.replace(/"/g, '\\"');
  dotContent += `  label="${escapedTermStr} :: ${escapedTypeStr}";\n`;
  dotContent += `  labelloc="t";\n`;
  dotContent += `  labeljust="l";\n`;
  dotContent += `  fontname="Fira Code";\n`;
  dotContent += `  fontsize=12;\n`;
  dotContent += `  fontcolor="#9f7aea";\n`;

  // Add comment with the symbolic typed lambda form
  dotContent += `  // Term: ${termStr}\n`;
  dotContent += `  // Type: ${typeStr}\n`;
  dotContent += `\n`;

  dotContent += `  rankdir=TB;\n`;
  dotContent += `  bgcolor="#1a202c";\n`;
  dotContent +=
    `  node [style=filled, fontname="Fira Code", fontsize=9, fontcolor="#9f7aea"];\n`;
  dotContent +=
    `  edge [fontname="Fira Code", fontsize=7, color="#cbd5e0"];\n\n`;

  // Create clusters for term and type
  dotContent += `  subgraph cluster_term {\n`;
  dotContent += `    label="Term";\n`;
  dotContent += `    style=dashed;\n`;
  dotContent += `    color="#4a5568";\n`;
  dotContent += `    fontcolor="#9f7aea";\n`;
  dotContent += `    fontname="Fira Code";\n`;

  // Add term nodes (inside cluster)
  for (const [_term, nodeId] of termNodeIds.entries()) {
    const label = nodeLabels.get(nodeId) || "?";
    const color = nodeColors.get(nodeId) || "lightgray";
    const shape = nodeShapes.get(nodeId) || "box";
    const escapedLabel = label.replace(/"/g, '\\"');
    dotContent +=
      `    ${nodeId} [label="${escapedLabel}", fillcolor="${color}", shape="${shape}"];\n`;
  }
  dotContent += `  }\n\n`;

  dotContent += `  subgraph cluster_type {\n`;
  dotContent += `    label="Type";\n`;
  dotContent += `    style=dashed;\n`;
  dotContent += `    color="#553c9a";\n`;
  dotContent += `    fontcolor="#9f7aea";\n`;
  dotContent += `    fontname="Fira Code";\n`;

  // Add type nodes (inside cluster)
  for (const [_ty, nodeId] of typeNodeIds.entries()) {
    const label = nodeLabels.get(nodeId) || "?";
    const color = nodeColors.get(nodeId) || "lightgray";
    const shape = nodeShapes.get(nodeId) || "box";
    const escapedLabel = label.replace(/"/g, '\\"');
    dotContent +=
      `    ${nodeId} [label="${escapedLabel}", fillcolor="${color}", shape="${shape}"];\n`;
  }
  dotContent += `  }\n\n`;

  dotContent += `\n`;

  // Add edges
  for (const edge of edges) {
    dotContent += `${edge}\n`;
  }

  dotContent += `}\n`;
  return dotContent;
}

async function generateDotFiles(
  outputDir: string,
  verbose: boolean,
): Promise<string[]> {
  if (verbose) {
    console.error(`Generating DOT files for numbers 0-9...`);
  }

  const dotFiles: string[] = [];

  for (let num = 0; num <= 9; num++) {
    try {
      // Parse the number as a System F term
      const [, systemFTerm] = parseSystemF(String(num));

      // Get the System F type (this is Nat = ∀X . (X → X) → X → X)
      const systemFType = typecheck(systemFTerm);

      // Convert to typed lambda (this expands the Church numeral)
      let typedTerm = systemFToTypedLambda(systemFTerm);

      // Expand Nat types everywhere in the term
      typedTerm = expandNatTypesInTerm(typedTerm);

      // Use the System F type and expand Nat to its full definition: ∀X . (X → X) → X → X
      const overallType = expandNatTypes(systemFType);

      // Generate DOT content with both term and type
      const dotContent = termAndTypeToDot(typedTerm, overallType, num);
      const dotPath = `${outputDir}/type_${num}.dot`;

      await Deno.writeTextFile(dotPath, dotContent);
      dotFiles.push(dotPath);

      if (verbose) {
        const typeStr = unparseSystemFType(overallType);
        console.error(`Number ${num}: type = ${typeStr}`);
      }
    } catch (error) {
      console.error(`Error processing number ${num}:`, error);
      Deno.exit(1);
    }
  }

  if (verbose) {
    console.error(`Generated ${dotFiles.length} DOT files`);
  }

  return dotFiles;
}

async function generateSvgFiles(
  dotFiles: string[],
  concurrency: number,
  verbose: boolean,
): Promise<void> {
  if (verbose) {
    console.error(`Running graphviz to generate SVG...`);
  }

  let idx = 0;

  async function runNeato(dotPath: string): Promise<void> {
    const svgPath = dotPath.replace(/\.dot$/, ".svg");
    const dot = new Deno.Command("dot", {
      args: [
        "-Tsvg",
        dotPath,
        "-o",
        svgPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { success, stderr } = await dot.output();

    if (!success) {
      const errorMsg = new TextDecoder().decode(stderr);
      console.error(`dot failed for ${dotPath}: ${errorMsg}`);
    } else if (verbose) {
      console.error(`Generated: ${dotPath} -> ${svgPath}`);
    }
  }

  while (idx < dotFiles.length) {
    const batch = dotFiles.slice(idx, idx + concurrency);
    await Promise.all(batch.map(runNeato));
    idx += concurrency;

    if (verbose) {
      console.error(
        `Processed ${
          Math.min(idx, dotFiles.length)
        } / ${dotFiles.length} SVG files (${
          ((Math.min(idx, dotFiles.length) / dotFiles.length) * 100).toFixed(2)
        }%)`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { outputDir, verbose, concurrency } = parseArgs();

  if (verbose) {
    console.error(
      `Arguments: outputDir=${outputDir}, concurrency=${concurrency}`,
    );
  }

  await Deno.mkdir(outputDir, { recursive: true });
  const dotFiles = await generateDotFiles(outputDir, verbose);
  await generateSvgFiles(dotFiles, concurrency, verbose);

  console.log(`Generated ${dotFiles.length} SVG files in ${outputDir}`);
}

if (import.meta.main) {
  await main();
}
