import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { MongoRateStore } from '../modules/operations/mongo-rate-store.js';

export function rateStore(config: AppConfig, namespace: 'http' | 'auth', windowMs: number) {
  return config.rateLimitStore === 'mongo' ? { store: new MongoRateStore(config.jwtSecret, namespace, windowMs) } : {};
}

export function createRateLimiter(config: AppConfig) {
  return rateLimit({
    ...rateStore(config, 'http', config.rateLimitWindowMs),
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Health probes must not consume client quotas or fail under normal probe traffic.
    skip: (req) => req.method === 'GET' && ['/api/v1/health/live', '/api/v1/health/ready'].includes(req.path),
    handler: (_req, res) => {
      res.status(429).json({ success: false, message: 'Too many requests',
        error: { code: 'RATE_LIMITED', details: [] } });
    },
  });
}
