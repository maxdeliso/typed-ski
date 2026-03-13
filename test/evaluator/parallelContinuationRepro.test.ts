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

function maybeUnrefTimer(timer: unknown): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

Deno.test({
  name: "ParallelArenaEvaluator - shared-evaluator concurrent repro logs",
  ignore: false,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const jobs: SKIExpression[] = [
      convergentWork(),
      omega(),
      omega(),
    ];
    const maxSteps = 512;

    const evaluator = await ParallelArenaEvaluatorWasm.create(
      2,
      undefined,
      { maxResubmits: 16 },
    );
    const events: string[] = [];

    const testPromise = (async () => {
      try {
        evaluator.onRequestQueued = (reqId, workerIndex) => {
          events.push(`Q req=${reqId} w=${workerIndex}`);
        };
        evaluator.onRequestYield = (
          reqId,
          workerIndex,
          _expr,
          _node,
          count,
        ) => {
          events.push(`Y req=${reqId} w=${workerIndex} n=${count}`);
        };
        evaluator.onRequestCompleted = (reqId, workerIndex) => {
          events.push(`C req=${reqId} w=${workerIndex}`);
        };
        evaluator.onRequestError = (reqId, workerIndex, _expr, error) => {
          events.push(`E req=${reqId} w=${workerIndex} msg=${error}`);
        };

        const settled = await Promise.all(
          jobs.map((expr) =>
            evaluator.reduceAsync(expr, maxSteps).then<
              PromiseFulfilledResult<SKIExpression>,
              PromiseRejectedResult
            >(
              (value) => ({ status: "fulfilled", value }),
              (reason) => ({ status: "rejected", reason }),
            )
          ),
        );
        return settled;
      } finally {
        evaluator.terminate();
      }
    })();

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        5000,
      );
      // Ensure timer doesn't keep Deno alive when the runtime supports it.
      maybeUnrefTimer(timeoutTimer);
    });

    let settled:
      | PromiseSettledResult<SKIExpression>[]
      | undefined;
    let observedClassification: string | null = null;
    try {
      const raced = await Promise.race([
        testPromise.then((result) => ({ kind: "settled" as const, result })),
        timeout,
      ]);
      if (raced.kind === "timeout") {
        observedClassification = "timeout";
        evaluator.terminate();
        await Promise.allSettled([testPromise]);
      } else {
        settled = raced.result;
      }
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }

    const errorMessages = (settled ?? [])
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map((result) => toErrorMessage(result.reason));
    const completed = (settled ?? []).filter((result) =>
      result.status === "fulfilled"
    ).length;
    const yielded = events.filter((line) => line.startsWith("Y ")).length;

    if (
      errorMessages.some((msg) =>
        msg.includes("Cannot convert Continuation node")
      )
    ) {
      observedClassification = "continuation-leak";
    } else if (
      errorMessages.some((msg) =>
        msg.includes("exceeded maximum resubmissions")
      )
    ) {
      observedClassification = "resubmission-limit";
    } else if (
      errorMessages.some((msg) =>
        msg.includes("exhausted max steps before reaching normal form")
      )
    ) {
      observedClassification = "step-budget-exhausted";
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
      !msg.includes("Cannot convert Continuation node") &&
      !msg.includes("exceeded maximum resubmissions") &&
      !msg.includes("exhausted max steps before reaching normal form")
    );
    if (unexpectedErrors.length > 0) {
      assert(
        false,
        `Observed unexpected unclassified errors: ${
          unexpectedErrors.join(" | ")
        }`,
      );
    }
  },
});
