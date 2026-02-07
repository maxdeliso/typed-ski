/**
 * Pure graph algorithms used by the linker.
 */

export type DirectedGraph<Node> = ReadonlyMap<Node, ReadonlySet<Node>>;

type TarjanWorkFrame<Node> =
  | {
    node: Node;
    phase: "enter";
  }
  | {
    node: Node;
    phase: "process";
    deps: Node[];
    depIndex: number;
  };

/**
 * Tarjan's algorithm for finding strongly connected components (iterative).
 *
 * Returns SCCs in reverse topological order.
 */
export function tarjanSCC<Node>(graph: DirectedGraph<Node>): Node[][] {
  const index = new Map<Node, number>();
  const lowlink = new Map<Node, number>();
  const onStack = new Set<Node>();
  const stack: Node[] = [];
  const sccs: Node[][] = [];
  let currentIndex = 0;
  const workStack: TarjanWorkFrame<Node>[] = [];

  for (const node of graph.keys()) {
    if (index.has(node)) continue;
    workStack.push({ node, phase: "enter" });

    while (workStack.length > 0) {
      const work = workStack.pop();
      if (!work) {
        continue;
      }

      if (work.phase === "enter") {
        index.set(work.node, currentIndex);
        lowlink.set(work.node, currentIndex);
        currentIndex++;
        stack.push(work.node);
        onStack.add(work.node);

        const deps = Array.from(graph.get(work.node) ?? []);
        workStack.push({
          node: work.node,
          phase: "process",
          deps,
          depIndex: 0,
        });
        continue;
      }

      let depIndex = work.depIndex;
      while (depIndex < work.deps.length) {
        const dep = work.deps[depIndex];
        if (dep === undefined) {
          depIndex++;
          continue;
        }

        if (!index.has(dep)) {
          workStack.push({
            node: work.node,
            phase: "process",
            deps: work.deps,
            depIndex: depIndex + 1,
          });
          workStack.push({ node: dep, phase: "enter" });
          break;
        }

        if (onStack.has(dep)) {
          const currentLow = lowlink.get(work.node);
          const depIndexValue = index.get(dep);
          if (currentLow !== undefined && depIndexValue !== undefined) {
            lowlink.set(work.node, Math.min(currentLow, depIndexValue));
          }
        }
        depIndex++;
      }

      if (depIndex >= work.deps.length) {
        const nodeLow = lowlink.get(work.node);
        const nodeIndex = index.get(work.node);
        if (
          nodeLow !== undefined && nodeIndex !== undefined &&
          nodeLow === nodeIndex
        ) {
          const scc: Node[] = [];
          while (stack.length > 0) {
            const popped = stack.pop();
            if (popped === undefined) break;
            onStack.delete(popped);
            scc.push(popped);
            if (popped === work.node) break;
          }
          sccs.push(scc);
        }

        const parent = workStack[workStack.length - 1];
        if (parent && parent.phase === "process") {
          const parentLow = lowlink.get(parent.node);
          const childLow = lowlink.get(work.node);
          if (parentLow !== undefined && childLow !== undefined) {
            lowlink.set(parent.node, Math.min(parentLow, childLow));
          }
        }
      }
    }
  }

  return sccs;
}

/**
 * Returns SCCs in dependency order (topological order of SCC DAG).
 */
export function sccDependencyOrder<Node>(graph: DirectedGraph<Node>): Node[][] {
  return tarjanSCC(graph).reverse();
}
