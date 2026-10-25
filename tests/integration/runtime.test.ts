import { get } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceRuntime } from '../../src/runtime.js';
import { createLogger } from '../../src/config/logger.js';
const runtimes: ServiceRuntime[] = [];
it('starts background work after connection and drains it before disconnecting', async () => {
  let finish: (() => void) | undefined;
  const startBackground = vi.fn();
  const stopBackground = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { service, dependencies } = runtime({ startBackground, stopBackground });
  await service.start(); expect(startBackground).toHaveBeenCalledOnce();
  const stopping = service.shutdown(0);
  await vi.waitFor(() => { expect(stopBackground).toHaveBeenCalledOnce(); });
  expect(dependencies.disconnect).not.toHaveBeenCalled();
  finish?.(); await stopping;
  expect(dependencies.disconnect).toHaveBeenCalledOnce();
});
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.shutdown(0); });
function runtime(overrides: Partial<ConstructorParameters<typeof ServiceRuntime>[2]> = {}, timeout = 1000) {
  const dependencies = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    forceExit: vi.fn(), app: (_req: Parameters<ConstructorParameters<typeof ServiceRuntime>[2]['app']>[0], res: Parameters<ConstructorParameters<typeof ServiceRuntime>[2]['app']>[1]) => { res.end('ok'); }, ...overrides };
  const service = new ServiceRuntime({ host: '127.0.0.1', port: 0, shutdownTimeoutMs: timeout }, createLogger({ logLevel: 'silent' }), dependencies);
  runtimes.push(service); return { service, dependencies };
}
it('stops accepting requests, drains an active response, then disconnects once', async () => {
  let finish: (() => void) | undefined; let started: (() => void) | undefined;
  const active = new Promise<void>((resolve) => { started = resolve; });
  const { service, dependencies } = runtime({ app: (_req, res) => { finish = () => { res.end('completed'); }; started?.(); } });
  await service.start(); expect(service.acceptingRequests).toBe(true);
  const response = new Promise<string>((resolve, reject) => {
    get(`http://127.0.0.1:${String(service.address.port)}/work`, (res) => { let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString(); }); res.on('end', () => { resolve(text); }); }).on('error', reject);
  });
  await active; const shutdown = service.shutdown(0); expect(service.acceptingRequests).toBe(false);
  expect(dependencies.disconnect).not.toHaveBeenCalled(); finish?.();
  expect(await response).toBe('completed'); expect(await shutdown).toBe(0);
  await service.shutdown(0); expect(dependencies.disconnect).toHaveBeenCalledTimes(1); expect(dependencies.forceExit).not.toHaveBeenCalled();
});
it('does not bind after termination while a database connection is pending', async () => {
  let connected: (() => void) | undefined;
  const { service, dependencies } = runtime({ connect: () => new Promise<void>((resolve) => { connected = resolve; }) });
  const starting = service.start(); const stopping = service.shutdown(0); connected?.();
  await starting; expect(await stopping).toBe(0); expect(service.server.listening).toBe(false); expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
});
it('keeps fatal shutdown nonzero when a normal shutdown is already in progress', async () => {
  let complete: (() => void) | undefined;
  let disconnecting: (() => void) | undefined; const active = new Promise<void>((resolve) => { disconnecting = resolve; });
  const { service } = runtime({ disconnect: () => new Promise<void>((resolve) => { complete = resolve; disconnecting?.(); }) });
  await service.start(); const stopping = service.shutdown(0); await active;
  void service.shutdown(1); complete?.(); expect(await stopping).toBe(1);
});
it('forces a nonzero exit when disconnect exceeds the shutdown deadline', async () => {
  const { service, dependencies } = runtime({ disconnect: () => new Promise<void>(() => undefined) }, 30);
  await service.start(); expect(await service.shutdown(0)).toBe(1); expect(dependencies.forceExit).toHaveBeenCalledTimes(1);
});
it('contains connection/disconnection failures without serializing secrets', async () => {
  const { service, dependencies } = runtime({ connect: () => Promise.reject(new Error('private-startup-secret')), disconnect: () => Promise.reject(new Error('private-disconnect-secret')) });
  await expect(service.start()).rejects.toThrow('private-startup-secret'); expect(await service.shutdown(1)).toBe(1);
  expect(service.server.listening).toBe(false); expect(dependencies.forceExit).toHaveBeenCalledOnce();
});
