import {
  parseSKI,
  prettyPrintSKI as prettyPrint,
  randExpression,
} from "@maxdeliso/typed-ski";
import {
  ParallelArenaEvaluatorWasm,
  ResubmissionLimitExceededError,
} from "../lib/evaluator/parallelArenaEvaluator.ts";

// Simple random source using JavaScript's built-in Math.random()
// Implements the RandomSource interface (just needs intBetween method)
class SimpleRandomSource {
  intBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

// UI Elements
const exprInput = document.getElementById("exprInput");
const randomSizeInput = document.getElementById("randomSizeInput");
const generateRandomBtn = document.getElementById("generateRandomBtn");
const runBtn = document.getElementById("runBtn");
const resetBtn = document.getElementById("resetBtn");
const hammerTimeBtn = document.getElementById("hammerTimeBtn");
const workerCountInput = document.getElementById("workerCountInput");
const maxStepsInput = document.getElementById("maxStepsInput");
const continuousToggle = document.getElementById("continuousToggle");
const batchSizeInput = document.getElementById("batchSizeInput");
const wasmStatus = document.getElementById("wasmStatus");
const totalPending = document.getElementById("totalPending");
const totalCompleted = document.getElementById("totalCompleted");
const totalErrors = document.getElementById("totalErrors");
const logOutput = document.getElementById("logOutput");
const loadingOverlay = document.getElementById("loadingOverlay");
const avgTime = document.getElementById("avgTime");
const totalTime = document.getElementById("totalTime");
const throughput = document.getElementById("throughput");
const gearButton = document.getElementById("gearButton");
const controlsContainer = document.getElementById("controlsContainer");

// State
let evaluator = null;
let evaluatorDead = false; // Track if evaluator has crashed (WASM trap)
let continuousMode = false;
let continuousRunning = false;
let pendingSingleRun = false; // Track if we're waiting for a single run to complete
let memoryLogInterval = null;
const SLOW_LOGGING = false; // Disable detailed logging in continuous mode for performance
let stats = {
  completed: 0,
  errors: 0,
  totalTime: 0,
  startTime: null,
};

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
  // FAST PATH: Skip DOM updates in continuous mode for performance (unless forced)
  if (continuousMode && !SLOW_LOGGING && !force) return;

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
  if (hammerTimeBtn) hammerTimeBtn.disabled = true;
  if (generateRandomBtn) generateRandomBtn.disabled = true;
  if (continuousToggle) continuousToggle.disabled = true;
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
    updatePendingCounts();
    const startNodeId = evaluator.toArena(expr);
    addLog(`Queued node ${startNodeId}`);

    // Set max steps before submitting
    evaluator.setMaxSteps(maxSteps);

    const resultNodeId = await evaluator.reduceArenaNodeIdAsync(
      startNodeId,
      expr,
    );
    const elapsed = performance.now() - start;

    addLog(`Result node ${resultNodeId}`);
    stats.completed++;
    stats.totalTime += elapsed;
    updateStats();
    updatePendingCounts();

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
        if (continuousToggle) {
          continuousToggle.classList.remove("active");
        }
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
    updateStats();
    updatePendingCounts();
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

  // Reset stats after cleaning up old evaluator
  stats = { completed: 0, errors: 0, totalTime: 0, startTime: null };
  updateStats();

  try {
    showLoading();
    wasmStatus.textContent = "Loading...";

    const workerCount = parseInt(workerCountInput.value, 10) || 4;
    console.log(`[DEBUG] Creating evaluator with workerCount: ${workerCount}`);
    if (workerCount < 1 || workerCount > 16) {
      throw new Error("Worker count must be between 1 and 16");
    }

    const originalConcurrency = navigator.hardwareConcurrency;
    Object.defineProperty(navigator, "hardwareConcurrency", {
      value: workerCount,
      writable: false,
      configurable: true,
    });

    try {
      evaluator = await ParallelArenaEvaluatorWasm.create(workerCount);
      evaluator.onRequestQueued = (
        _reqId,
        _workerIndex,
        _expr,
      ) => {
        updatePendingCounts();
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
        updatePendingCounts();
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
        updatePendingCounts();
      };
      startMemoryLogging(evaluator);
    } finally {
      Object.defineProperty(navigator, "hardwareConcurrency", {
        value: originalConcurrency,
        writable: false,
        configurable: true,
      });
    }

    updatePendingCounts();
    wasmStatus.textContent = "Ready";
    stats.startTime = Date.now();

    if (runBtn) runBtn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    if (generateRandomBtn) generateRandomBtn.disabled = false;
    if (hammerTimeBtn) hammerTimeBtn.disabled = false;
    hideLoading();

    // Restore continuous mode if it was on before
    if (wasContinuousMode) {
      continuousMode = true;
      continuousToggle.classList.add("active");
      startContinuous();
    }
  } catch (error) {
    wasmStatus.textContent = "Error";
    console.error(error);
    hideLoading();
  }
}

function generateRandom() {
  const size = parseInt(randomSizeInput.value, 10) || 10;
  if (size < 1 || size > 100) {
    alert("Size must be between 1 and 100");
    return;
  }
  const rs = new SimpleRandomSource();
  const expr = randExpression(rs, size);
  exprInput.value = prettyPrint(expr);
}

async function run() {
  if (!evaluator || evaluatorDead) return;

  try {
    if (pendingSingleRun || continuousRunning) return;
    const exprStr = exprInput.value.trim();
    const expr = parseSKI(exprStr);
    runBtn.disabled = true;
    pendingSingleRun = true;
    evaluator.reset();

    const maxSteps = parseInt(maxStepsInput.value, 10) || 1000;
    await submitAndTrack(expr, maxSteps, { highlightOnDone: true });
    pendingSingleRun = false;
    if (!evaluatorDead) {
      runBtn.disabled = false;
    }
  } catch (error) {
    console.error(error);
    pendingSingleRun = false;
    if (!evaluatorDead) {
      runBtn.disabled = false;
    }
  }
}

async function startContinuous() {
  if (continuousRunning || evaluatorDead) return;
  continuousRunning = true;

  // Sliding-window parallelism: keep at most N in-flight tasks.
  const parallelism = parseInt(batchSizeInput.value, 10) || 8;
  const inFlight = new Set();

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
      updatePendingCounts();
    });

    inFlight.add(p);
  };

  while (continuousMode && evaluator) {
    // Fill the window
    while (continuousMode && evaluator && inFlight.size < parallelism) {
      spawnOne();
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
}

function stopContinuous() {
  continuousMode = false;
  continuousRunning = false;
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
  }
}

function hammerTime() {
  if (evaluatorDead) {
    addLog(
      "[ERROR] Cannot start hammer time: evaluator has crashed. Please reload the page.",
      true,
    );
    return;
  }
  // If continuous mode is already running, turn it off
  if (continuousMode) {
    continuousMode = false;
    continuousToggle.classList.remove("active");
    stopContinuous();
    return;
  }

  // Optimized settings for high-performance parallel evaluation
  workerCountInput.value = "8";
  batchSizeInput.value = "24";
  randomSizeInput.value = "15";
  maxStepsInput.value = "20";

  // Enable continuous mode
  continuousMode = true;
  continuousToggle.classList.add("active");

  // Reload evaluator with max workers
  loadWasm().then(() => {
    // Start continuous mode
    if (!continuousRunning) {
      startContinuous();
    }
  });
}

// Event listeners
generateRandomBtn.addEventListener("click", generateRandom);
runBtn.addEventListener("click", run);
resetBtn.addEventListener("click", resetEvaluator);
if (hammerTimeBtn) {
  hammerTimeBtn.addEventListener("click", hammerTime);
}

continuousToggle.addEventListener("click", () => {
  if (evaluatorDead) return;
  continuousMode = !continuousMode;
  continuousToggle.classList.toggle("active", continuousMode);
  if (continuousMode) {
    startContinuous();
  } else {
    stopContinuous();
  }
});

workerCountInput.addEventListener("change", () => {
  loadWasm();
});

// Gear button scrolls to controls
gearButton.addEventListener("click", () => {
  controlsContainer.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Set optimized defaults for high-performance parallel evaluation
workerCountInput.value = "8";
batchSizeInput.value = "24";
randomSizeInput.value = "15";
maxStepsInput.value = "20";

// Load on startup
loadWasm();
