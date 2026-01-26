/**
 * Statistics tracking for ring buffer operations.
 *
 * Tracks counters for submit/pull operations and provides snapshots
 * for monitoring and debugging.
 *
 * @module
 */

export type ArenaRingStatsSnapshot = {
  submitOk: number;
  submitFull: number;
  submitNotConnected: number;
  pullEmpty: number;
  pullNonEmpty: number;
  completionsStashed: number;
  pending: number;
  completed: number;
};

/**
 * Tracks statistics for ring buffer operations.
 */
export class RingStats {
  private submitOk = 0;
  private submitFull = 0;
  private submitNotConnected = 0;
  private pullEmpty = 0;
  private pullNonEmpty = 0;
  private completionsStashed = 0;

  recordSubmitOk(): void {
    this.submitOk++;
  }

  recordSubmitFull(): void {
    this.submitFull++;
  }

  recordSubmitNotConnected(): void {
    this.submitNotConnected++;
  }

  recordPullEmpty(): void {
    this.pullEmpty++;
  }

  recordPullNonEmpty(): void {
    this.pullNonEmpty++;
  }

  recordCompletionStashed(): void {
    this.completionsStashed++;
  }

  getSnapshot(pending: number, completed: number): ArenaRingStatsSnapshot {
    return {
      submitOk: this.submitOk,
      submitFull: this.submitFull,
      submitNotConnected: this.submitNotConnected,
      pullEmpty: this.pullEmpty,
      pullNonEmpty: this.pullNonEmpty,
      completionsStashed: this.completionsStashed,
      pending,
      completed,
    };
  }

  reset(): void {
    this.submitOk = 0;
    this.submitFull = 0;
    this.submitNotConnected = 0;
    this.pullEmpty = 0;
    this.pullNonEmpty = 0;
    this.completionsStashed = 0;
  }
}
