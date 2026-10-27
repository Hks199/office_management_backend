import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './env.js';

export function createLogger(config: Pick<AppConfig, 'logLevel'>, destination?: DestinationStream) {
  const secrets = ['password', 'passwordHash', 'currentPassword', 'newPassword', 'token', 'tokenHash',
    'accessToken', 'refreshToken', 'csrfToken', 'csrfHash', 'encryptedToken', 'panelToken', 'secret', 'jwtSecret',
    'tokenEncryptionKey', 'smtpPassword', 'mongodbUri', 'redisUrl', 'upload', 'url', 'fields', 'objectKey', 'versionId', 'checksumSHA256', 'location', 'checkInLocation', 'checkOutLocation'];
  return pino({
    level: config.logLevel,
    base: { service: 'sunvika-office-api' },
    redact: {
      paths: [...secrets, ...secrets.map((name) => `*.${name}`),
        'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-employee-panel"]', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  }, destination);
}
