import { assert } from "std/assert";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";
import { apply, type SKIExpression } from "../../lib/ski/expression.ts";
import { I, S } from "../../lib/ski/terminal.ts";

function omega(): SKIExpression {
  // Ω = (S I I) (S I I), a classic divergent SKI term.
  const sii = apply(apply(S, I), I);
  return apply(sii, sii);
}

function convergentWork(depth = 64): SKIExpression {
  // Build (I I) nested over I to provide some convergent work.
  let expr: SKIExpression = I;
  const ki = apply(I, I); // Use a cheap convergent seed.
  for (let i = 0; i < depth; i++) {
    expr = apply(ki, expr);
  }
  return expr;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

Deno.test("ParallelArenaEvaluator - shared-evaluator concurrent repro logs", async () => {
  // Architectural note:
  // The current host/worker contract still reflects internal reducer control flow.
  // `Yield`/`IoWait` are surfaced as transport events, and host orchestration may
  // repeatedly resubmit in-flight work until it either reaches `Done` or trips a
  // policy guard (`maxResubmits`). This test intentionally captures that behavior:
  // it is not asserting a pure value-only API yet, but validating that we can
  // classify and observe this implementation-coupled state machine reliably.
  //
  // TODO (later design pass):
  // Move to a typed public reduction outcome model (`Done`, `BudgetExhausted`,
  // `IoWait`, `Cancelled`, `Error`) and keep continuation/suspension internals
  // fully opaque to host decode paths.
  const jobs: SKIExpression[] = [
    convergentWork(),
    omega(),
    omega(),
  ];
  const maxSteps = 512;

  const evaluator = await ParallelArenaEvaluatorWasm.create();
  const events: string[] = [];
  try {
    evaluator.onRequestQueued = (reqId, workerIndex) => {
      events.push(`Q req=${reqId} w=${workerIndex}`);
    };
    evaluator.onRequestYield = (reqId, workerIndex, _expr, _node, count) => {
      events.push(`Y req=${reqId} w=${workerIndex} n=${count}`);
    };
    evaluator.onRequestCompleted = (reqId, workerIndex) => {
      events.push(`C req=${reqId} w=${workerIndex}`);
    };
    evaluator.onRequestError = (reqId, workerIndex, _expr, error) => {
      events.push(`E req=${reqId} w=${workerIndex} msg=${error}`);
    };

    const settled = await Promise.allSettled(
      jobs.map((expr) => evaluator.reduceAsync(expr, maxSteps)),
    );
    const errorMessages = settled
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map((result) => toErrorMessage(result.reason));
    const completed = settled.filter((result) => result.status === "fulfilled")
      .length;
    const yielded = events.filter((line) => line.startsWith("Y ")).length;

    let observedClassification: string | null = null;
    if (
      errorMessages.some((msg) =>
        msg.includes("Cannot convert control pointer")
      )
    ) {
      observedClassification = "control-pointer-leak";
    } else if (
      errorMessages.some((msg) =>
        msg.includes("exceeded maximum resubmissions")
      )
    ) {
      observedClassification = "resubmission-limit";
    }

    console.log(
      `[repro] completed=${completed} yielded=${yielded} errors=${errorMessages.length} class=${
        observedClassification ?? "none"
      }`,
    );
    if (errorMessages.length > 0) {
      console.log(`[repro] errors: ${errorMessages.join(" | ")}`);
    }
    for (const line of events.slice(0, 80)) {
      console.log(`[repro] ${line}`);
    }

    const unexpectedErrors = errorMessages.filter((msg) =>
      !msg.includes("Cannot convert control pointer") &&
      !msg.includes("exceeded maximum resubmissions")
    );
    if (unexpectedErrors.length > 0) {
      assert(
        false,
        `Observed unexpected unclassified errors: ${
          unexpectedErrors.join(" | ")
        }`,
      );
    }
  } finally {
    evaluator.terminate();
  }
});
