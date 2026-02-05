import { expect } from "chai";
import {
  type DirectedGraph,
  sccDependencyOrder,
  tarjanSCC,
} from "../../lib/linker/graph.ts";

type Edge = [string, string];

function buildGraph(
  nodes: string[],
  edges: Edge[],
): DirectedGraph<string> {
  const graph = new Map<string, Set<string>>();
  for (const node of nodes) {
    graph.set(node, new Set());
  }
  for (const [from, to] of edges) {
    const deps = graph.get(from);
    if (!deps) {
      throw new Error(`Unknown node '${from}'`);
    }
    deps.add(to);
  }
  return graph;
}

function canonicalizeSccs(sccs: string[][]): string[][] {
  return sccs
    .map((scc) => [...scc].sort())
    .sort((a, b) => {
      const aKey = a.join("|");
      const bKey = b.join("|");
      return aKey.localeCompare(bKey);
    });
}

Deno.test("linker graph algorithms", async (t) => {
  await t.step("tarjanSCC groups cyclic nodes into one SCC", () => {
    const graph = buildGraph(
      ["A", "B", "C", "D"],
      [
        ["A", "B"],
        ["B", "A"],
        ["B", "C"],
        ["C", "D"],
      ],
    );

    const sccs = tarjanSCC(graph);
    expect(canonicalizeSccs(sccs)).to.deep.equal([
      ["A", "B"],
      ["C"],
      ["D"],
    ]);
  });

  await t.step("tarjanSCC treats self-loops as singleton SCCs", () => {
    const graph = buildGraph(
      ["Self", "Leaf"],
      [
        ["Self", "Self"],
      ],
    );

    const sccs = tarjanSCC(graph);
    expect(canonicalizeSccs(sccs)).to.deep.equal([
      ["Leaf"],
      ["Self"],
    ]);
  });

  await t.step("sccDependencyOrder respects inter-SCC dependency order", () => {
    const graph = buildGraph(
      ["A", "B", "C", "D", "E", "F"],
      [
        ["A", "B"],
        ["B", "C"],
        ["C", "B"], // SCC: B,C
        ["C", "D"],
        ["D", "E"],
        ["E", "D"], // SCC: D,E
        // F is isolated
      ],
    );

    const orderedSccs = sccDependencyOrder(graph);

    const componentIndex = new Map<string, number>();
    orderedSccs.forEach((scc, i) => {
      for (const node of scc) {
        componentIndex.set(node, i);
      }
    });

    for (const node of graph.keys()) {
      expect(componentIndex.has(node), `missing node ${node}`).to.equal(true);
    }

    for (const [from, deps] of graph) {
      const fromIndex = componentIndex.get(from);
      if (fromIndex === undefined) {
        throw new Error(`Missing SCC index for '${from}'`);
      }
      for (const to of deps) {
        const toIndex = componentIndex.get(to);
        if (toIndex === undefined) {
          throw new Error(`Missing SCC index for '${to}'`);
        }
        if (fromIndex !== toIndex) {
          expect(
            fromIndex < toIndex,
            `expected dependency order ${from} -> ${to}`,
          ).to.equal(true);
        }
      }
    }
  });

  await t.step("tarjanSCC returns singleton SCCs for an acyclic graph", () => {
    const graph = buildGraph(
      ["N1", "N2", "N3", "N4"],
      [
        ["N1", "N2"],
        ["N2", "N3"],
        ["N3", "N4"],
      ],
    );

    const sccs = tarjanSCC(graph);
    const canonical = canonicalizeSccs(sccs);
    expect(canonical).to.deep.equal([["N1"], ["N2"], ["N3"], ["N4"]]);
  });
});
