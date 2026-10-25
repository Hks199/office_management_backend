import type { Response } from 'express';

export interface PaginationMeta { page: number; limit: number; total: number; totalPages: number; policyReviewRequired?: boolean }

export function sendSuccess(res: Response, data: unknown, message = 'Operation completed successfully',
  status = 200, meta?: PaginationMeta): void {
  res.status(status).json({ success: true, message, data, ...(meta ? { meta } : {}) });
}
