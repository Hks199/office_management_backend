import { afterEach, expect, it, vi } from 'vitest';
import { CommercialJobsWorker } from '../../src/jobs/commercial-jobs-worker.js';
import { createLogger } from '../../src/config/logger.js';
afterEach(() => { vi.useRealTimers(); });
it('does not claim jobs when shutdown starts before the first batch', async () => {
  const batch = vi.fn().mockResolvedValue(0);
  const worker = new CommercialJobsWorker(5000, createLogger({ logLevel: 'silent' }), batch);
  worker.start(); await worker.stop(); worker.start();
  expect(batch).not.toHaveBeenCalled();
});
it('processes immediately without overlapping batches and drains on shutdown', async () => {
  vi.useFakeTimers();
  let finish: ((processed: number) => void) | undefined;
  const batch = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return new Promise<number>((resolve) => { finish = resolve; }); });
  const worker = new CommercialJobsWorker(5000, createLogger({ logLevel: 'silent' }), batch);
  worker.start(); worker.start(); await vi.advanceTimersByTimeAsync(20000);
  expect(batch).toHaveBeenCalledTimes(1);
  finish?.(1); await vi.advanceTimersByTimeAsync(5000); expect(batch).toHaveBeenCalledTimes(2);
  const stopping = worker.stop(); expect(batch.mock.calls[1]?.[0].aborted).toBe(true);
  finish?.(0); await stopping; await vi.advanceTimersByTimeAsync(20000);
  worker.start(); expect(batch).toHaveBeenCalledTimes(2);
});
it('recovers after batch failures without logging provider errors', async () => {
  vi.useFakeTimers();
  const logger = createLogger({ logLevel: 'silent' }); const error = vi.spyOn(logger, 'error');
  const batch = vi.fn().mockRejectedValueOnce(new Error('private-provider-secret')).mockResolvedValue(0);
  const worker = new CommercialJobsWorker(5000, logger, batch);
  worker.start(); await vi.advanceTimersByTimeAsync(5000);
  expect(batch).toHaveBeenCalledTimes(2); expect(JSON.stringify(error.mock.calls)).not.toContain('private-provider-secret');
  await worker.stop(); await vi.advanceTimersByTimeAsync(20000); expect(batch).toHaveBeenCalledTimes(2);
});
