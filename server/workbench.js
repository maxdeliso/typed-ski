import {
  parseSKI,
  prettyPrintSKI as prettyPrint,
  randExpression,
} from "@maxdeliso/typed-ski";
import { ParallelArenaEvaluatorWasm } from "../lib/evaluator/parallelArenaEvaluator.ts";

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
const batchSizeLabel = document.getElementById("batchSizeLabel");
const wasmStatus = document.getElementById("wasmStatus");
const totalPending = document.getElementById("totalPending");
const totalCompleted = document.getElementById("totalCompleted");
const totalErrors = document.getElementById("totalErrors");
const workersGrid = document.getElementById("workersGrid");
const loadingOverlay = document.getElementById("loadingOverlay");
const avgTime = document.getElementById("avgTime");
const totalTime = document.getElementById("totalTime");
const throughput = document.getElementById("throughput");
const gearButton = document.getElementById("gearButton");
const controlsContainer = document.getElementById("controlsContainer");

// State
let evaluator = null;
let workerPanels = [];
let workerPendingCounts = [];
let workerOutputs = [];
let continuousMode = false;
let continuousRunning = false;
let pendingSingleRun = false; // Track if we're waiting for a single run to complete
let memoryLogInterval = null;
let stats = {
  completed: 0,
  errors: 0,
  totalTime: 0,
  startTime: null,
};

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
    }
  }
}

function logMemoryInfo(evaluator) {
  if (!evaluator || !evaluator.memory) return;

  const memoryBytes = evaluator.memory.buffer.byteLength;
  const memoryPages = memoryBytes / 65536;
  const wasmPages = evaluator.$.debugGetMemorySize?.() || 0;

  console.log(
    `[DEBUG] Current memory: ${memoryBytes} bytes (${memoryPages} pages), WASM reports ${wasmPages} pages`,
  );
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

function createWorkerPanels(count) {
  workersGrid.innerHTML = "";
  workerPanels = [];
  workerPendingCounts = [];
  workerOutputs = [];

  for (let i = 0; i < count; i++) {
    const panel = document.createElement("div");
    panel.className = "worker-panel";
    panel.innerHTML = `
      <div class="worker-header">
        <div class="worker-title">Worker ${i}</div>
        <div class="pending-indicator" id="pending-indicator-${i}">
          <div class="pending-bar">
            <div class="pending-bar-fill zero" id="pending-bar-${i}" style="width: 0%"></div>
          </div>
          <div class="pending-count" id="pending-count-${i}">0</div>
        </div>
      </div>
      <div class="worker-output" id="output-${i}"></div>
    `;
    workersGrid.appendChild(panel);
    workerPanels.push(panel);
    workerPendingCounts.push(0);
    workerOutputs.push(document.getElementById(`output-${i}`));
  }
  updatePendingCounts();
}

function updatePendingCounts() {
  if (!evaluator) return;

  const counts = evaluator.getPendingCounts();
  let total = 0;
  const maxPending = Math.max(1, ...counts, 10); // Use max of counts or 10, minimum 1

  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    workerPendingCounts[i] = count;
    total += count;

    const bar = document.getElementById(`pending-bar-${i}`);
    const countText = document.getElementById(`pending-count-${i}`);

    if (bar && countText) {
      const percentage = Math.min(100, (count / maxPending) * 100);
      bar.style.width = percentage + "%";
      bar.classList.toggle("zero", count === 0);
      countText.textContent = count;
    }
  }
  totalPending.textContent = total;
}

function addWorkerOutput(workerIndex, message) {
  const output = workerOutputs[workerIndex];
  if (output) {
    const timestamp = new Date().toLocaleTimeString();
    const newLine = `[${timestamp}] ${message}\n`;

    // Add the new line
    output.textContent += newLine;

    // Enforce 16KB limit (16384 bytes)
    const MAX_SIZE = 16 * 1024;
    const encoder = new TextEncoder();
    let currentSize = encoder.encode(output.textContent).length;

    if (currentSize > MAX_SIZE) {
      // Remove lines from the beginning until we're under the limit
      const lines = output.textContent.split("\n");
      while (currentSize > MAX_SIZE && lines.length > 1) {
        lines.shift(); // Remove first line
        output.textContent = lines.join("\n");
        currentSize = encoder.encode(output.textContent).length;
      }
    }

    output.scrollTop = output.scrollHeight;
  }
}

function setupEvaluatorCallbacks(evaluator) {
  // Set up callbacks to track worker activity
  evaluator.onRequestQueued = (_requestId, workerIndex, _expr) => {
    updatePendingCounts();
    addWorkerOutput(workerIndex, `Queued`);
  };

  evaluator.onRequestCompleted = (
    _requestId,
    workerIndex,
    _expr,
    arenaNodeId,
  ) => {
    updatePendingCounts();
    addWorkerOutput(workerIndex, `Result: node ${arenaNodeId}`);
    stats.completed++;
    updateStats();

    // Scroll to worker output if this was a single run (not continuous mode)
    if (pendingSingleRun && !continuousMode) {
      const workerPanel = workerPanels[workerIndex];
      if (workerPanel) {
        // Add highlight class
        workerPanel.classList.add("highlighted");

        // Small delay to ensure the output is rendered
        setTimeout(() => {
          workerPanel.scrollIntoView({ behavior: "smooth", block: "center" });

          // Remove highlight after animation completes
          setTimeout(() => {
            workerPanel.classList.remove("highlighted");
          }, 2000);
        }, 100);
      }
      pendingSingleRun = false; // Reset after scrolling
    }
  };

  evaluator.onRequestError = (_requestId, workerIndex, error) => {
    updatePendingCounts();
    addWorkerOutput(workerIndex, `Error: ${error}`);
    stats.errors++;
    updateStats();
  };
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

  // Reset stats after cleaning up old evaluator
  stats = { completed: 0, errors: 0, totalTime: 0, startTime: null };
  updateStats();

  try {
    showLoading();
    wasmStatus.textContent = "Loading...";

    const workerCount = parseInt(workerCountInput.value, 10) || 4;
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
      setupEvaluatorCallbacks(evaluator);
      startMemoryLogging(evaluator);
    } finally {
      Object.defineProperty(navigator, "hardwareConcurrency", {
        value: originalConcurrency,
        writable: false,
        configurable: true,
      });
    }

    createWorkerPanels(workerCount);
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
      batchSizeLabel.style.display = "flex";
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
  if (!evaluator) return;

  try {
    const exprStr = exprInput.value.trim();
    const expr = parseSKI(exprStr);
    evaluator.reset();

    // Mark that we're doing a single run (not continuous)
    pendingSingleRun = true;

    const maxSteps = parseInt(maxStepsInput.value, 10) || 1000;
    const start = performance.now();
    const _result = await evaluator.reduceAsync(expr, maxSteps);
    const elapsed = performance.now() - start;

    stats.totalTime += elapsed;
    updateStats();
    pendingSingleRun = false;
  } catch (error) {
    console.error(error);
    pendingSingleRun = false;
  }
}

async function startContinuous() {
  if (continuousRunning) return;
  continuousRunning = true;

  const batchSize = parseInt(batchSizeInput.value, 10) || 8;

  // Continuous loop that dispatches batches
  while (continuousMode && evaluator) {
    // Dispatch a batch of n requests - each with a unique random expression
    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      if (!continuousMode) break; // Check if we should stop

      // Generate a unique random expression for each request in the batch
      const size = parseInt(randomSizeInput.value, 10) || 10;
      const rs = new SimpleRandomSource();
      const expr = randExpression(rs, size);

      // Don't reset evaluator for each request - let them queue up
      const maxSteps = parseInt(maxStepsInput.value, 10) || 1000;
      const start = performance.now();
      const promise = evaluator.reduceAsync(expr, maxSteps).then((result) => {
        const elapsed = performance.now() - start;
        stats.totalTime += elapsed;
        updateStats();
        return result;
      }).catch((error) => {
        console.error(error);
      });

      promises.push(promise);
    }

    // Wait for all requests in the batch to complete
    await Promise.all(promises);

    // Small delay before next batch to allow UI updates
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  continuousRunning = false;
}

function stopContinuous() {
  continuousMode = false;
  continuousRunning = false;
}

function resetEvaluator() {
  if (evaluator) {
    evaluator.reset();
    stats = { completed: 0, errors: 0, totalTime: 0, startTime: Date.now() };
    updateStats();
    for (let i = 0; i < workerOutputs.length; i++) {
      workerOutputs[i].textContent = "";
    }
    workerPendingCounts.fill(0);
    updatePendingCounts();
  }
}

function hammerTime() {
  // If continuous mode is already running, turn it off
  if (continuousMode) {
    continuousMode = false;
    continuousToggle.classList.remove("active");
    batchSizeLabel.style.display = "none";
    stopContinuous();
    return;
  }

  // Max out all limits
  workerCountInput.value = "16";
  batchSizeInput.value = "100";
  randomSizeInput.value = "100";

  // Enable continuous mode
  continuousMode = true;
  continuousToggle.classList.add("active");
  batchSizeLabel.style.display = "flex";

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
  continuousMode = !continuousMode;
  continuousToggle.classList.toggle("active", continuousMode);
  batchSizeLabel.style.display = continuousMode ? "flex" : "none";
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

// Load on startup
loadWasm();
