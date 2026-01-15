import type { LayoutEdge } from "./layout.ts";
import {
  getGeodesicPoint,
  mobiusAdd,
  type Quat,
  v3Dot,
  v3RotateByQuat,
  type Vec3,
} from "./matrix.ts";

// hsl to rgb for smooth depth gradients
function depthToColor(depth: number, t: number): [number, number, number] {
  // interpolate effective depth (e.g. 0.0 -> 0.1 -> ... -> 1.0)
  const d = depth + t;

  // color palette strategy:
  // depth 0 (atoms) = warm/red/orange
  // depth 10+ (leaves) = cool/blue/cyan
  // we cycle hue roughly 0 (red) to 240 (blue) over ~15 levels
  const maxDepth = 15;
  const hue = Math.min(240, (d / maxDepth) * 240);

  // convert hsl(hue, 80%, 60%) to rgb: simplified conversion for brevity
  const s = 0.8, l = 0.6;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

  return [f(0), f(8), f(4)];
}

export type WorldBuffer = {
  lines: Float32Array;
  colors: Float32Array; // New Buffer
};

export function buildWorldBuffers(
  edges: LayoutEdge[],
  geodesicSteps: number,
): WorldBuffer {
  const steps = Math.max(2, geodesicSteps | 0);
  const lineVerts: number[] = [];
  const colorVerts: number[] = [];

  for (const e of edges) {
    let prev = getGeodesicPoint(e.from, e.to, 0);
    let prevColor = depthToColor(e.startDepth, 0);

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cur = getGeodesicPoint(e.from, e.to, t);
      const curColor = depthToColor(e.startDepth, t);

      // push segment position
      lineVerts.push(...prev, ...cur);

      // push segment color (gradient from prev -> cur)
      colorVerts.push(...prevColor, ...curColor);

      prev = cur;
      prevColor = curColor;
    }
  }
  return {
    lines: new Float32Array(lineVerts),
    colors: new Float32Array(colorVerts),
  };
}

export function applyWorldMobiusTranslation(buf: Float32Array, v: Vec3) {
  const negV: Vec3 = [-v[0], -v[1], -v[2]];
  // stride is 3 (x,y,z)
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
