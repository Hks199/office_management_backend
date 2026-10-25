import type { CorsOptions } from 'cors';
import type { AppConfig } from './env.js';
import { AppError } from '../shared/errors/app-error.js';

export function corsOptions(config: AppConfig): CorsOptions {
  const allowed = new Set(config.corsOrigins);
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) callback(null, true);
      else callback(new AppError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
    maxAge: 600,
  };
}
