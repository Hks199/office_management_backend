import express from 'express';
import Joi from 'joi';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { testApp, testConfig } from '../helpers.js';
import { validate } from '../../src/middleware/validate.js';
import { sanitizeInput } from '../../src/middleware/sanitize-input.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { createLogger } from '../../src/config/logger.js';
import { loadConfig } from '../../src/config/env.js';
import { paginationSchema, locationSchema } from '../../src/shared/utils/validation-schemas.js';

describe('HTTP security boundaries', () => {
  it('does not log URL paths, queries, bodies, authorization or cookies', async () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done(); } });
    const config = testConfig({ logLevel: 'info' });
    const app = createApp(config, { logger: createLogger(config, sink), isDatabaseReady: () => Promise.resolve(true) });
    await request(app).post('/private-path-secret?token=query-secret').set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'sensitive=cookie-secret').send({ password: 'body-secret' }).expect(404);
    const output = chunks.join('');
    for (const secret of ['private-path-secret', 'query-secret', 'header-secret', 'cookie-secret', 'body-secret']) expect(output).not.toContain(secret);
    expect(output).toContain('request completed'); sink.end();
  });
  it('allows an exact CORS origin and rejects unrelated origins', async () => {
    const app = testApp();
    const allowed = await request(app).get('/api/v1/health/live').set('Origin', 'http://localhost:5173').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await request(app).get('/api/v1/health/live').set('Origin', 'https://attacker.invalid').expect(403);
    const preflight = await request(app).options('/api/v1/employees').set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST').expect(204);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
  });
  it('serves production CORS preflights for trusted HTTPS and the exact local frontend', async () => {
    const trustedOrigins = ['https://sunvika.niakylie.com', 'http://localhost:5173'];
    const config = loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent', RATE_LIMIT_STORE: 'mongo',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/sunvika-test', JWT_SECRET: 'test-signing-key-'.repeat(4),
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), CORS_ORIGINS: trustedOrigins.join(','),
      CREDENTIAL_UI_ORIGIN: 'https://sunvika.niakylie.com' });
    const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true) });
    for (const origin of trustedOrigins) {
      const preflight = await request(app).options('/api/v1/auth/login').set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type').expect(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    }
    const rejected = await request(app).options('/api/v1/auth/login').set('Origin', 'https://attacker.invalid')
      .set('Access-Control-Request-Method', 'POST').expect(403);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    const health = await request(app).get('/api/v1/health/live').set('Origin', 'http://localhost:5173').expect(200);
    expect(health.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(health.headers['access-control-allow-credentials']).toBe('true');
  });
  it('bounds JSON bodies and reports malformed JSON safely', async () => {
    const app = testApp({ bodyLimitBytes: 1024 });
    const huge = await request(app).post('/api/v1/not-found').send({ value: 'x'.repeat(2000) }).expect(413);
    expect(huge.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    const invalid = await request(app).post('/api/v1/not-found').set('Content-Type', 'application/json').send('{"password":"secret",').expect(400);
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_JSON' } });
    expect(invalid.text).not.toContain('secret');
  });
  it.each([
    '{"password":{"$ne":null}}', '{"__proto__":{"polluted":true}}',
    '{"nested":{"constructor":{"prototype":{"polluted":true}}}}', '{"user.name":"bad"}',
  ])('rejects operator and prototype injection %s', async (body) => {
    const response = await request(testApp()).post('/api/v1/not-found').set('Content-Type', 'application/json').send(body).expect(400);
    expect(response.body).toMatchObject({ error: { code: 'UNSAFE_INPUT' } });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('rejects operator query keys and deeply nested bodies', async () => {
    await request(testApp()).get('/api/v1/health/live?%24where=bad').expect(400);
    let value: unknown = 'leaf';
    for (let index = 0; index < 25; index++) value = { child: value };
    await request(testApp()).post('/api/v1/not-found').set('Content-Type', 'application/json').send(JSON.stringify(value)).expect(400);
  });
  it('keeps safe correlation IDs and replaces invalid ones', async () => {
    const app = testApp();
    const valid = await request(app).get('/api/v1/health/live').set('X-Request-Id', 'request_123').expect(200);
    expect(valid.headers['x-request-id']).toBe('request_123');
    const invalid = await request(app).get('/api/v1/health/live').set('X-Request-Id', '<script>bad</script>').expect(200);
    expect(invalid.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('limits requests, ignores spoofed forwarded IPs, and preserves health probes', async () => {
    const app = testApp({ rateLimitMax: 2 });
    await request(app).get('/missing').set('X-Forwarded-For', '192.0.2.1').expect(404);
    await request(app).get('/missing').set('X-Forwarded-For', '192.0.2.2').expect(404);
    const limited = await request(app).get('/missing').expect(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers['retry-after']).toBeDefined();
    await request(app).get('/api/v1/health/live').expect(200);
  });
});

describe('Joi middleware and errors', () => {
  function validationApp() {
    const app = express();
    app.use(express.json());
    app.use(sanitizeInput);
    app.get('/list', validate({ query: paginationSchema(['createdAt', 'name']) }), (_req, res) => {
      res.json(res.locals.validated?.query);
    });
    app.post('/location', validate({ body: Joi.object({ location: locationSchema.required() }) }), (_req, res) => {
      res.json(res.locals.validated?.body);
    });
    app.get('/failure', async () => { await Promise.resolve(); throw new Error('password=secret-123'); });
    app.use(errorHandler(createLogger(testConfig())));
    return app;
  }
  it('converts validated query values without mutating Express 5 request getters', async () => {
    const response = await request(validationApp()).get('/list?page=2&limit=10').expect(200);
    expect(response.body).toMatchObject({ page: 2, limit: 10, sortBy: 'createdAt', sortOrder: 'desc' });
  });
  it.each(['limit=1001', 'sortBy=passwordHash', 'page=-1', 'unknown=1', 'page=1&page=2'])('rejects unsafe pagination %s', async (query) => {
    await request(validationApp()).get(`/list?${query}`).expect(400);
  });
  it('validates coordinates and rejects extra fields without echoing sensitive values', async () => {
    await request(validationApp()).post('/location').send({ location: { latitude: 21.2514, longitude: 81.6296 } }).expect(200);
    const response = await request(validationApp()).post('/location').send({ location: { latitude: 91, longitude: 181 }, password: 'secret' }).expect(400);
    expect(response.body).toHaveProperty('error.details.0', { field: 'body.location.latitude', code: 'number.max' });
    expect(response.text).not.toContain('secret');
  });
  it('contains rejected async handler errors without leaking internals', async () => {
    const response = await request(validationApp()).get('/failure').expect(500);
    expect(response.body).toEqual({ success: false, message: 'An unexpected error occurred', error: { code: 'INTERNAL_ERROR', details: [] } });
    expect(response.text).not.toContain('secret');
  });
});
