import type { RequestHandler } from 'express';
import type { HealthService } from './health.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/utils/response.js';

export class HealthController {
  constructor(private readonly service: HealthService) {}

  live: RequestHandler = (_req, res) => {
    sendSuccess(res, { status: 'ok' }, 'Service is alive');
  };

  ready: RequestHandler = async (_req, res, next) => {
    if (!(await this.service.ready())) {
      next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Service is not ready'));
      return;
    }
    sendSuccess(res, { status: 'ready' }, 'Service is ready');
  };
}
