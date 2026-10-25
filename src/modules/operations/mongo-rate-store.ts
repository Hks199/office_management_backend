import { createHmac } from 'node:crypto';
import type { Store, IncrementResponse } from 'express-rate-limit';
import { RequestLimitModel } from './rate-limit.model.js';
import { AppError } from '../../shared/errors/app-error.js';

// A shared fixed-window quota; expired documents are never relied on for enforcement.
// TTL is storage cleanup only. Keys contain neither IP addresses nor bearer credentials.
export class MongoRateStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  constructor(private readonly secret: string, namespace: 'http' | 'auth', private readonly windowMs: number,
    private readonly now: () => number = Date.now) { this.prefix = `v1:${namespace}:${String(windowMs)}:`; }

  private key(key: string): { id: string; expiresAt: Date } {
    const window = Math.floor(this.now() / this.windowMs);
    const digest = createHmac('sha256', this.secret).update(this.prefix).update(key).digest('hex');
    return { id: `${this.prefix}${String(window)}:${digest}`, expiresAt: new Date((window + 1) * this.windowMs) };
  }
  async increment(key: string): Promise<IncrementResponse> {
    const { id, expiresAt } = this.key(key);
    try {
      const increment = () => RequestLimitModel.findOneAndUpdate({ _id: id },
        { $inc: { hits: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: 'after', maxTimeMS: 2000 }).lean().exec();
      let record;
      try { record = await increment(); }
      catch (error) {
        // Simultaneous first hits may race on the unique _id. Count the losing request too.
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error;
        record = await increment();
      }
      return { totalHits: record.hits, resetTime: expiresAt };
    } catch { throw new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request protection is temporarily unavailable'); }
  }
  async decrement(key: string): Promise<void> {
    await RequestLimitModel.updateOne({ _id: this.key(key).id }, { $inc: { hits: -1 } }, { maxTimeMS: 2000 });
  }
  async resetKey(key: string): Promise<void> {
    await RequestLimitModel.deleteOne({ _id: this.key(key).id }, { maxTimeMS: 2000 });
  }
}
