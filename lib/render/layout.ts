import {
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
} from "../evaluator/arenaViews.ts";

import { ArenaKind } from "../shared/arena.ts";

import {
  applyHyperbolicStep,
  type Quat,
  quatFromEulerDeg,
  type Vec3,
} from "./matrix.ts";

export type LayoutEdge = {
  from: Vec3;
  to: Vec3;
  startDepth: number;
};

export type ForestLayoutConfig = {
  hStepSize: number;
  branchAngleDeg: number;
  maxNodes: number;
  geodesicSteps: number;
};

export function buildLayoutFromAtoms(
  memory: WebAssembly.Memory,
  exports: { debugGetArenaBaseAddr?: () => number },
  config: ForestLayoutConfig,
): Array<LayoutEdge> {
  const baseAddr = exports.debugGetArenaBaseAddr?.() ?? 0;
  if (!baseAddr) return [];
  const views = getOrBuildArenaViews(memory, exports);
  if (!views) return [];

  const edges: LayoutEdge[] = [];
  const visibleArenaTop = Math.min(config.maxNodes, views.capacity - 1);

  // pre-pass: build inverse graph
  const usedBy: Map<number, Set<number>> = new Map();
  const atoms: number[] = [];

  for (let id = 0; id <= visibleArenaTop; id++) {
    const kind = getKind(id, views);

    if (kind === ArenaKind.Terminal) {
      atoms.push(id);
    } else if (kind === ArenaKind.NonTerm) {
      const left = getLeft(id, views);
      const right = getRight(id, views);

      if (!usedBy.has(left)) usedBy.set(left, new Set());
      if (!usedBy.has(right)) usedBy.set(right, new Set());

      usedBy.get(left)!.add(id);
      usedBy.get(right)!.add(id);
    }
  }

  // weight calculation: how many nodes are "above" this node?
  const weights = new Map<number, number>();

  function getWeight(id: number): number {
    if (weights.has(id)) return weights.get(id)!;

    // Base weight is 1 (the node itself)
    let w = 1;
    const parents = usedBy.get(id);
    if (parents) {
      for (const p of parents) {
        w += getWeight(p);
      }
    }
    weights.set(id, w);
    return w;
  }

  // Pre-calculate weights for all atoms to prime the cache
  for (const atom of atoms) getWeight(atom);

  // bfs traversal
  const queue: { id: number; pos: Vec3; rot: Quat; depth: number }[] = [];
  const visited: Set<number> = new Set(); // tracks "queued" not "drawn"
  const atomCount = atoms.length;
  const anglePerAtom = atomCount > 0 ? 360 / atomCount : 0;

  for (let i = 0; i < atomCount; i++) {
    const atomId = atoms[i];
    if (visited.has(atomId)) continue;

    // distribute atoms in a ring
    const headingDeg = i * anglePerAtom;
    const initialRot = quatFromEulerDeg(0, 0, headingDeg);

    queue.push({
      id: atomId,
      pos: [0, 0, 0],
      rot: initialRot,
      depth: 0,
    });

    visited.add(atomId);
  }

  while (queue.length > 0) {
    if (edges.length >= config.maxNodes) break;

    const curr = queue.shift()!;
    const parents = usedBy.get(curr.id);

    if (parents && parents.size > 0) {
      // calculate total weight of immediate parents
      let totalWeight = 0;
      for (const p of parents) totalWeight += getWeight(p);

      // define the total arc available for this fan-out
      // we can go wider than before because we know we are filling gaps.
      const totalArc = config.branchAngleDeg * 2.5;

      // start angle (relative to current heading)
      let currentAngle = -(totalArc / 2);

      for (const parentId of parents) {
        // calculate weighted slice
        const pWeight = getWeight(parentId);
        const weightRatio = pWeight / totalWeight;
        const mySlice = totalArc * weightRatio;

        // center the branch within its slice
        const branchAngle = currentAngle + (mySlice / 2);

        const nextTx = applyHyperbolicStep(
          curr.pos,
          curr.rot,
          branchAngle,
          config.hStepSize,
        );

        // draw the edge
        edges.push({
          from: curr.pos,
          to: nextTx.pos,
          startDepth: curr.depth,
        });

        // recurse if new
        if (!visited.has(parentId)) {
          queue.push({
            id: parentId,
            pos: nextTx.pos,
            rot: nextTx.rot,
            depth: curr.depth + 1,
          });
          visited.add(parentId);
        }

        // advance angle
        currentAngle += mySlice;
      }
    }
  }

  return edges;
}
