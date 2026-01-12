/// <reference lib="dom" />

import { getOrBuildArenaViews } from "../lib/evaluator/arenaViews.ts";
import { ArenaKind, ArenaSym } from "../lib/shared/arena.ts";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // x,y,z,w

type ForestLayoutConfig = {
  hStepSize: number;
  branchAngleDeg: number;
  geodesicSteps: number;
  maxNodes: number;
};

type ViewerDeps = {
  canvas: HTMLCanvasElement;
  getEvaluator: () => {
    memory?: WebAssembly.Memory;
    $?: { debugGetArenaBaseAddr?: () => number };
  } | null;
  getRoots: () => number[];
  statusEl?: HTMLElement | null;
};

type GLProgramBundle = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  aPos: number;
  aCol: number;
  uMvp: WebGLUniformLocation;
  uUsePoints: WebGLUniformLocation;
};

function v3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function v3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function v3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function v3Len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function v3Norm(a: Vec3): Vec3 {
  const l = v3Len(a);
  return l > 0 ? v3Scale(a, 1 / l) : [0, 0, 0];
}

function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}
function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}
function quatMul(a: Quat, b: Quat): Quat {
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
function quatFromEulerDeg(xDeg: number, yDeg: number, zDeg: number): Quat {
  const xr = (xDeg * Math.PI) / 180;
  const yr = (yDeg * Math.PI) / 180;
  const zr = (zDeg * Math.PI) / 180;
  const qx = quatFromAxisAngle([1, 0, 0], xr);
  const qy = quatFromAxisAngle([0, 1, 0], yr);
  const qz = quatFromAxisAngle([0, 0, 1], zr);
  // XYZ order
  return quatMul(quatMul(qx, qy), qz);
}
function v3RotateByQuat(v: Vec3, q: Quat): Vec3 {
  const p: Quat = [v[0], v[1], v[2], 0];
  const qc = quatConj(q);
  const r = quatMul(quatMul(q, p), qc);
  return [r[0], r[1], r[2]];
}

// ----------------------------
// Hyperbolic kernel (Poincaré ball)
// ----------------------------

function mobiusAdd(u: Vec3, v: Vec3): Vec3 {
  const u2 = v3Dot(u, u);
  const v2 = v3Dot(v, v);
  const uv = v3Dot(u, v);

  const denom = 1 + 2 * uv + u2 * v2;
  // Avoid NaNs at extreme values; clamp denom away from 0.
  const d = Math.abs(denom) < 1e-12 ? (denom < 0 ? -1e-12 : 1e-12) : denom;

  const term1 = v3Scale(u, 1 + 2 * uv + v2);
  const term2 = v3Scale(v, 1 - u2);
  return v3Scale(v3Add(term1, term2), 1 / d);
}

function hyperToEuclidDist(hDist: number): number {
  return Math.tanh(hDist * 0.5);
}

function atanhSafe(x: number): number {
  // Clamp to avoid Infinity when x approaches 1.
  const c = Math.max(-0.999999, Math.min(0.999999, x));
  return 0.5 * Math.log((1 + c) / (1 - c));
}

function getGeodesicPoint(A: Vec3, B: Vec3, t: number): Vec3 {
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

// ----------------------------
// WebGL helpers
// ----------------------------

function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || "unknown shader compile error";
    gl.deleteShader(sh);
    throw new Error(info);
  }
  return sh;
}

function createProgram(gl: WebGLRenderingContext): GLProgramBundle {
  const vs = createShader(
    gl,
    gl.VERTEX_SHADER,
    `
precision highp float;
attribute vec3 a_pos;
attribute vec3 a_col;
uniform mat4 u_mvp;
uniform mediump float u_use_points;
varying vec3 v_col;
varying float v_depth;
void main() {
  v_col = a_col;
  gl_Position = u_mvp * vec4(a_pos, 1.0);

  // Z-fighting fix: when drawing points, bias them slightly towards the camera
  // so they consistently win against coincident line fragments in the depth buffer.
  // The scale by w keeps the bias roughly consistent across depth.
  if (u_use_points > 0.5) {
    gl_Position.z -= 0.00025 * gl_Position.w;
  }

  // Perspective sizing
  gl_PointSize = 300.0 / gl_Position.w;
  gl_PointSize = clamp(gl_PointSize, 2.0, 64.0);

  // For fogging (approx)
  v_depth = gl_Position.w / 5.0;
}
`.trim(),
  );

  const fs = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
precision mediump float;
varying vec3 v_col;
varying float v_depth;
uniform mediump float u_use_points; // 1.0 for points, 0.0 for lines
void main() {
  // Depth fog (fade to darkness)
  float fog = 1.0 - smoothstep(0.0, 1.5, v_depth);
  vec3 color = v_col * fog;

  if (u_use_points > 0.5) {
    // Solid discs (no glow)
    vec2 coord = gl_PointCoord - vec2(0.5);
    float r = length(coord);
    if (r > 0.5) discard;
    // Subtle dark rim for contrast against lines
    float rim = smoothstep(0.45, 0.5, r);
    vec3 finalColor = mix(color, vec3(0.0), rim);
    gl_FragColor = vec4(finalColor, 1.0);
  } else {
    // Lines: solid (fog only affects brightness)
    gl_FragColor = vec4(color, 1.0);
  }
}
`.trim(),
  );

  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || "unknown program link error";
    gl.deleteProgram(prog);
    throw new Error(info);
  }

  const aPos = gl.getAttribLocation(prog, "a_pos");
  const aCol = gl.getAttribLocation(prog, "a_col");
  const uMvp = gl.getUniformLocation(prog, "u_mvp");
  if (!uMvp) throw new Error("missing uniform u_mvp");
  const uUsePoints = gl.getUniformLocation(prog, "u_use_points");
  if (!uUsePoints) throw new Error("missing uniform u_use_points");
  return { gl, program: prog, aPos, aCol, uMvp, uUsePoints };
}

function mat4Perspective(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1.0 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    (2 * far * near) * nf,
    0,
  ]);
}

function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  // Column-major (WebGL convention): index = col*4 + row.
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function mat4Translate(z: number): Float32Array {
  return new Float32Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    z,
    1,
  ]);
}

function buildSphereWireframe(segments: number): { posCol: Float32Array } {
  // Simple lat/long wireframe
  const lines: number[] = [];
  const col = [0.35, 0.45, 0.6];
  const addLine = (a: Vec3, b: Vec3) => {
    lines.push(a[0], a[1], a[2], col[0], col[1], col[2]);
    lines.push(b[0], b[1], b[2], col[0], col[1], col[2]);
  };

  const rings = segments;
  const meridians = segments;
  for (let i = 1; i < rings; i++) {
    const v = i / rings;
    const phi = (v * Math.PI) - Math.PI / 2; // -pi/2..pi/2
    const r = Math.cos(phi);
    const y = Math.sin(phi);
    for (let j = 0; j < meridians; j++) {
      const a0 = (j / meridians) * Math.PI * 2;
      const a1 = ((j + 1) / meridians) * Math.PI * 2;
      addLine([Math.cos(a0) * r, y, Math.sin(a0) * r], [
        Math.cos(a1) * r,
        y,
        Math.sin(a1) * r,
      ]);
    }
  }
  for (let j = 0; j < meridians; j++) {
    const a = (j / meridians) * Math.PI * 2;
    for (let i = 0; i < rings; i++) {
      const v0 = i / rings;
      const v1 = (i + 1) / rings;
      const phi0 = (v0 * Math.PI) - Math.PI / 2;
      const phi1 = (v1 * Math.PI) - Math.PI / 2;
      const r0 = Math.cos(phi0), y0 = Math.sin(phi0);
      const r1 = Math.cos(phi1), y1 = Math.sin(phi1);
      addLine([Math.cos(a) * r0, y0, Math.sin(a) * r0], [
        Math.cos(a) * r1,
        y1,
        Math.sin(a) * r1,
      ]);
    }
  }
  return { posCol: new Float32Array(lines) };
}

// ----------------------------
// Layout: build nodes + geodesic polyline edges
// ----------------------------

type LayoutNode = { id: number; pos: Vec3; type: "S" | "K" | "I" | "@" };
type LayoutEdge = { from: Vec3; to: Vec3 };

function arenaTop(memory: WebAssembly.Memory, baseAddr: number): number {
  const headerView = new Uint32Array(memory.buffer, baseAddr, 32);
  return headerView[16] >>> 0;
}

function symToType(sym: number): "S" | "K" | "I" | "@" {
  switch (sym as ArenaSym) {
    case ArenaSym.S:
      return "S";
    case ArenaSym.K:
      return "K";
    case ArenaSym.I:
      return "I";
    default:
      return "@";
  }
}

function typeColor(t: "S" | "K" | "I" | "@"): Vec3 {
  switch (t) {
    case "S":
      return [1.0, 0.0, 0.4]; // magenta
    case "K":
      return [0.0, 1.0, 0.8]; // cyan
    case "I":
      return [1.0, 0.8, 0.0]; // amber
    default:
      return [0.6, 0.6, 0.7]; // muted
  }
}

function buildLayoutFromRoots(
  memory: WebAssembly.Memory,
  exports: { debugGetArenaBaseAddr?: () => number },
  roots: number[],
  cfg: ForestLayoutConfig,
): {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  stats: { roots: number; visited: number; edges: number; top: number };
} {
  const baseAddr = exports.debugGetArenaBaseAddr?.() ?? 0;
  if (!baseAddr) {
    return {
      nodes: [],
      edges: [],
      stats: { roots: roots.length, visited: 0, edges: 0, top: 0 },
    };
  }
  const top = arenaTop(memory, baseAddr);
  const views = getOrBuildArenaViews(memory, exports);
  if (!views) {
    return {
      nodes: [],
      edges: [],
      stats: { roots: roots.length, visited: 0, edges: 0, top },
    };
  }

  const distE = hyperToEuclidDist(cfg.hStepSize);
  const branch = cfg.branchAngleDeg;

  const positioned = new Map<number, { pos: Vec3; rot: Quat }>();
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  const enqueueRootFrames = (): Array<{ id: number; pos: Vec3; rot: Quat }> => {
    const frames: Array<{ id: number; pos: Vec3; rot: Quat }> = [];
    const distinctRoots = Array.from(new Set(roots))
      .filter((r) => r >= 0 && r < top);
    const n = Math.max(1, distinctRoots.length);
    for (let i = 0; i < distinctRoots.length; i++) {
      const id = distinctRoots[i]!;
      // Spread roots around in yaw so multiple trees don't overlap immediately.
      const yaw = (i * 360) / n;
      frames.push({ id, pos: [0, 0, 0], rot: quatFromEulerDeg(0, yaw, 0) });
    }
    return frames;
  };

  const stack: Array<{ id: number; frame: { pos: Vec3; rot: Quat } }> = [];
  for (const rf of enqueueRootFrames()) {
    stack.push({ id: rf.id, frame: { pos: rf.pos, rot: rf.rot } });
  }

  const getKind = (id: number): number => {
    return id < views.capacity ? views.kind[id] : 0;
  };
  const getSym = (id: number): number => {
    return id < views.capacity ? views.sym[id] : 0;
  };
  const getLeft = (id: number): number => {
    return id < views.capacity ? views.leftId[id] : 0;
  };
  const getRight = (id: number): number => {
    return id < views.capacity ? views.rightId[id] : 0;
  };

  while (stack.length > 0 && nodes.length < cfg.maxNodes) {
    const cur = stack.pop()!;
    const id = cur.id >>> 0;
    if (id >= top) continue;

    const k = getKind(id);
    if (k !== ArenaKind.Terminal && k !== ArenaKind.NonTerm) continue;

    let existing = positioned.get(id);
    if (!existing) {
      existing = { pos: cur.frame.pos, rot: cur.frame.rot };
      positioned.set(id, existing);
      const type = k === ArenaKind.Terminal ? symToType(getSym(id)) : "@";
      nodes.push({ id, pos: existing.pos, type });
    }

    if (k === ArenaKind.Terminal) continue;

    const leftId = getLeft(id) >>> 0;
    const rightId = getRight(id) >>> 0;

    // LEFT child frame
    const qLeft = quatMul(existing.rot, quatFromEulerDeg(-branch, -branch, 0));
    const stepL = v3RotateByQuat([0, 0, -distE], qLeft);
    const posL = mobiusAdd(existing.pos, stepL);
    edges.push({ from: existing.pos, to: posL });
    if (!positioned.has(leftId)) {
      stack.push({ id: leftId, frame: { pos: posL, rot: qLeft } });
    }

    // RIGHT child frame
    const qRight = quatMul(existing.rot, quatFromEulerDeg(branch, -branch, 0));
    const stepR = v3RotateByQuat([0, 0, -distE], qRight);
    const posR = mobiusAdd(existing.pos, stepR);
    edges.push({ from: existing.pos, to: posR });
    if (!positioned.has(rightId)) {
      stack.push({ id: rightId, frame: { pos: posR, rot: qRight } });
    }
  }

  return {
    nodes,
    edges,
    stats: {
      roots: roots.length,
      visited: nodes.length,
      edges: edges.length,
      top,
    },
  };
}

function buildGpuBuffers(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  geodesicSteps: number,
): {
  points: Float32Array;
  lines: Float32Array;
} {
  // points: interleaved pos+col (x,y,z,r,g,b)
  const pts = new Float32Array(nodes.length * 6);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const c = typeColor(n.type);
    const o = i * 6;
    pts[o + 0] = n.pos[0];
    pts[o + 1] = n.pos[1];
    pts[o + 2] = n.pos[2];
    pts[o + 3] = c[0];
    pts[o + 4] = c[1];
    pts[o + 5] = c[2];
  }

  const steps = Math.max(2, geodesicSteps | 0);
  const lineVerts: number[] = [];
  const col = [0.85, 0.85, 0.9];
  for (const e of edges) {
    let prev = getGeodesicPoint(e.from, e.to, 0);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cur = getGeodesicPoint(e.from, e.to, t);
      lineVerts.push(prev[0], prev[1], prev[2], col[0], col[1], col[2]);
      lineVerts.push(cur[0], cur[1], cur[2], col[0], col[1], col[2]);
      prev = cur;
    }
  }
  return { points: pts, lines: new Float32Array(lineVerts) };
}

function applyWorldMobiusTranslation(buf: Float32Array, v: Vec3) {
  // buf is interleaved [x,y,z,r,g,b] for points or lines.
  const negV: Vec3 = [-v[0], -v[1], -v[2]];
  for (let i = 0; i < buf.length; i += 6) {
    const p: Vec3 = [buf[i + 0]!, buf[i + 1]!, buf[i + 2]!];
    const p2 = mobiusAdd(p, negV);
    buf[i + 0] = p2[0];
    buf[i + 1] = p2[1];
    buf[i + 2] = p2[2];
  }
}

function applyWorldRotation(buf: Float32Array, qInv: Quat) {
  for (let i = 0; i < buf.length; i += 6) {
    const p: Vec3 = [buf[i + 0]!, buf[i + 1]!, buf[i + 2]!];
    const p2 = v3RotateByQuat(p, qInv);
    buf[i + 0] = p2[0];
    buf[i + 1] = p2[1];
    buf[i + 2] = p2[2];
  }
}

export function initWebglForestViewer(deps: ViewerDeps) {
  const cfg: ForestLayoutConfig = {
    hStepSize: 1.5,
    branchAngleDeg: 45,
    geodesicSteps: 16,
    maxNodes: 20000,
  };

  const gl = deps.canvas.getContext("webgl", {
    antialias: true,
    alpha: false,
    depth: true,
  }) as WebGLRenderingContext | null;
  if (!gl) {
    deps.statusEl && (deps.statusEl.textContent = "WebGL unavailable");
    return {
      setConfig: (_: Partial<ForestLayoutConfig>) => {},
      requestRebuild: () => {},
      setActive: (_: boolean) => {},
      clearWorldTransform: () => {},
    };
  }

  const prog = createProgram(gl);
  gl.useProgram(prog.program);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearDepth(1.0);
  // Opaque render (no glow); blending off avoids driver-dependent artifacts.
  gl.disable(gl.BLEND);

  // Buffers
  const pointBuf = gl.createBuffer();
  const lineBuf = gl.createBuffer();
  const sphereBuf = gl.createBuffer();
  if (!pointBuf || !lineBuf || !sphereBuf) {
    throw new Error("WebGL buffer allocation failed");
  }

  const sphere = buildSphereWireframe(18);
  gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
  gl.bufferData(gl.ARRAY_BUFFER, sphere.posCol, gl.STATIC_DRAW);

  let points: Float32Array<ArrayBufferLike> = new Float32Array(0);
  let lines: Float32Array<ArrayBufferLike> = new Float32Array(0);
  let active = false;
  let raf = 0;

  // Camera orientation (for computing movement direction); the world itself is transformed.
  let camRot: Quat = quatIdentity();
  // Camera distance for projection (zoom). World coordinates stay in the unit ball;
  // we just move the view matrix back/forward to frame the scene.
  let camDist = 3.0;

  const resize = () => {
    // `devicePixelRatio` can be fractional (e.g. 1.25/1.5). Canvas width/height are
    // integers. If we compare against fractional computed sizes, we can end up resizing
    // every frame (blink). So: keep fractional dpr, but quantize final w/h to ints.
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const cw = deps.canvas.clientWidth;
    const ch = deps.canvas.clientHeight;
    // Avoid poisoning the canvas to 0x0 while the tab is hidden.
    if (cw <= 0 || ch <= 0) return;
    const w = Math.floor(cw * dpr);
    const h = Math.floor(ch * dpr);
    if (deps.canvas.width !== w || deps.canvas.height !== h) {
      deps.canvas.width = w;
      deps.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  const setStatus = (s: string) => {
    if (deps.statusEl) deps.statusEl.textContent = s;
  };

  const uploadBuffers = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
  };

  const rebuild = () => {
    const ev = deps.getEvaluator();
    if (!ev?.memory || !ev?.$) {
      // Keep showing the last valid frame during startup; don't clear buffers.
      setStatus("Waiting for WASM...");
      return;
    }
    const roots = deps.getRoots();
    const { nodes, edges, stats } = buildLayoutFromRoots(
      ev.memory,
      ev.$,
      roots,
      cfg,
    );
    const gpu = buildGpuBuffers(nodes, edges, cfg.geodesicSteps);
    points = gpu.points;
    lines = gpu.lines;
    uploadBuffers();
    console.log(
      `[WebGL] Rebuild complete. nodes=${nodes.length} edges=${edges.length} pointsFloats=${gpu.points.length} linesFloats=${gpu.lines.length}`,
    );
    setStatus(
      `roots=${stats.roots} visited=${stats.visited} edges=${stats.edges} arenaTop=${stats.top}`,
    );
  };

  const clearWorldTransform = () => {
    // Best-effort: rebuild from scratch (layout is canonical) rather than trying to invert accumulated transforms.
    rebuild();
  };

  const drawInterleaved = (buf: WebGLBuffer) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(prog.aPos);
    gl.enableVertexAttribArray(prog.aCol);
    gl.vertexAttribPointer(prog.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(prog.aCol, 3, gl.FLOAT, false, 24, 12);
  };

  const tick = (_now: number) => {
    if (!active) return;
    resize();

    const aspect = Math.max(1e-6, deps.canvas.width / deps.canvas.height);
    const proj = mat4Perspective((60 * Math.PI) / 180, aspect, 0.01, 50);
    const view = mat4Translate(-camDist);
    const mvp = mat4Mul(proj, view);
    gl.useProgram(prog.program);
    // IMPORTANT: uniforms apply to the *currently bound* program.
    // Setting uniforms before `useProgram()` can silently fail (INVALID_OPERATION),
    // leaving stale matrices and causing apparent "blinks".
    gl.uniformMatrix4fv(prog.uMvp, false, mvp);

    gl.clearColor(0.02, 0.02, 0.03, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sphere
    // Draw the boundary sphere *without* depth testing to avoid z-fighting with
    // edges/nodes near the boundary at certain orientations.
    gl.disable(gl.DEPTH_TEST);
    gl.uniform1f(prog.uUsePoints, 0.0);
    drawInterleaved(sphereBuf);
    gl.drawArrays(gl.LINES, 0, sphere.posCol.length / 6);

    // Lines
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1f(prog.uUsePoints, 0.0);
    drawInterleaved(lineBuf);
    gl.drawArrays(gl.LINES, 0, lines.length / 6);

    // Points
    // Points last with depth testing enabled. We apply a small clip-space depth bias
    // in the vertex shader (when u_use_points=1) to avoid z-fighting flicker.
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1f(prog.uUsePoints, 1.0);
    drawInterleaved(pointBuf);
    gl.drawArrays(gl.POINTS, 0, points.length / 6);

    raf = requestAnimationFrame(tick);
  };

  const move = (dir: Vec3, hStep: number) => {
    const distE = hyperToEuclidDist(hStep);
    const stepLocal = v3Scale(v3Norm(dir), distE);
    const stepWorld = v3RotateByQuat(stepLocal, camRot);
    // Hyperbolic fly: apply inverse translation to whole world.
    applyWorldMobiusTranslation(points, stepWorld);
    applyWorldMobiusTranslation(lines, stepWorld);
    uploadBuffers();
  };

  const turn = (dxDeg: number, dyDeg: number) => {
    // Update camera orientation (for movement direction), but rotate the world oppositely so view changes.
    const qDelta = quatFromEulerDeg(dxDeg, dyDeg, 0);
    camRot = quatMul(camRot, qDelta);
    const qInv = quatConj(qDelta);
    applyWorldRotation(points, qInv);
    applyWorldRotation(lines, qInv);
    uploadBuffers();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    const fast = e.shiftKey ? 0.35 : 0.12;
    const zoomStep = e.shiftKey ? 0.2 : 0.05;
    switch (e.key) {
      case "w":
      case "W":
        move([0, 0, -1], fast);
        e.preventDefault();
        break;
      case "s":
      case "S":
        move([0, 0, 1], fast);
        e.preventDefault();
        break;
      case "a":
      case "A":
        move([-1, 0, 0], fast);
        e.preventDefault();
        break;
      case "d":
      case "D":
        move([1, 0, 0], fast);
        e.preventDefault();
        break;
      case "q":
      case "Q":
        move([0, -1, 0], fast);
        e.preventDefault();
        break;
      case "e":
      case "E":
        move([0, 1, 0], fast);
        e.preventDefault();
        break;
      case "ArrowLeft":
        turn(0, 3);
        e.preventDefault();
        break;
      case "ArrowRight":
        turn(0, -3);
        e.preventDefault();
        break;
      case "ArrowUp":
        turn(3, 0);
        e.preventDefault();
        break;
      case "ArrowDown":
        turn(-3, 0);
        e.preventDefault();
        break;
      case "z":
      case "Z":
        camDist = Math.max(1.1, camDist - zoomStep);
        e.preventDefault();
        break;
      case "x":
      case "X":
        camDist = Math.min(10.0, camDist + zoomStep);
        e.preventDefault();
        break;
    }
  };

  globalThis.addEventListener("keydown", onKeyDown, { passive: false });

  const setActive = (on: boolean) => {
    active = on;
    if (active) {
      if (!raf) raf = requestAnimationFrame(tick);
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  // Initial state
  resize();
  rebuild();

  return {
    setConfig: (partial: Partial<ForestLayoutConfig>) => {
      if (partial.hStepSize !== undefined) cfg.hStepSize = partial.hStepSize;
      if (partial.branchAngleDeg !== undefined) {
        cfg.branchAngleDeg = partial.branchAngleDeg;
      }
      if (partial.geodesicSteps !== undefined) {
        cfg.geodesicSteps = partial.geodesicSteps;
      }
      if (partial.maxNodes !== undefined) cfg.maxNodes = partial.maxNodes;
    },
    requestRebuild: rebuild,
    setActive,
    clearWorldTransform,
    destroy: () => {
      setActive(false);
      globalThis.removeEventListener("keydown", onKeyDown as EventListener);
      gl.deleteProgram(prog.program);
      gl.deleteBuffer(pointBuf);
      gl.deleteBuffer(lineBuf);
      gl.deleteBuffer(sphereBuf);
    },
  };
}
