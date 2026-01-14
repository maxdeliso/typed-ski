/// <reference lib="dom" />

import {
  hyperToEuclidDist,
  mat4Mul,
  mat4Perspective,
  mat4Translate,
  type Quat,
  quatConj,
  quatFromEulerDeg,
  quatMul,
  v3Norm,
  v3RotateByQuat,
  v3Scale,
  type Vec3,
} from "../lib/render/matrix.ts";

import { createProgram } from "../lib/render/shader.ts";

import {
  buildLayoutFromRoots,
  type ForestLayoutConfig,
} from "../lib/render/layout.ts";

import {
  applyWorldMobiusTranslation,
  applyWorldRotation,
  buildWorldBuffers,
  type WorldBuffer,
} from "../lib/render/worldBuffer.ts";

type ViewerDeps = {
  canvas: HTMLCanvasElement;
  getEvaluator: () => {
    memory?: WebAssembly.Memory;
    $?: { debugGetArenaBaseAddr?: () => number };
  } | null;
  statusEl?: HTMLElement | null;
};

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
    const seg = 64;

    for (let i = 0; i < seg; i++) {
      const t1 = (i / seg) * Math.PI * 2;
      const t2 = ((i + 1) / seg) * Math.PI * 2;

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
    const edges = buildLayoutFromRoots(ev.memory, ev.$, cfg);

    // Create fresh world buffer
    world = buildWorldBuffers(edges, cfg.geodesicSteps);
    syncBuffers();

    if (deps.statusEl) {
      deps.statusEl.textContent = `Edges: ${edges.length}`;
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
    setConfig: (p: ForestLayoutConfig) => {
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
