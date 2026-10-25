import { afterEach, expect, it, vi } from 'vitest';
import { CredentialDeliveryWorker } from '../../src/jobs/credential-delivery-worker.js';
import { createLogger } from '../../src/config/logger.js';

afterEach(() => { vi.useRealTimers(); });

it('starts immediately, never overlaps batches, and stops before another batch', async () => {
  vi.useFakeTimers();
  let finish: ((sent: number) => void) | undefined;
  const batch = vi.fn((signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return new Promise<number>((resolve) => { finish = resolve; });
  });
  const worker = new CredentialDeliveryWorker(5000, createLogger({ logLevel: 'silent' }), batch);
  worker.start(); worker.start();
  await vi.advanceTimersByTimeAsync(20000);
  expect(batch).toHaveBeenCalledTimes(1);
  finish?.(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(batch).toHaveBeenCalledTimes(2);
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  expect(batch.mock.calls[1]?.[0].aborted).toBe(true);
  await Promise.resolve(); expect(stopped).toBe(false);
  finish?.(0); await stopping;
  await vi.advanceTimersByTimeAsync(20000);
  worker.start();
  expect(batch).toHaveBeenCalledTimes(2);
});

it('recovers from batch failures without logging provider secrets', async () => {
  vi.useFakeTimers();
  const logger = createLogger({ logLevel: 'silent' });
  const error = vi.spyOn(logger, 'error');
  const batch = vi.fn().mockRejectedValueOnce(new Error('private-provider-secret')).mockResolvedValue(0);
  const worker = new CredentialDeliveryWorker(5000, logger, batch);
  worker.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(batch).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledOnce();
  expect(JSON.stringify(error.mock.calls)).not.toContain('private-provider-secret');
  await worker.stop();
  await vi.advanceTimersByTimeAsync(20000);
  expect(batch).toHaveBeenCalledTimes(2);
});

it('does not start after being stopped', async () => {
  const batch = vi.fn().mockResolvedValue(0);
  const worker = new CredentialDeliveryWorker(5000, createLogger({ logLevel: 'silent' }), batch);
  await worker.stop(); worker.start(); await Promise.resolve();
  expect(batch).not.toHaveBeenCalled();
});
