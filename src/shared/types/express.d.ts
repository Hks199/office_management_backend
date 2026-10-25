import type { ValidatedRequest } from '../../middleware/validate.js';
import type { Principal } from '../../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      validated?: ValidatedRequest;
      principal?: Principal;
      scope?: Record<string, unknown>;
    }
  }
}

export {};
