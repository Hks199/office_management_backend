import request from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { testApp } from '../helpers.js';
import { openApiDocument } from '../../src/config/swagger.js';

describe('application health and documentation', () => {
  it('returns minimal liveness and security headers', async () => {
    const response = await request(testApp()).get('/api/v1/health/live').expect(200);
    expect(response.body).toEqual({ success: true, message: 'Service is alive', data: { status: 'ok' } });
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-request-id']).toBeDefined();
  });
  it('returns readiness only when its dependency is ready', async () => {
    await request(testApp()).get('/api/v1/health/ready').expect(200);
    const response = await request(testApp({}, () => Promise.resolve(false))).get('/api/v1/health/ready').expect(503);
    expect(response.body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
  });
  it('contains dependency exceptions', async () => {
    const app = testApp({}, () => Promise.reject(new Error('private-connection-secret')));
    const response = await request(app).get('/api/v1/health/ready').expect(503);
    expect(response.text).not.toContain('private-connection-secret');
  });
  it('has no public registration or placeholder business endpoints', async () => {
    for (const path of ['/api/v1/auth/register', '/api/v1/solar-projects']) {
      const response = await request(testApp()).post(path).send({}).expect(404);
      expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    await request(testApp()).post('/api/v1/leads').send({}).expect(401);
    await request(testApp()).post('/api/v1/targets').send({}).expect(401);
    await request(testApp()).get('/api/v1/dashboard/overview').expect(401);
  });
  it('serves opted-in docs and a valid OpenAPI specification', async () => {
    const app = testApp({ docsEnabled: true });
    await request(app).get('/api/v1/docs/').expect(200).expect('Content-Type', /html/);
    const response = await request(app).get('/api/v1/openapi.json').expect(200);
    expect(response.body).toHaveProperty(['paths', '/health/ready']);
    await expect(SwaggerParser.validate(structuredClone(openApiDocument))).resolves.toBeDefined();
  });
  it('disables docs by default and in production even when passed an unsafe override', async () => {
    await request(testApp()).get('/api/v1/docs/').expect(404);
    await request(testApp({ nodeEnv: 'production', docsEnabled: true })).get('/api/v1/openapi.json').expect(404);
  });
});
