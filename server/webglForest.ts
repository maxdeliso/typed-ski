/// <reference lib="dom" />

import { getOrBuildArenaViews } from "../lib/evaluator/arenaViews.ts";
import { ArenaKind } from "../lib/shared/arena.ts";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // x,y,z,w

type ForestLayoutConfig = {
  hStepSize: number;
  branchAngleDeg: number;
  geodesicSteps: number;
  maxNodes: number;
  rootSpacing: number;
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
  uMvp: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
};

// --- Math Helpers utilized with higher precision inputs ---

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
  return quatMul(quatMul(qx, qy), qz);
}

function v3RotateByQuat(v: Vec3, q: Quat): Vec3 {
  const p: Quat = [v[0], v[1], v[2], 0];
  const qc = quatConj(q);
  const r = quatMul(quatMul(q, p), qc);
  return [r[0], r[1], r[2]];
}

// --- Hyperbolic Kernel ---

function mobiusAdd(u: Vec3, v: Vec3): Vec3 {
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

function hyperToEuclidDist(hDist: number): number {
  return Math.tanh(hDist * 0.5);
}

function atanhSafe(x: number): number {
  const c = Math.max(-0.99999999, Math.min(0.99999999, x));
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

// --- WebGL Shader Setup ---

function createProgram(gl: WebGLRenderingContext): GLProgramBundle {
  // VERTEX SHADER
  const vs = `
    precision highp float;
    attribute vec3 a_pos;
    uniform mat4 u_mvp;

    void main() {
      vec4 pos = u_mvp * vec4(a_pos, 1.0);

      if (pos.w < 0.2) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // Outside NDC
        return;
      }

      gl_Position = pos;
    }
  `;

  const fs = `
    precision mediump float;
    uniform vec3 u_color;
    void main() {
      gl_FragColor = vec4(u_color, 1.0);
    }
  `;

  const vShader = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vShader, vs);
  gl.compileShader(vShader);
  if (!gl.getShaderParameter(vShader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(vShader) || "");
  }

  const fShader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fShader, fs);
  gl.compileShader(fShader);
  if (!gl.getShaderParameter(fShader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(fShader) || "");
  }

  const prog = gl.createProgram()!;
  gl.attachShader(prog, vShader);
  gl.attachShader(prog, fShader);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "");
  }

  return {
    gl,
    program: prog,
    aPos: gl.getAttribLocation(prog, "a_pos"),
    uMvp: gl.getUniformLocation(prog, "u_mvp")!,
    uColor: gl.getUniformLocation(prog, "u_color")!,
  };
}

function mat4Perspective(
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

function mat4Translate(out: Float32Array, z: number) {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  out[14] = z;
  return out;
}

function mat4Mul(out: Float32Array, a: Float32Array, b: Float32Array) {
  // Simple unrolled mat mul
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

// --- Layout Engine (Canonical Gallery) ---

type LayoutEdge = { from: Vec3; to: Vec3 };

function arenaTop(memory: WebAssembly.Memory, baseAddr: number): number {
  return new Uint32Array(memory.buffer, baseAddr, 32)[16] >>> 0;
}

function buildLayoutFromRoots(
  memory: WebAssembly.Memory,
  exports: { debugGetArenaBaseAddr?: () => number },
  roots: number[],
  cfg: ForestLayoutConfig,
) {
  const baseAddr = exports.debugGetArenaBaseAddr?.() ?? 0;
  if (!baseAddr) {
    return { edges: [], stats: { roots: 0, visited: 0, edges: 0, top: 0 } };
  }
  const top = arenaTop(memory, baseAddr);
  const views = getOrBuildArenaViews(memory, exports);
  if (!views) {
    return { edges: [], stats: { roots: 0, visited: 0, edges: 0, top } };
  }

  const distE = hyperToEuclidDist(cfg.hStepSize);
  const branch = cfg.branchAngleDeg;

  const positioned = new Map<number, { pos: Vec3; rot: Quat }>();
  const edges: LayoutEdge[] = [];
  let visited = 0;

  // Roots are placed side-by-side along X, facing the same direction.
  const enqueueRootFrames = (): Array<{ id: number; pos: Vec3; rot: Quat }> => {
    const frames: Array<{ id: number; pos: Vec3; rot: Quat }> = [];
    const distinctRoots = Array.from(new Set(roots)).filter((r) =>
      r >= 0 && r < top
    );
    const n = distinctRoots.length;
    if (n === 0) return [];

    // Calculate gallery width
    const spacing = cfg.rootSpacing;
    const totalW = (n - 1) * spacing;
    const startX = -totalW / 2;

    for (let i = 0; i < n; i++) {
      const id = distinctRoots[i]!;
      // Linear layout along X. Clamp to keep inside ball.
      let x = startX + i * spacing;
      x = Math.max(-0.95, Math.min(0.95, x));

      // All roots face Identity (forward)
      frames.push({ id, pos: [x, 0, 0], rot: [0, 0, 0, 1] });
    }
    return frames;
  };

  const stack: Array<{ id: number; frame: { pos: Vec3; rot: Quat } }> = [];
  for (const rf of enqueueRootFrames()) {
    stack.push({ id: rf.id, frame: { pos: rf.pos, rot: rf.rot } });
  }

  const getKind = (id: number) => (id < views.capacity ? views.kind[id] : 0);
  const getLeft = (id: number) => (id < views.capacity ? views.leftId[id] : 0);
  const getRight = (
    id: number,
  ) => (id < views.capacity ? views.rightId[id] : 0);

  while (stack.length > 0 && visited < cfg.maxNodes) {
    const cur = stack.pop()!;
    const id = cur.id >>> 0;
    if (id >= top) continue;
    if (positioned.has(id)) continue;

    const k = getKind(id);
    if (k !== ArenaKind.Terminal && k !== ArenaKind.NonTerm) continue;

    const currentFrame = { pos: cur.frame.pos, rot: cur.frame.rot };
    positioned.set(id, currentFrame);
    visited++;

    if (k === ArenaKind.Terminal) continue;

    const leftId = getLeft(id) >>> 0;
    const rightId = getRight(id) >>> 0;

    // Left
    const qLeft = quatMul(
      currentFrame.rot,
      quatFromEulerDeg(-branch, -branch, 0),
    );
    const stepL = v3RotateByQuat([0, 0, -distE], qLeft);
    const posL = mobiusAdd(currentFrame.pos, stepL);

    const existL = positioned.get(leftId);
    if (existL) {
      edges.push({ from: currentFrame.pos, to: existL.pos });
    } else {
      edges.push({ from: currentFrame.pos, to: posL });
      stack.push({ id: leftId, frame: { pos: posL, rot: qLeft } });
    }

    // Right
    const qRight = quatMul(
      currentFrame.rot,
      quatFromEulerDeg(branch, -branch, 0),
    );
    const stepR = v3RotateByQuat([0, 0, -distE], qRight);
    const posR = mobiusAdd(currentFrame.pos, stepR);

    const existR = positioned.get(rightId);
    if (existR) {
      edges.push({ from: currentFrame.pos, to: existR.pos });
    } else {
      edges.push({ from: currentFrame.pos, to: posR });
      stack.push({ id: rightId, frame: { pos: posR, rot: qRight } });
    }
  }

  return {
    edges,
    stats: { roots: roots.length, visited, edges: edges.length, top },
  };
}

// --- World Buffer Storage ---

type WorldBuffer = {
  // [x,y,z] per vertex
  lines: Float32Array;
};

function buildWorldBuffers(
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

function applyWorldMobiusTranslation(buf: Float32Array, v: Vec3) {
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

function applyWorldRotation(buf: Float32Array, qInv: Quat) {
  for (let i = 0; i < buf.length; i += 3) {
    const p: Vec3 = [buf[i], buf[i + 1], buf[i + 2]];
    const p2 = v3RotateByQuat(p, qInv);
    buf[i] = p2[0];
    buf[i + 1] = p2[1];
    buf[i + 2] = p2[2];
  }
}

// --- Main Viewer ---

export function initWebglForestViewer(deps: ViewerDeps) {
  const cfg: ForestLayoutConfig = {
    hStepSize: 1.5,
    branchAngleDeg: 45,
    geodesicSteps: 16,
    maxNodes: 20000,
    rootSpacing: 0.4, // Good starting value for gallery spacing
  };

  const gl = deps.canvas.getContext("webgl", {
    antialias: true,
    alpha: false,
    depth: true,
  }) as WebGLRenderingContext | null;

  if (!gl) {
    if (deps.statusEl) deps.statusEl.textContent = "WebGL unavailable";
    return {
      setConfig: () => {},
      requestRebuild: () => {},
      setActive: () => {},
      clearWorldTransform: () => {},
      destroy: () => {},
    };
  }

  const progBundle = createProgram(gl);
  gl.useProgram(progBundle.program);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND);
  gl.enableVertexAttribArray(progBundle.aPos);

  const lineBuf = gl.createBuffer();
  // We use simple line sphere for boundary
  const sphereGeom = (() => {
    const lines: number[] = [];
    const seg = 24;
    for (let i = 0; i < seg; i++) {
      const t1 = (i / seg) * Math.PI * 2, t2 = ((i + 1) / seg) * Math.PI * 2;
      lines.push(Math.cos(t1), Math.sin(t1), 0);
      lines.push(Math.cos(t2), Math.sin(t2), 0);
      lines.push(Math.cos(t1), 0, Math.sin(t1));
      lines.push(Math.cos(t2), 0, Math.sin(t2));
      lines.push(0, Math.cos(t1), Math.sin(t1));
      lines.push(0, Math.cos(t2), Math.sin(t2));
    }
    return new Float32Array(lines);
  })();
  const sphereBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
  gl.bufferData(gl.ARRAY_BUFFER, sphereGeom, gl.STATIC_DRAW);

  // CPU-side world state (Float32, matches GPU format)
  let world: WorldBuffer = { lines: new Float32Array(0) };

  let active = false;
  let raf = 0;
  let camRot: Quat = [0, 0, 0, 1];
  let camDist = 3.0;

  const mProj = new Float32Array(16);
  const mView = new Float32Array(16);
  const mMvp = new Float32Array(16);

  const resize = () => {
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const w = Math.floor(deps.canvas.clientWidth * dpr);
    const h = Math.floor(deps.canvas.clientHeight * dpr);
    if (deps.canvas.width !== w || deps.canvas.height !== h) {
      deps.canvas.width = w;
      deps.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  const syncBuffers = () => {
    // Upload directly to GPU (no conversion needed)
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.lines, gl.DYNAMIC_DRAW);
  };

  const rebuild = () => {
    const ev = deps.getEvaluator();
    if (!ev?.memory || !ev?.$) return;
    const roots = deps.getRoots();
    const { edges, stats } = buildLayoutFromRoots(ev.memory, ev.$, roots, cfg);

    // Create fresh world buffer
    world = buildWorldBuffers(edges, cfg.geodesicSteps);
    syncBuffers();

    if (deps.statusEl) {
      deps.statusEl.textContent =
        `Roots: ${stats.roots} | Edges: ${stats.edges}`;
    }
  };

  const drawInterleaved = (buf: WebGLBuffer) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(progBundle.aPos, 3, gl.FLOAT, false, 12, 0);
  };

  const tick = () => {
    if (!active) return;
    resize();
    const aspect = deps.canvas.width / deps.canvas.height;

    mat4Perspective(mProj, (60 * Math.PI) / 180, aspect, 0.1, 50.0);
    mat4Translate(mView, -camDist);
    mat4Mul(mMvp, mProj, mView);
    gl.useProgram(progBundle.program);
    gl.uniformMatrix4fv(progBundle.uMvp, false, mMvp);

    gl.clearColor(0.02, 0.02, 0.03, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1. Boundary
    gl.disable(gl.DEPTH_TEST);
    gl.uniform3f(progBundle.uColor, 0.3, 0.4, 0.5);
    drawInterleaved(sphereBuf);
    gl.drawArrays(gl.LINES, 0, sphereGeom.length / 3);

    // 2. Lines
    gl.enable(gl.DEPTH_TEST);
    gl.uniform3f(progBundle.uColor, 0.7, 0.7, 0.7);
    drawInterleaved(lineBuf);
    gl.drawArrays(gl.LINES, 0, world.lines.length / 3);

    raf = requestAnimationFrame(tick);
  };

  const move = (dir: Vec3, hStep: number) => {
    const distE = hyperToEuclidDist(hStep);
    const stepLocal = v3Scale(v3Norm(dir), distE);
    const stepWorld = v3RotateByQuat(stepLocal, camRot);

    // Mutate world buffer
    applyWorldMobiusTranslation(world.lines, stepWorld);
    syncBuffers();
  };

  const turn = (dx: number, dy: number) => {
    const qDelta = quatFromEulerDeg(dx, dy, 0);
    camRot = quatMul(camRot, qDelta);
    const qInv = quatConj(qDelta);
    applyWorldRotation(world.lines, qInv);
    syncBuffers();
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      deps.canvas.requestFullscreen().catch((err) => {
        console.error("Error attempting to enable fullscreen:", err);
      });
    } else {
      document.exitFullscreen().catch((err) => {
        console.error("Error attempting to exit fullscreen:", err);
      });
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (!active) return;
    const fast = e.shiftKey ? 0.35 : 0.1;
    const zoom = e.shiftKey ? 0.2 : 0.05;

    switch (e.key.toLowerCase()) {
      case "f":
        toggleFullscreen();
        break;
      case "w":
        move([0, 0, -1], fast);
        break;
      case "s":
        move([0, 0, 1], fast);
        break;
      case "a":
        move([-1, 0, 0], fast);
        break;
      case "d":
        move([1, 0, 0], fast);
        break;
      case "q":
        move([0, -1, 0], fast);
        break;
      case "e":
        move([0, 1, 0], fast);
        break;
      case "arrowleft":
        turn(0, 3);
        break;
      case "arrowright":
        turn(0, -3);
        break;
      case "arrowup":
        turn(3, 0);
        break;
      case "arrowdown":
        turn(-3, 0);
        break;
      case "z":
        camDist = Math.max(1.1, camDist - zoom);
        break;
      case "x":
        camDist = Math.min(10.0, camDist + zoom);
        break;
    }
  };

  globalThis.addEventListener("keydown", onKey);

  resize();
  rebuild();

  return {
    setConfig: (p: Partial<ForestLayoutConfig>) => {
      if (p.hStepSize) cfg.hStepSize = p.hStepSize;
      if (p.branchAngleDeg) cfg.branchAngleDeg = p.branchAngleDeg;
      if (p.rootSpacing) cfg.rootSpacing = p.rootSpacing;
    },
    requestRebuild: rebuild,
    setActive: (b: boolean) => {
      active = b;
      if (active && !raf) raf = requestAnimationFrame(tick);
      if (!active && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    clearWorldTransform: rebuild,
    destroy: () => {
      active = false;
      globalThis.removeEventListener("keydown", onKey);
      gl.deleteProgram(progBundle.program);
    },
  };
}
