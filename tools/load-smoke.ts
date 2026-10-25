import { performance } from 'node:perf_hooks';

function integer(name: string, fallback: number, max: number): number {
  const raw = process.env[name]; const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
async function main() {
  const base = new URL(process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('LOAD_BASE_URL must be an HTTP(S) origin');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && process.env.LOAD_ALLOW_REMOTE !== 'true') throw new Error('Remote load requires explicit LOAD_ALLOW_REMOTE=true');
  const path = process.env.LOAD_PATH ?? '/api/v1/health/ready'; const url = new URL(path, base);
  if (url.origin !== base.origin || url.hash || !/^\/api\/v1\/(?:health\/(?:live|ready)|dashboard\/(?:overview|attendance|leads|targets|employee-performance|branch-performance|role-performance|lead-funnel|trends))$/.test(url.pathname)) throw new Error('LOAD_PATH must select a supported read-only health/dashboard endpoint');
  const total = integer('LOAD_REQUESTS', 100, 10000); const concurrency = integer('LOAD_CONCURRENCY', 5, 50);
  const timeout = integer('LOAD_TIMEOUT_MS', 10000, 30000); const token = process.env.LOAD_BEARER_TOKEN;
  if (url.pathname.includes('/dashboard/') && !token) throw new Error('Dashboard load requires LOAD_BEARER_TOKEN');
  let next = 0; let errors = 0; const durations: number[] = []; const statuses: Record<string, number> = {}; const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) {
      next++; const start = performance.now();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error', headers: token ? { Authorization: `Bearer ${token}` } : {} });
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
        // Drain without retaining/logging response bodies. Dashboard responses are bounded.
        await response.body?.pipeTo(new WritableStream({ write: () => Promise.resolve() }));
        if (!response.ok) errors++;
      } catch { errors++; }
      durations.push(performance.now() - start);
    }
  }));
  durations.sort((a, b) => a - b);
  const percentile = (fraction: number) => Math.round(durations[Math.max(0, Math.ceil(total * fraction) - 1)] ?? 0);
  process.stdout.write(`${JSON.stringify({ requests: total, concurrency, errors, statuses, elapsedMs: Math.round(performance.now() - started), latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } })}\n`);
  if (errors > 0) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('Load smoke failed: check LOAD_* settings and target availability; no credentials were printed.\n'); process.exitCode = 1; });
