// features/research/engine/rate-limit.ts
//
// Per-provider spacing so we never exceed provider etiquette. Process-local;
// the shared daily cap in the database is the cross-process safeguard.
export class MinIntervalLimiter {
  private nextAt = 0;
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Waits until this caller's slot; slots are handed out in call order. */
  async acquire(): Promise<void> {
    const current = this.now();
    const slot = Math.max(current, this.nextAt);
    this.nextAt = slot + this.intervalMs;
    const wait = slot - current;
    if (wait > 0) await this.sleep(wait);
  }
}
