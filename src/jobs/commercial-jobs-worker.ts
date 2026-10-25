import type { Logger } from 'pino';

// Durable jobs retain their own leases and authorization. This runner starts
// non-overlapping batches and drains the current batch before disconnecting.
export class CommercialJobsWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private started = false;
  private readonly controller = new AbortController();
  constructor(private readonly intervalMs: number, private readonly logger: Logger,
    private readonly runBatch: (signal: AbortSignal) => Promise<number>) {}
  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.logger.info({ intervalMs: this.intervalMs }, 'Automatic commercial job processing started');
    this.tick();
  }
  async stop(): Promise<void> {
    this.controller.abort(); clearTimeout(this.timer); await this.active;
  }
  private tick(): void {
    if (this.controller.signal.aborted) return;
    this.active = Promise.resolve().then(() => this.controller.signal.aborted ? 0 : this.runBatch(this.controller.signal))
      .then((processed) => { if (processed > 0) this.logger.info({ processed }, 'Commercial job attempts processed'); })
      .catch(() => { this.logger.error('Commercial job batch failed; the worker will retry'); })
      .finally(() => {
        this.active = undefined;
        if (!this.controller.signal.aborted) {
          this.timer = setTimeout(() => { this.tick(); }, this.intervalMs); this.timer.unref();
        }
      });
  }
}
