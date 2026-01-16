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
  buildLayoutFromAtoms,
  type ForestLayoutConfig,
} from "../lib/render/layout.ts";

import {
  applyWorldMobiusTranslation,
  applyWorldRotation,
  buildWorldBuffers,
  type WorldBuffer,
} from "../lib/render/worldBuffer.ts";

export const DEFAULT_MAX_NODES = 50000;

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
    maxNodes: DEFAULT_MAX_NODES,
    geodesicSteps: 16,
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
  // Enable Additive Blending for Glow Effect
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Pure additive (Glow)
  gl.enableVertexAttribArray(progBundle.aPos);
  gl.enableVertexAttribArray(progBundle.aColor);

  // Boundary Sphere (Circle in 2D)
  const lineBuf = gl.createBuffer();
  const colorBuf = gl.createBuffer(); // New GPU Buffer
  const buildSphereGeom = (segments: number) => {
    const lines: number[] = [];
    const seg = Math.max(2, segments | 0);

    for (let i = 0; i < seg; i++) {
      const t1 = (i / seg) * Math.PI * 2;
      const t2 = ((i + 1) / seg) * Math.PI * 2;
      lines.push(Math.cos(t1), Math.sin(t1), 0);
      lines.push(Math.cos(t2), Math.sin(t2), 0);
    }
    return new Float32Array(lines);
  };
  let sphereGeom = buildSphereGeom(cfg.geodesicSteps);

  const sphereBuf = gl.createBuffer();
  const updateSphereBuffer = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sphereGeom, gl.STATIC_DRAW);
  };
  updateSphereBuffer();

  let world: WorldBuffer = {
    lines: new Float32Array(0),
    colors: new Float32Array(0),
  };
  let active = false;
  let raf = 0;

  // Camera State
  let camRot: Quat = [0, 0, 0, 1];
  let camDist = 2.5; // Closer default for better inspection

  // Mouse/Pointer Drag State
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragButton = 0; // 0 = left, 1 = middle, 2 = right

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
    // Sync Positions
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.lines, gl.DYNAMIC_DRAW);

    // Sync Colors (Static mostly, but rebuilt on layout change)
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, world.colors, gl.STATIC_DRAW);
  };

  const rebuild = () => {
    const ev = deps.getEvaluator();
    if (!ev?.memory || !ev?.$) return;
    const edges = buildLayoutFromAtoms(ev.memory, ev.$, cfg);

    world = buildWorldBuffers(edges, cfg.geodesicSteps);
    syncBuffers();

    if (deps.statusEl) {
      deps.statusEl.textContent = `Edges: ${edges.length}`;
    }
  };

  const drawInterleaved = () => {
    // Bind Position
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.vertexAttribPointer(progBundle.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(progBundle.aPos);

    // Bind Color
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.vertexAttribPointer(progBundle.aColor, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(progBundle.aColor);
  };

  const drawBoundaryCircle = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
    gl.vertexAttribPointer(progBundle.aPos, 3, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(progBundle.aPos);
    // Disable color attribute for boundary circle (will use uniform)
    gl.disableVertexAttribArray(progBundle.aColor);
  };

  const tick = () => {
    if (!active) return;
    resize();
    const aspect = deps.canvas.width / deps.canvas.height;

    // Standard Perspective
    mat4Perspective(mProj, (60 * Math.PI) / 180, aspect, 0.1, 50.0);

    // view matrix: just pull back. no rotation here.
    // we rotate the world data, not the camera, to preserve the disk logic.
    mat4Translate(mView, -camDist);

    mat4Mul(mMvp, mProj, mView);

    gl.useProgram(progBundle.program);
    gl.uniformMatrix4fv(progBundle.uMvp, false, mMvp);
    gl.clearColor(0.02, 0.02, 0.03, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1. Boundary Circle
    gl.disable(gl.DEPTH_TEST);
    gl.uniform3f(progBundle.uColor, 0.3, 0.4, 0.5);
    drawBoundaryCircle();
    gl.drawArrays(gl.LINES, 0, sphereGeom.length / 3);

    // 2. Tree Lines
    gl.enable(gl.DEPTH_TEST);
    drawInterleaved();
    gl.uniform3f(progBundle.uColor, 0.5, 0.5, 0.5);
    gl.drawArrays(gl.LINES, 0, world.lines.length / 3);

    raf = requestAnimationFrame(tick);
  };

  // hyperbolic pan (mobius translation)
  const move = (dir: Vec3, hStep: number) => {
    const distE = hyperToEuclidDist(hStep);
    // move relative to current disk orientation
    const stepLocal = v3Scale(v3Norm(dir), distE);
    // we apply the rotation to the input vector so 'up' is always 'screen up'
    const stepWorld = v3RotateByQuat(stepLocal, camRot);

    applyWorldMobiusTranslation(world.lines, stepWorld);
    syncBuffers();
  };

  const turn = (dZ: number) => {
    // only rotate around z (spinning the plate)
    const qDelta = quatFromEulerDeg(0, 0, dZ);
    camRot = quatMul(camRot, qDelta);
    const qInv = quatConj(qDelta);
    applyWorldRotation(world.lines, qInv);
    syncBuffers();
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      deps.canvas.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (!active) return;
    const fast = e.shiftKey ? 0.25 : 0.08; // Hyperbolic steps
    const spinSpeed = e.shiftKey ? 5 : 2; // Degrees

    switch (e.key.toLowerCase()) {
      case "f":
        toggleFullscreen();
        break;

      // panning (mobius translation)
      // works like dragging the map
      case "w":
      case "arrowup":
        move([0, 1, 0], fast);
        break;
      case "s":
      case "arrowdown":
        move([0, -1, 0], fast);
        break;
      case "a":
      case "arrowleft":
        move([-1, 0, 0], fast);
        break;
      case "d":
      case "arrowright":
        move([1, 0, 0], fast);
        break;

      // spinning (z-axis rotation)
      // rotates the disk so you can orient a branch upwards
      case "q":
        turn(spinSpeed);
        break;
      case "e":
        turn(-spinSpeed);
        break;

      // zoom (simple euclidean distance)
      case "z":
        camDist = Math.max(1.1, camDist - 0.2);
        break;
      case "x":
        camDist = Math.min(6.0, camDist + 0.2);
        break;

      case "r":
        rebuild();
        camRot = [0, 0, 0, 1];
        break;
    }
  };

  // Mouse/Pointer Drag Handlers
  const onPointerDown = (e: PointerEvent) => {
    if (!active) return;
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragButton = e.button;
    deps.canvas.setPointerCapture(e.pointerId);
    deps.canvas.style.cursor = dragButton === 0 ? "grabbing" : "grabbing";
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active || !isDragging) return;
    e.preventDefault();

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (dragButton === 0) {
      // left button: pan (mobius translation)
      // convert screen delta to world movement
      // normalize by canvas size to make it resolution-independent
      const canvasRect = deps.canvas.getBoundingClientRect();
      const normDx = dx / canvasRect.width;
      const normDy = -dy / canvasRect.height; // invert Y
      const panSensitivity = 0.5;
      const hStep = Math.hypot(normDx, normDy) * panSensitivity;

      // only move if there's meaningful movement
      if (hStep > 0.0001) {
        const dir: Vec3 = [normDx, normDy, 0];
        move(dir, hStep);
      }
    } else if (dragButton === 1 || dragButton === 2) {
      const canvasRect = deps.canvas.getBoundingClientRect();
      const rotSensitivity = 0.3;
      const dZ = -dx / canvasRect.width * rotSensitivity * 360;
      turn(dZ);
    }

    dragStartX = e.clientX;
    dragStartY = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    isDragging = false;
    deps.canvas.releasePointerCapture(e.pointerId);
    deps.canvas.style.cursor = "default";
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (isDragging) {
      isDragging = false;
      deps.canvas.releasePointerCapture(e.pointerId);
      deps.canvas.style.cursor = "default";
    }
  };

  // Wheel zoom handler
  const onWheel = (e: WheelEvent) => {
    if (!active) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? 1 : -1;
    const zoomSpeed = 0.15;
    const zoomDelta = delta * zoomSpeed;

    camDist = Math.max(1.1, Math.min(6.0, camDist + zoomDelta));
  };

  // suppress context menu on right click
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  // Add pointer event listeners
  deps.canvas.addEventListener("pointerdown", onPointerDown);
  deps.canvas.addEventListener("pointermove", onPointerMove);
  deps.canvas.addEventListener("pointerup", onPointerUp);
  deps.canvas.addEventListener("pointerleave", onPointerLeave);
  deps.canvas.addEventListener("wheel", onWheel, { passive: false });
  deps.canvas.addEventListener("contextmenu", onContextMenu);
  deps.canvas.style.cursor = "grab";
  deps.canvas.style.touchAction = "none"; // Prevent touch scrolling

  globalThis.addEventListener("keydown", onKey);

  resize();
  rebuild();

  return {
    setConfig: (p: ForestLayoutConfig) => {
      if (p.hStepSize) cfg.hStepSize = p.hStepSize;
      if (p.branchAngleDeg) cfg.branchAngleDeg = p.branchAngleDeg;
      if (p.maxNodes) cfg.maxNodes = p.maxNodes;
      if (p.geodesicSteps) {
        cfg.geodesicSteps = p.geodesicSteps;
        sphereGeom = buildSphereGeom(cfg.geodesicSteps);
        updateSphereBuffer();
      }
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
      deps.canvas.removeEventListener("pointerdown", onPointerDown);
      deps.canvas.removeEventListener("pointermove", onPointerMove);
      deps.canvas.removeEventListener("pointerup", onPointerUp);
      deps.canvas.removeEventListener("pointerleave", onPointerLeave);
      deps.canvas.removeEventListener("wheel", onWheel);
      deps.canvas.removeEventListener("contextmenu", onContextMenu);
      gl.deleteProgram(progBundle.program);
    },
  };
}
