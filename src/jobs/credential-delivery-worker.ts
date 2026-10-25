import type { Logger } from 'pino';

// The database outbox owns durability, claims and retry timing. This runner only
// schedules non-overlapping batches and stops claiming work during shutdown.
export class CredentialDeliveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private started = false;
  private readonly controller = new AbortController();

  constructor(private readonly intervalMs: number, private readonly logger: Logger,
    private readonly runBatch: (signal: AbortSignal) => Promise<number>) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.logger.info({ intervalMs: this.intervalMs }, 'Automatic credential delivery started');
    this.tick();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.active;
  }

  private tick(): void {
    if (this.controller.signal.aborted) return;
    this.active = Promise.resolve().then(() => this.runBatch(this.controller.signal))
      .then((sent) => { if (sent > 0) this.logger.info({ sent }, 'Credential emails submitted to SMTP'); })
      .catch(() => { this.logger.error('Credential delivery batch failed; the worker will retry'); })
      .finally(() => {
        this.active = undefined;
        if (!this.controller.signal.aborted) {
          this.timer = setTimeout(() => { this.tick(); }, this.intervalMs);
          this.timer.unref();
        }
      });
  }
}
