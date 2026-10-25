import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';

it('redacts credentials while retaining useful event context', () => {
  const chunks: string[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  const logger = createLogger({ logLevel: 'info' }, sink);
  logger.info({ password: 'plain-secret', user: { passwordHash: 'hash-secret' },
    newPassword: 'new-password-secret', config: { jwtSecret: 'jwt-key-secret' }, encryptedToken: 'delivery-secret',
    upload: { fields: { key: 'signed-upload-secret' } }, url: 'signed-download-secret',
    location: { latitude: 'private-gps-secret' }, photo: { objectKey: 'private-key-secret', versionId: 'private-version-secret' },
    req: { headers: { authorization: 'Bearer secret-jwt', cookie: 'secret-cookie' } }, action: 'LOGIN' }, 'Security event');
  const output = chunks.join('');
  for (const secret of ['plain-secret', 'hash-secret', 'secret-jwt', 'secret-cookie', 'new-password-secret', 'jwt-key-secret', 'delivery-secret',
    'signed-upload-secret', 'signed-download-secret', 'private-gps-secret', 'private-key-secret', 'private-version-secret']) expect(output).not.toContain(secret);
  expect(output).toContain('[REDACTED]');
  expect(output).toContain('LOGIN');
  sink.end();
});
