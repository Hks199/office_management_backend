import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

const bounds = [10, 50, 100, 250, 500, 1000, 2500, 10000];
export class HttpTelemetry {
  private readonly started = performance.now();
  private readonly initialCpu = process.cpuUsage();
  private readonly initialLoop = performance.eventLoopUtilization();
  private requests = 0;
  private inFlight = 0;
  private aborted = 0;
  private durationMs = 0;
  private readonly statuses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  private readonly histogram = bounds.map(() => 0);

  middleware: RequestHandler = (_req, res, next) => {
    const start = performance.now(); this.inFlight++;
    let done = false;
    const complete = () => {
      if (done) return; done = true;
      const duration = performance.now() - start;
      this.inFlight--; this.requests++; this.durationMs += duration;
      if (!res.writableFinished) this.aborted++;
      else if (res.statusCode >= 500) this.statuses['5xx']++;
      else if (res.statusCode >= 400) this.statuses['4xx']++;
      else if (res.statusCode >= 300) this.statuses['3xx']++;
      else this.statuses['2xx']++;
      for (const [index, bound] of bounds.entries()) {
        if (duration <= bound) this.histogram[index] = (this.histogram[index] ?? 0) + 1;
      }
    };
    res.once('finish', complete); res.once('close', complete); next();
  };
  snapshot() {
    const memory = process.memoryUsage(); const cpu = process.cpuUsage(this.initialCpu);
    return {
      scope: 'PROCESS', uptimeSeconds: Math.floor((performance.now() - this.started) / 1000),
      requests: this.requests, inFlight: this.inFlight, aborted: this.aborted,
      statuses: { ...this.statuses }, durationMsSum: Math.round(this.durationMs),
      latencyCumulativeBuckets: bounds.map((leMs, index) => ({ leMs, count: this.histogram[index] })),
      eventLoopUtilization: performance.eventLoopUtilization(this.initialLoop).utilization,
      cpuUserMicroseconds: cpu.user, cpuSystemMicroseconds: cpu.system,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
    };
  }
}

export const databaseTelemetry = {
  connections: 0, checkedOut: 0, checkoutFailures: 0, commands: 0, commandFailures: 0,
  slowCommands: 0, durationMsSum: 0,
};
