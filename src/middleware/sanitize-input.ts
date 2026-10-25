import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/app-error.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function inspect(value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError(400, 'UNSAFE_INPUT', 'Request nesting is too deep');
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key) || key.startsWith('$') || key.includes('.')) {
      throw new AppError(400, 'UNSAFE_INPUT', 'Request contains an unsupported field');
    }
    inspect(item, depth + 1);
  }
}

export const sanitizeInput: RequestHandler = (req, _res, next) => {
  try {
    inspect(req.body);
    inspect(req.query);
    inspect(req.params);
    next();
  } catch (error) { next(error); }
};
