import { randExpression } from "@maxdeliso/typed-ski";
import {
  ParallelArenaEvaluatorWasm,
  ResubmissionLimitExceededError,
} from "../lib/evaluator/parallelArenaEvaluator.ts";
import { DEFAULT_MAX_NODES, initWebglForestViewer } from "./webglForest.ts";

// Simple random source using JavaScript's built-in Math.random()
// Implements the RandomSource interface (just needs intBetween method)
class SimpleRandomSource {
  intBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

function mustGetElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return element;
}

// UI Elements
const randomSizeInput = mustGetElement("randomSizeInput");
const runBtn = mustGetElement("runBtn");
const resetBtn = mustGetElement("resetBtn");
const workerCountInput = mustGetElement("workerCountInput");
const maxStepsInput = mustGetElement("maxStepsInput");
const batchSizeInput = mustGetElement("batchSizeInput");
const wasmStatus = mustGetElement("wasmStatus");
const totalPending = mustGetElement("totalPending");
const totalCompleted = mustGetElement("totalCompleted");
const totalErrors = mustGetElement("totalErrors");
const logOutput = mustGetElement("logOutput");
const loadingOverlay = mustGetElement("loadingOverlay");
const avgTime = mustGetElement("avgTime");
const totalTime = mustGetElement("totalTime");
const throughput = mustGetElement("throughput");
const gearButton = mustGetElement("gearButton");
const controlsContainer = mustGetElement("controlsContainer");

// Tabs (Performance vs WebGL)
const tabPerfBtn = mustGetElement("tabPerfBtn");
const tabWebglBtn = mustGetElement("tabWebglBtn");
const panelPerf = mustGetElement("panelPerf");
const panelWebgl = mustGetElement("panelWebgl");

// WebGL UI
const forestCanvas = document.getElementById("forestCanvas");
const webglStatus = document.getElementById("webglStatus");
const webglRebuildBtn = document.getElementById("webglRebuildBtn");
const webglHelpToggleBtn = document.getElementById("webglHelpToggleBtn");
const webglHelp = document.getElementById("webglHelp");
const webglMaxNodesInput = document.getElementById("webglMaxNodesInput");
const webglGeodesicStepsInput = document.getElementById(
  "webglGeodesicStepsInput",
);

// State
let evaluator = null;
let evaluatorDead = false; // Track if evaluator has crashed (WASM trap)
let continuousMode = false;
let continuousRunning = false;
let memoryLogInterval = null;
let stats = {
  completed: 0,
  errors: 0,
  totalTime: 0,
  startTime: null,
};
let webglActive = false;
let webglDirty = false;
let webglRebuildTimer = null;
let panelResizeObserver = null;
let workbenchTornDown = false;

const webglViewer = forestCanvas
  ? initWebglForestViewer({
    canvas: forestCanvas,
    getEvaluator: () => evaluator,
    statusEl: webglStatus,
  })
  : null;

// When the WebGL panel becomes visible, ensure the canvas has non-zero size before rendering.
if (webglViewer && panelWebgl && typeof ResizeObserver !== "undefined") {
  panelResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!webglActive) continue;
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        // Kick the viewer once layout is resolved.
        try {
          webglViewer.setActive(true);
        } catch (e) {
          console.error(e);
        }
      }
    }
  });
  panelResizeObserver.observe(panelWebgl);
}

function clearWebglRebuildTimer() {
  if (webglRebuildTimer) {
    clearTimeout(webglRebuildTimer);
    webglRebuildTimer = null;
  }
}

function scheduleWebglRebuild() {
  webglDirty = true;
  if (!webglActive || !webglViewer) return;
  if (webglRebuildTimer) return;
  webglRebuildTimer = setTimeout(() => {
    webglRebuildTimer = null;
    if (!webglViewer || !webglActive) return;
    webglDirty = false;
    try {
      webglViewer.requestRebuild();
    } catch (e) {
      console.error(e);
    }
  }, 500);
}

function teardownWorkbench() {
  if (workbenchTornDown) return;
  workbenchTornDown = true;

  continuousMode = false;
  continuousRunning = false;
  stopMemoryLogging();
  clearWebglRebuildTimer();

  if (panelResizeObserver) {
    panelResizeObserver.disconnect();
    panelResizeObserver = null;
  }

  if (evaluator) {
    evaluator.onRequestQueued = undefined;
    evaluator.onRequestCompleted = undefined;
    evaluator.onRequestError = undefined;
    evaluator.onRequestYield = undefined;
    evaluator.terminate();
    evaluator = null;
  }

  if (webglViewer) {
    try {
      webglViewer.destroy();
    } catch (e) {
      console.error(e);
    }
  }
}

function getPendingCountsSafe() {
  if (!evaluator) return [];
  // Prefer evaluator-provided tracking (ParallelArenaEvaluatorWasm).
  if (typeof evaluator.getPendingCounts === "function") {
    try {
      const counts = evaluator.getPendingCounts();
      return Array.isArray(counts) ? counts : [];
    } catch {
      return [];
    }
  }
  // Fallback: no per-worker info.
  return [];
}

function sumPending() {
  // Use the authoritative total pending count if available
  if (evaluator && typeof evaluator.getTotalPending === "function") {
    try {
      return evaluator.getTotalPending();
    } catch {
      // Fall through to per-worker sum
    }
  }
  // Fallback: sum per-worker counts (may be inaccurate)
  const counts = getPendingCountsSafe();
  let total = 0;
  for (const c of counts) total += c ?? 0;
  return total;
}

function showLoading() {
  loadingOverlay.classList.remove("hidden");
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// UI responsiveness: throttle DOM updates and coalesce stats/pending refreshes.
// ---------------------------------------------------------------------------
const UI_FLUSH_INTERVAL_MS = 100;
let uiFlushScheduled = false;
let uiStatsDirty = false;
let uiPendingDirty = false;
let lastUiFlushMs = 0;

function nowMs() {
  return (typeof performance !== "undefined" &&
      typeof performance.now === "function")
    ? performance.now()
    : Date.now();
}

function markUiDirty(
  { stats: statsDirty = false, pending: pendingDirty = false } = {},
) {
  if (statsDirty) uiStatsDirty = true;
  if (pendingDirty) uiPendingDirty = true;
  scheduleUiFlush();
}

function scheduleUiFlush() {
  if (uiFlushScheduled) return;
  uiFlushScheduled = true;

  const delay = Math.max(0, UI_FLUSH_INTERVAL_MS - (nowMs() - lastUiFlushMs));
  const flush = () => {
    uiFlushScheduled = false;
    // If we ran too early (e.g. rAF), reschedule for the remaining delay.
    const remaining = UI_FLUSH_INTERVAL_MS - (nowMs() - lastUiFlushMs);
    if (remaining > 0) {
      scheduleUiFlush();
      return;
    }
    lastUiFlushMs = nowMs();
    if (uiStatsDirty) {
      uiStatsDirty = false;
      updateStats();
    }
    if (uiPendingDirty) {
      uiPendingDirty = false;
      updatePendingCounts();
    }
  };

  if (typeof requestAnimationFrame === "function") {
    if (delay === 0) {
      requestAnimationFrame(flush);
    } else {
      setTimeout(() => requestAnimationFrame(flush), delay);
    }
  } else {
    setTimeout(flush, delay);
  }
}

function updateStats() {
  totalCompleted.textContent = stats.completed;
  totalErrors.textContent = stats.errors;
  totalTime.textContent = stats.totalTime.toFixed(2);

  if (stats.completed > 0) {
    avgTime.textContent = (stats.totalTime / stats.completed).toFixed(2);
  } else {
    avgTime.textContent = "0";
  }

  if (stats.startTime) {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    if (elapsed > 0) {
      throughput.textContent = (stats.completed / elapsed).toFixed(2);

      // Calculate and display effective parallelism
      const parallelism = (stats.totalTime / 1000) / elapsed;
      throughput.title = `Effective Parallelism: ${parallelism.toFixed(2)}x`;
    }
  }
}

function logMemoryInfo(evaluator) {
  if (!evaluator || !evaluator.memory) return;

  const memoryBytes = evaluator.memory.buffer.byteLength;
  const memoryPages = memoryBytes / 65536;

  const memoryInfo =
    `Current memory: ${memoryBytes} bytes (${memoryPages} pages)`;
  console.log(`[DEBUG] ${memoryInfo}`);
  addLog(`[MEMORY] ${memoryInfo}`, true);
}

function startMemoryLogging(evaluator) {
  // Clear any existing interval
  if (memoryLogInterval) {
    clearInterval(memoryLogInterval);
  }

  // Log immediately
  logMemoryInfo(evaluator);

  // Log every 10 seconds
  memoryLogInterval = setInterval(() => {
    logMemoryInfo(evaluator);
  }, 10000);
}

function stopMemoryLogging() {
  if (memoryLogInterval) {
    clearInterval(memoryLogInterval);
    memoryLogInterval = null;
  }
}

function updatePendingCounts() {
  if (!evaluator) return;
  const total = sumPending();
  totalPending.textContent = total;
}

function addLog(message, force = false) {
  if (continuousMode && !force) return;

  if (!logOutput) return;
  const timestamp = new Date().toLocaleTimeString();
  const newLine = `[${timestamp}] ${message}\n`;

  logOutput.textContent += newLine;

  // Enforce 64KB limit in UI log to avoid unbounded DOM growth.
  const MAX_SIZE = 64 * 1024;
  const encoder = new TextEncoder();
  let currentSize = encoder.encode(logOutput.textContent).length;
  if (currentSize > MAX_SIZE) {
    const lines = logOutput.textContent.split("\n");
    while (currentSize > MAX_SIZE && lines.length > 1) {
      lines.shift();
      logOutput.textContent = lines.join("\n");
      currentSize = encoder.encode(logOutput.textContent).length;
    }
  }

  logOutput.scrollTop = logOutput.scrollHeight;
}

function disableAllButtons() {
  if (runBtn) runBtn.disabled = true;
  if (resetBtn) resetBtn.disabled = true;
}

async function submitAndTrack(
  expr,
  maxSteps,
  { highlightOnDone = false } = {},
) {
  if (!evaluator) throw new Error("Evaluator not initialized");
  if (evaluatorDead) {
    throw new Error(
      "Evaluator has crashed (WASM trap). Please reload the page.",
    );
  }

  const start = performance.now();

  try {
    markUiDirty({ pending: true });
    const startNodeId = evaluator.toArena(expr);
    addLog(`Queued node ${startNodeId}`);
    scheduleWebglRebuild();

    // Pass maxSteps directly to the request
    const resultNodeId = await evaluator.reduceArenaNodeIdAsync(
      startNodeId,
      expr,
      maxSteps,
    );
    const elapsed = performance.now() - start;

    addLog(`Result node ${resultNodeId}`);
    scheduleWebglRebuild();
    stats.completed++;
    stats.totalTime += elapsed;
    markUiDirty({ stats: true, pending: true });

    void highlightOnDone; // highlight removed in single-log UI

    return resultNodeId;
  } catch (error) {
    // Track elapsed time even for failed requests
    const elapsed = performance.now() - start;
    stats.totalTime += elapsed;

    // Check if this is a resubmission limit error
    const isResubmitLimit = error instanceof ResubmissionLimitExceededError;

    // Check if this is a WASM RuntimeError (unreachable trap, OOM, etc.)
    const isWasmTrap = error instanceof Error &&
      (error.name === "RuntimeError" ||
        error.message?.includes("unreachable") ||
        error.message?.includes("RuntimeError"));

    if (isWasmTrap && !evaluatorDead) {
      evaluatorDead = true;
      addLog(
        `[FATAL] WASM trapped (likely OOM / memory exhausted). Evaluator is no longer usable. Arena contents preserved for analysis.`,
        true,
      );
      disableAllButtons();
      // Stop continuous mode if running
      if (continuousMode) {
        stopContinuous();
        continuousMode = false;
        updateRunButton();
      }
    } else if (isResubmitLimit) {
      // Resubmission limit is a normal error condition, not a fatal crash
      const errorMsg = error?.message ?? String(error);
      addLog(`[ERROR] Evaluation failed: ${errorMsg}`, true);
    } else {
      // Log error details (may duplicate onRequestError callback, but ensures visibility)
      const errorMsg = error?.message ?? String(error);
      addLog(`[ERROR] Evaluation failed: ${errorMsg}`, true);
    }

    stats.errors++;
    markUiDirty({ stats: true, pending: true });
    throw error;
  }
}

async function loadWasm() {
  stopMemoryLogging();

  // Save continuous mode state before cleanup
  const wasContinuousMode = continuousMode;

  // Stop continuous mode before cleaning up old evaluator
  if (continuousMode) {
    stopContinuous();
  }

  // Clean up old evaluator and clear callbacks to prevent stale stats updates
  if (evaluator) {
    evaluator.onRequestQueued = undefined;
    evaluator.onRequestCompleted = undefined;
    evaluator.onRequestError = undefined;
    evaluator.terminate();
    evaluator = null;
  }

  // Reset dead flag when loading a new evaluator
  evaluatorDead = false;
  scheduleWebglRebuild();

  // Reset stats after cleaning up old evaluator
  stats = { completed: 0, errors: 0, totalTime: 0, startTime: null };
  updateStats();

  try {
    showLoading();
    wasmStatus.textContent = "Loading...";

    const defaultWorkers = navigator.hardwareConcurrency || 4;
    const workerCount = parseInt(workerCountInput.value, 10) || defaultWorkers;
    console.log(`[DEBUG] Creating evaluator with workerCount: ${workerCount}`);
    if (workerCount < 1 || workerCount > 256) {
      throw new Error("Worker count must be between 1 and 256");
    }

    evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);
    evaluator.onRequestQueued = (
      _reqId,
      _workerIndex,
      _expr,
    ) => {
      markUiDirty({ pending: true });
    };
    evaluator.onRequestYield = (
      reqId,
      _workerIndex,
      _expr,
      suspensionNodeId,
      resubmitCount,
    ) => {
      addLog(
        `[RESUBMIT] Requeued req ${reqId} suspension ${suspensionNodeId} (resubmit #${resubmitCount})`,
      );
      markUiDirty({ pending: true });
    };
    evaluator.onRequestError = (
      reqId,
      _workerIndex,
      _expr,
      errorMessage,
    ) => {
      // Log errors immediately when they occur (before promise rejection)
      // Force logging even in continuous mode for critical errors
      addLog(`[ERROR] Request ${reqId}: ${errorMessage}`, true);
      markUiDirty({ pending: true });
    };
    startMemoryLogging(evaluator);

    markUiDirty({ pending: true });
    wasmStatus.textContent = "Ready";
    stats.startTime = Date.now();

    if (runBtn) runBtn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    hideLoading();

    // Restore run toggle if it was on before
    if (wasContinuousMode) {
      startRun();
    }
  } catch (error) {
    wasmStatus.textContent = "Error";
    console.error(error);
    hideLoading();
  }
}

function updateRunButton() {
  if (!runBtn) return;
  if (continuousMode) {
    runBtn.textContent = "■ Stop";
    runBtn.classList.remove("btn-primary");
    runBtn.classList.add("btn-danger");
  } else {
    runBtn.textContent = "▶ Run";
    runBtn.classList.remove("btn-danger");
    runBtn.classList.add("btn-primary");
  }
  // Reset should not be usable while continuous mode is running (it would race with
  // active submissions / in-flight work).
  if (resetBtn) {
    resetBtn.disabled = continuousMode || continuousRunning;
  }
}

function startRun() {
  if (!evaluator || evaluatorDead) return;
  if (continuousMode) return;
  continuousMode = true;
  updateRunButton();
  startContinuous();
}

function stopRun() {
  if (!continuousMode) return;
  continuousMode = false;
  updateRunButton();
  stopContinuous();
}

function toggleRun() {
  if (!evaluator || evaluatorDead) return;
  if (continuousMode) stopRun();
  else startRun();
}

async function startContinuous() {
  if (continuousRunning || evaluatorDead) return;
  continuousRunning = true;
  updateRunButton();

  // Sliding-window parallelism: keep at most N in-flight tasks.
  const parallelism = parseInt(batchSizeInput.value, 10) || 1024;
  const inFlight = new Set();

  // Yield while ramping up so the toggle/UI stays responsive even at large parallelism.
  const YIELD_BUDGET_MS = 8;
  const MAX_SPAWNS_PER_SLICE = 64;
  const yieldToRenderer = () =>
    (typeof requestAnimationFrame === "function")
      ? new Promise((r) => requestAnimationFrame(() => r()))
      : new Promise((r) => setTimeout(r, 0));

  const spawnOne = () => {
    // Generate a unique random expression for each request
    const size = parseInt(randomSizeInput.value, 10) || 10;
    const rs = new SimpleRandomSource();
    const expr = randExpression(rs, size);
    const maxSteps = parseInt(maxStepsInput.value, 10) || 1000;

    const p = submitAndTrack(expr, maxSteps).then(() => {
      // noop
    }).catch((error) => {
      console.error(error);
      // Log ResubmissionLimitExceededError to the UI log (forced even in continuous mode)
      if (error instanceof ResubmissionLimitExceededError) {
        addLog(`[ERROR] ${error.message}`, true);
      }
    }).finally(() => {
      inFlight.delete(p);
      markUiDirty({ pending: true });
    });

    inFlight.add(p);
  };

  while (continuousMode && evaluator) {
    // Fill the window
    let sliceStart = nowMs();
    let spawnedThisSlice = 0;
    while (continuousMode && evaluator && inFlight.size < parallelism) {
      spawnOne();
      spawnedThisSlice++;
      if (
        spawnedThisSlice >= MAX_SPAWNS_PER_SLICE ||
        nowMs() - sliceStart >= YIELD_BUDGET_MS
      ) {
        spawnedThisSlice = 0;
        sliceStart = nowMs();
        await yieldToRenderer();
        sliceStart = nowMs();
      }
    }

    if (!continuousMode || !evaluator) break;

    // If we somehow have nothing in flight, yield a bit and retry.
    if (inFlight.size === 0) {
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }

    // Wait for the next completion (sliding window).
    await Promise.race(inFlight);

    // Yield to keep UI responsive even if completions are very fast.
    await new Promise((r) => setTimeout(r, 0));
  }

  continuousRunning = false;
  updateRunButton();
}

function stopContinuous() {
  continuousRunning = false;
  updateRunButton();
}

function resetEvaluator() {
  if (evaluatorDead) {
    addLog(
      "[ERROR] Cannot reset: evaluator has crashed. Please reload the page.",
      true,
    );
    return;
  }
  if (evaluator) {
    evaluator.reset();
    stats = { completed: 0, errors: 0, totalTime: 0, startTime: Date.now() };
    updateStats();
    if (logOutput) logOutput.textContent = "";
    updatePendingCounts();
    scheduleWebglRebuild();
  }
}

function setActiveTab(tab) {
  const isWebgl = tab === "webgl";
  webglActive = isWebgl;
  if (tabPerfBtn) {
    tabPerfBtn.classList.toggle("active", !isWebgl);
    tabPerfBtn.setAttribute("aria-selected", String(!isWebgl));
  }
  if (tabWebglBtn) {
    tabWebglBtn.classList.toggle("active", isWebgl);
    tabWebglBtn.setAttribute("aria-selected", String(isWebgl));
  }
  if (panelPerf) panelPerf.classList.toggle("hidden", isWebgl);
  if (panelWebgl) panelWebgl.classList.toggle("hidden", !isWebgl);

  if (webglViewer) {
    webglViewer.setActive(isWebgl);
    if (isWebgl && webglDirty) {
      webglDirty = false;
      try {
        webglViewer.requestRebuild();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// Event listeners
runBtn.addEventListener("click", toggleRun);
resetBtn.addEventListener("click", resetEvaluator);

workerCountInput.addEventListener("change", () => {
  loadWasm();
});

// Gear button scrolls to controls
gearButton.addEventListener("click", () => {
  controlsContainer.scrollIntoView({ behavior: "smooth", block: "start" });
});

if (tabPerfBtn) {
  tabPerfBtn.addEventListener("click", () => setActiveTab("perf"));
}
if (tabWebglBtn) {
  tabWebglBtn.addEventListener("click", () => setActiveTab("webgl"));
}

if (webglRebuildBtn) {
  webglRebuildBtn.addEventListener("click", () => {
    if (!webglViewer) return;
    webglDirty = false;
    webglViewer.requestRebuild();
  });
}

if (webglHelpToggleBtn && webglHelp) {
  webglHelpToggleBtn.addEventListener("click", () => {
    const isHidden = webglHelp.classList.contains("hidden");
    webglHelp.classList.toggle("hidden", !isHidden);
    // If we're currently on the WebGL tab, a size change can require a viewport update.
    if (webglViewer && webglActive) {
      webglViewer.setActive(true);
    }
  });
}
if (webglMaxNodesInput) {
  webglMaxNodesInput.value = String(DEFAULT_MAX_NODES);
  webglMaxNodesInput.addEventListener("change", () => {
    if (!webglViewer) return;
    const maxNodes = parseInt(webglMaxNodesInput.value, 10) ||
      DEFAULT_MAX_NODES;
    webglViewer.setConfig({ maxNodes });
    scheduleWebglRebuild();
  });
}
if (webglGeodesicStepsInput) {
  webglGeodesicStepsInput.addEventListener("change", () => {
    if (!webglViewer) return;
    const geodesicSteps = parseInt(webglGeodesicStepsInput.value, 10) || 16;
    webglViewer.setConfig({ geodesicSteps });
    scheduleWebglRebuild();
  });
}

// Set optimized defaults for high-performance parallel evaluation
workerCountInput.value = String(navigator.hardwareConcurrency || 4);
batchSizeInput.value = "1024";
maxStepsInput.value = "1000";
updateRunButton();

// Default to performance tab
setActiveTab("perf");

// Load on startup
loadWasm();

globalThis.addEventListener("pagehide", teardownWorkbench);
globalThis.addEventListener("beforeunload", teardownWorkbench);
