import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  type DirectedGraph,
  sccDependencyOrder,
  tarjanSCC,
} from "../../lib/linker/graph.ts";

type Edge = [string, string];

function buildGraph(nodes: string[], edges: Edge[]): DirectedGraph<string> {
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

describe("linker graph algorithms", () => {
  it("tarjanSCC groups cyclic nodes into one SCC", () => {
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
    assert.deepStrictEqual(canonicalizeSccs(sccs), [["A", "B"], ["C"], ["D"]]);
  });

  it("tarjanSCC treats self-loops as singleton SCCs", () => {
    const graph = buildGraph(["Self", "Leaf"], [["Self", "Self"]]);

    const sccs = tarjanSCC(graph);
    assert.deepStrictEqual(canonicalizeSccs(sccs), [["Leaf"], ["Self"]]);
  });

  it("sccDependencyOrder respects inter-SCC dependency order", () => {
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
      assert.ok(componentIndex.has(node), `missing node ${node}`);
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
          assert.ok(
            toIndex < fromIndex,
            `expected dependency order ${to} comes before ${from}`,
          );
        }
      }
    }
  });

  it("tarjanSCC returns singleton SCCs for an acyclic graph", () => {
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
    assert.deepStrictEqual(canonical, [["N1"], ["N2"], ["N3"], ["N4"]]);
  });

  it("tarjanSCC handles graph with undefined dependencies", () => {
    // We use a bit of casting to force undefined into the graph if the type allows it,
    // or just test how it handles missing nodes in the graph map.
    const graph: DirectedGraph<string> = new Map([
      ["A", new Set([undefined as unknown as string])],
    ]);

    const sccs = tarjanSCC(graph);
    assert.strictEqual(sccs.length, 1);
    assert.deepStrictEqual(sccs[0], ["A"]);
  });

  it("tarjanSCC handles nodes not present in the graph map", () => {
    const graph: DirectedGraph<string> = new Map([
      ["A", new Set(["B"])],
      // "B" is not a key in the map
    ]);

    const sccs = tarjanSCC(graph);
    // B should be treated as a node with no dependencies
    assert.strictEqual(sccs.length, 2);
    // Reverse topological order: B then A
    assert.deepStrictEqual(sccs[0], ["B"]);
    assert.deepStrictEqual(sccs[1], ["A"]);
  });

  it("tarjanSCC handles empty graph", () => {
    const graph: DirectedGraph<string> = new Map();
    const sccs = tarjanSCC(graph);
    assert.strictEqual(sccs.length, 0);
  });

  it("scc ordering is deterministic across insertion order", () => {
    const graphA = buildGraph(
      ["C", "A", "B", "D"],
      [
        ["C", "D"],
        ["A", "B"],
        ["B", "A"],
      ],
    );
    const graphB = buildGraph(
      ["D", "B", "A", "C"],
      [
        ["B", "A"],
        ["A", "B"],
        ["C", "D"],
      ],
    );

    assert.deepStrictEqual(
      sccDependencyOrder(graphA),
      sccDependencyOrder(graphB),
    );
  });
});
