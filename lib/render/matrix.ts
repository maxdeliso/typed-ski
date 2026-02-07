export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x,y,z,w

function v3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function v3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function v3Len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function v3Norm(a: Vec3): Vec3 {
  const l = v3Len(a);
  return l > 0 ? v3Scale(a, 1 / l) : [0, 0, 0];
}

export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const a = v3Norm(axis);
  const s = Math.sin(angleRad / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angleRad / 2)];
}

export function quatFromEulerDeg(
  xDeg: number,
  yDeg: number,
  zDeg: number,
): Quat {
  const xr = (xDeg * Math.PI) / 180;
  const yr = (yDeg * Math.PI) / 180;
  const zr = (zDeg * Math.PI) / 180;
  const qx = quatFromAxisAngle([1, 0, 0], xr);
  const qy = quatFromAxisAngle([0, 1, 0], yr);
  const qz = quatFromAxisAngle([0, 0, 1], zr);
  return quatMul(quatMul(qx, qy), qz);
}

export function v3RotateByQuat(v: Vec3, q: Quat): Vec3 {
  const p: Quat = [v[0], v[1], v[2], 0];
  const qc = quatConj(q);
  const r = quatMul(quatMul(q, p), qc);
  return [r[0], r[1], r[2]];
}

export function mobiusAdd(u: Vec3, v: Vec3): Vec3 {
  const u2 = v3Dot(u, u);
  const v2 = v3Dot(v, v);
  const uv = v3Dot(u, v);
  const denom = 1 + 2 * uv + u2 * v2;
  // Guard against division by zero or extreme instability
  const d = Math.abs(denom) < 1e-14 ? 1e-14 : denom;
  const term1 = v3Scale(u, 1 + 2 * uv + v2);
  const term2 = v3Scale(v, 1 - u2);
  return v3Scale(v3Add(term1, term2), 1 / d);
}

export function hyperToEuclidDist(hDist: number): number {
  return Math.tanh(hDist * 0.5);
}

function atanhSafe(x: number): number {
  const c = Math.max(-0.99999999, Math.min(0.99999999, x));
  return 0.5 * Math.log((1 + c) / (1 - c));
}

export function getGeodesicPoint(A: Vec3, B: Vec3, t: number): Vec3 {
  const negA: Vec3 = [-A[0], -A[1], -A[2]];
  const Bp = mobiusAdd(B, negA);
  const r = v3Len(Bp);
  if (r < 1e-9) return A;
  const distH = 2 * atanhSafe(r);
  const distT = distH * t;
  const rT = Math.tanh(distT / 2);
  const Pp = v3Scale(v3Norm(Bp), rT);
  return mobiusAdd(Pp, A);
}

// Simple unrolled mat mul
export function mat4Mul(out: Float32Array, a: Float32Array, b: Float32Array) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0, b1, b2, b3;

  for (let i = 0; i < 4; i++) {
    b0 = b[i * 4 + 0];
    b1 = b[i * 4 + 1];
    b2 = b[i * 4 + 2];
    b3 = b[i * 4 + 3];
    out[i * 4 + 0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function mat4Perspective(
  out: Float32Array,
  fovYRad: number,
  aspect: number,
  near: number,
  far: number,
) {
  const f = 1.0 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = (2 * far * near) * nf;
  return out;
}

export function mat4Translate(out: Float32Array, z: number) {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  out[14] = z;
  return out;
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
