import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from './config/env.js';
import type { Logger } from 'pino';

interface RuntimeDependencies {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  app: RequestListener;
  forceExit: () => void;
  startBackground?: () => void;
  stopBackground?: () => Promise<void>;
}
export class ServiceRuntime {
  readonly server: Server;
  private starting: Promise<void> | undefined;
  private stopping: Promise<number> | undefined;
  private draining = false;
  private failed = false;
  constructor(private readonly config: Pick<AppConfig, 'host' | 'port' | 'shutdownTimeoutMs'>,
    private readonly logger: Logger, private readonly dependencies: RuntimeDependencies) {
    this.server = createServer((req, res) => {
      if (this.draining && req.url?.split('?')[0] !== '/api/v1/health/live') {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(JSON.stringify({ success: false, message: 'Service is draining', error: { code: 'SERVICE_UNAVAILABLE', details: [] } })); return;
      }
      dependencies.app(req, res);
    });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 15000; this.server.keepAliveTimeout = 5000;
  }
  get acceptingRequests(): boolean { return !this.draining && this.server.listening; }
  get address(): AddressInfo { return this.server.address() as AddressInfo; }
  start(): Promise<void> { this.starting ??= this.listen(); return this.starting; }
  private async listen(): Promise<void> {
    await this.dependencies.connect(); if (this.draining) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => { this.server.removeListener('error', reject); resolve(); });
    });
    if (this.acceptingRequests) this.dependencies.startBackground?.();
    this.logger.info({ host: this.config.host, port: this.address.port }, 'API listening');
  }
  shutdown(exitCode: number): Promise<number> {
    if (exitCode !== 0) this.failed = true;
    this.draining = true; this.stopping ??= this.stop(); return this.stopping;
  }
  private async stop(): Promise<number> {
    this.logger.info('Service shutting down'); let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.failed = true; this.logger.fatal('Shutdown deadline exceeded');
        this.server.closeAllConnections(); this.dependencies.forceExit(); resolve();
      }, this.config.shutdownTimeoutMs); timer.unref();
    });
    const cleanup = async () => {
      await this.starting?.catch(() => undefined);
      const background = this.dependencies.stopBackground?.();
      const http = this.server.listening ? new Promise<void>((resolve, reject) => {
        this.server.close((error) => { if (error) reject(error); else resolve(); }); this.server.closeIdleConnections();
      }) : Promise.resolve();
      await Promise.all([background, http]);
      await this.dependencies.disconnect();
    };
    try { await Promise.race([cleanup(), deadline]); }
    catch { this.failed = true; this.logger.error('Graceful shutdown failed'); this.dependencies.forceExit(); }
    finally { clearTimeout(timer); }
    return this.failed ? 1 : 0;
  }
}
