import { Router } from 'express';
import { Types } from 'mongoose';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { bodyFrom, principalFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { uploadSchema } from './file.validator.js';
import type { UploadInput } from './file.model.js';
import type { FileService } from './file.service.js';
export function fileRoutes(auth: AuthService, files: FileService): Router {
  const router = Router(); router.use(authenticate(auth));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/upload-intents', authorize('files:upload'), authorize('attendance:create'), validate({ body: uploadSchema }), async (_req, res) => {
    sendSuccess(res, await files.intent(principalFrom(res), bodyFrom<UploadInput>(res), res.locals), 'Upload authorized', 201);
  });
  router.post('/:id/confirm', authorize('files:upload'), validate({ params: idParams }), async (_req, res) => {
    const id = new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
    sendSuccess(res, await files.confirm(principalFrom(res), id, res.locals), 'Upload confirmed');
  });
  router.get('/:id/download', authorize('files:read'), authorize('attendance:read'), validate({ params: idParams }), async (_req, res) => {
    const id = new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
    sendSuccess(res, await files.download(principalFrom(res), id));
  }); return router;
}
