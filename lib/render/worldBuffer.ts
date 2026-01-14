import type { LayoutEdge } from "./layout.ts";
import {
  getGeodesicPoint,
  mobiusAdd,
  type Quat,
  v3Dot,
  v3RotateByQuat,
  type Vec3,
} from "./matrix.ts";

export type WorldBuffer = {
  // [x,y,z] per vertex
  lines: Float32Array;
};

export function buildWorldBuffers(
  edges: LayoutEdge[],
  geodesicSteps: number,
): WorldBuffer {
  const steps = Math.max(2, geodesicSteps | 0);
  const lineVerts: number[] = [];

  for (const e of edges) {
    let prev = getGeodesicPoint(e.from, e.to, 0);

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cur = getGeodesicPoint(e.from, e.to, t);

      // Push segment vertices
      lineVerts.push(prev[0], prev[1], prev[2]);
      lineVerts.push(cur[0], cur[1], cur[2]);

      prev = cur;
    }
  }
  return { lines: new Float32Array(lineVerts) };
}

export function applyWorldMobiusTranslation(buf: Float32Array, v: Vec3) {
  const negV: Vec3 = [-v[0], -v[1], -v[2]];
  // Stride is 3 (x,y,z)
  for (let i = 0; i < buf.length; i += 3) {
    const p: Vec3 = [buf[i], buf[i + 1], buf[i + 2]];
    if (v3Dot(p, p) >= 1.0) continue;
    const p2 = mobiusAdd(p, negV);
    buf[i] = p2[0];
    buf[i + 1] = p2[1];
    buf[i + 2] = p2[2];
  }
}

export function applyWorldRotation(buf: Float32Array, qInv: Quat) {
  for (let i = 0; i < buf.length; i += 3) {
    const p: Vec3 = [buf[i], buf[i + 1], buf[i + 2]];
    const p2 = v3RotateByQuat(p, qInv);
    buf[i] = p2[0];
    buf[i + 1] = p2[1];
    buf[i + 2] = p2[2];
  }
}
