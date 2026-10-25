import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';
import type { AppConfig } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { openApiDocument } from './config/swagger.js';
import { requestId } from './middleware/request-id.js';
import { sanitizeInput } from './middleware/sanitize-input.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { healthRoutes } from './modules/health/health.routes.js';
import cookieParser from 'cookie-parser';
import { AuthService } from './modules/auth/auth.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { administrationRoutes } from './modules/roles/role.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { branchRoutes } from './modules/branches/branch.routes.js';
import { locationRoutes } from './modules/locations/location.routes.js';
import { FileService } from './modules/files/file.service.js';
import type { PhotoStorage } from './modules/files/s3-storage.js';
import { fileRoutes } from './modules/files/file.routes.js';
import { attendanceRoutes } from './modules/attendance/attendance.routes.js';
import { commercialRoutes } from './modules/leads/commercial.routes.js';
import type { CommercialStorage } from './modules/csv-imports/commercial-storage.js';
import { reportRoutes } from './modules/reports/report.routes.js';
import { targetRoutes } from './modules/targets/target.routes.js';
import { dashboardRoutes } from './modules/dashboards/dashboard.routes.js';
import { HttpTelemetry } from './modules/operations/telemetry.js';
import { operationsRoutes } from './modules/operations/operations.routes.js';
import { displayRoutes } from './modules/display/display.routes.js';

interface AppDependencies { logger: Logger; isDatabaseReady: () => Promise<boolean>; photoStorage?: PhotoStorage; commercialStorage?: CommercialStorage }

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.set('query parser', 'simple');
  const telemetry = new HttpTelemetry();
  app.use(telemetry.middleware);
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(requestId);
  app.use(pinoHttp({
    logger: dependencies.logger,
    genReqId: (_req, res) => String(res.getHeader('X-Request-Id')),
    serializers: {
      req: (req: { id: string; method: string }) => ({ id: req.id, method: req.method }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: () => ({ message: 'Request failed' }),
    },
  }));
  app.use(helmet(config.nodeEnv === 'production' ? {} : { strictTransportSecurity: false }));
  app.use(cors(corsOptions(config)));
  app.use(createRateLimiter(config));
  app.use(express.json({ limit: config.bodyLimitBytes, strict: true, inflate: false }));
  app.use(sanitizeInput);
  app.use(cookieParser());
  app.use('/api/v1/health', healthRoutes(dependencies.isDatabaseReady));
  const auth = new AuthService(config);
  app.use('/api/v1/auth', authRoutes(config, auth));
  app.use('/api/v1', displayRoutes(auth));
  app.use('/api/v1', administrationRoutes(auth));
  app.use('/api/v1/employees', userRoutes(config, auth));
  app.use('/api/v1/branches', branchRoutes(auth));
  app.use('/api/v1/locations', locationRoutes(auth));
  const files = new FileService(config, dependencies.photoStorage);
  app.use('/api/v1/files', fileRoutes(auth, files));
  app.use('/api/v1/attendance', attendanceRoutes(auth, files));
  app.use('/api/v1', commercialRoutes(config, auth, dependencies.commercialStorage));
  app.use('/api/v1', reportRoutes(config, auth, dependencies.photoStorage));
  app.use('/api/v1', targetRoutes(auth));
  app.use('/api/v1/dashboard', dashboardRoutes(config, auth, dependencies.commercialStorage));
  app.use('/api/v1/operations', operationsRoutes(auth, telemetry));
  if (config.docsEnabled && config.nodeEnv !== 'production') {
    app.get('/api/v1/openapi.json', (_req, res) => { res.json(openApiDocument); });
    app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
      swaggerOptions: { persistAuthorization: false, validatorUrl: null },
    }));
  }
  app.use(notFound);
  app.use(errorHandler(dependencies.logger));
  return app;
}
