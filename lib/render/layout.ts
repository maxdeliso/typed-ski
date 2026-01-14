import {
  arenaTop,
  getKind,
  getLeft,
  getOrBuildArenaViews,
  getRight,
  getSym,
} from "../evaluator/arenaViews.ts";

import { ArenaKind } from "../shared/arena.ts";

import {
  hyperToEuclidDist,
  mobiusAdd,
  type Quat,
  quatFromEulerDeg,
  quatMul,
  v3RotateByQuat,
  type Vec3,
} from "./matrix.ts";

export type LayoutEdge = { from: Vec3; to: Vec3 };

export type ForestLayoutConfig = {
  hStepSize: number;
  branchAngleDeg: number;
  geodesicSteps: number;
  maxNodes: number; // Used as a hard edge limit now
};

// State for the traversal stack
type TraversalState = {
  id: number;
  pos: Vec3; // [number, number, number]
  rot: Quat; // [number, number, number, number]
  depth: number;
};

export function buildLayoutFromRoots(
  memory: WebAssembly.Memory,
  exports: { debugGetArenaBaseAddr?: () => number },
  config: ForestLayoutConfig,
): Array<LayoutEdge> {
  const baseAddr = exports.debugGetArenaBaseAddr?.() ?? 0;

  if (!baseAddr) {
    return [];
  }

  const views = getOrBuildArenaViews(memory, exports);

  if (!views) {
    return [];
  }

  const edges: LayoutEdge[] = [];
  const globalVisited: Set<number> = new Set();

  // Use config.maxNodes as a hard limit on edges to prevent crashing
  const EDGE_LIMIT = config.maxNodes;

  // The scan limit for the outer loop can still be the arena capacity
  const visibleArenaTop = views.capacity - 1;

  // Scan Top-Down to find Maximal Trees
  for (let id = visibleArenaTop; id >= 0; id--) {
    // HARD BREAK: If we've blown the edge budget, stop everything.
    if (edges.length >= EDGE_LIMIT) break;

    // Deduplication: If this node was already rendered as a child, skip it.
    if (globalVisited.has(id)) continue;

    const rootKind = getKind(id, views);
    if (rootKind === ArenaKind.None) continue;

    // Initialize traversal for this new tree root
    const stack: TraversalState[] = [{
      id: id,
      pos: [0, 0, 0], // Correct: Vec3 Array
      rot: [0, 0, 0, 1], // Correct: Quat Array [x, y, z, w]
      depth: 0,
    }];

    globalVisited.add(id);

    while (stack.length > 0) {
      // Check limit before processing the next node
      if (edges.length >= EDGE_LIMIT) break;

      const current = stack.pop();
      if (!current) break;

      if (current.depth > config.geodesicSteps) continue;

      const kind = getKind(current.id, views);

      if (kind === ArenaKind.NonTerm) {
        const leftId = getLeft(current.id, views);
        const rightId = getRight(current.id, views);

        // Mark children as visited globally so they don't spawn new roots later
        if (leftId >= 0) globalVisited.add(leftId);
        if (rightId >= 0) globalVisited.add(rightId);

        // Calculate Geometry for Children
        const leftTx = applyHyperbolicStep(
          current.pos,
          current.rot,
          -config.branchAngleDeg,
          config.hStepSize,
        );

        const rightTx = applyHyperbolicStep(
          current.pos,
          current.rot,
          config.branchAngleDeg,
          config.hStepSize,
        );

        // Add Edges
        // Check limit again strictly before push
        if (edges.length + 2 <= EDGE_LIMIT) {
          edges.push({ from: current.pos, to: leftTx.pos });
          edges.push({ from: current.pos, to: rightTx.pos });
        } else {
          // If adding 2 exceeds limit, add one or break?
          // Safest is to just break to avoid partial trees.
          break;
        }

        // Push children to stack
        if (rightId >= 0) {
          stack.push({
            id: rightId,
            pos: rightTx.pos,
            rot: rightTx.rot,
            depth: current.depth + 1,
          });
        }

        if (leftId >= 0) {
          stack.push({
            id: leftId,
            pos: leftTx.pos,
            rot: leftTx.rot,
            depth: current.depth + 1,
          });
        }
      }
    }
  }

  return edges;
}

export function applyHyperbolicStep(
  parentPos: Vec3,
  parentRot: Quat,
  angleDeg: number,
  hDist: number,
): { pos: Vec3; rot: Quat } {
  const turnRot = quatFromEulerDeg(0, 0, angleDeg);
  const newRot = quatMul(parentRot, turnRot);

  const r = hyperToEuclidDist(hDist);
  const localDisp: Vec3 = [r, 0, 0];
  const globalDisp = v3RotateByQuat(localDisp, newRot);

  const newPos = mobiusAdd(parentPos, globalDisp);

  return { pos: newPos, rot: newRot };
}
