/**
 * Shared async helpers for evaluator components.
 *
 * @module
 */

type CancellableSleep = {
  promise: Promise<void>;
  cancel: () => void;
};

/**
 * Cancellable sleep that returns both the timer promise and a cancellation function.
 */
export function sleep(ms: number): CancellableSleep {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, ms);
  });
  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  return { promise, cancel };
}
