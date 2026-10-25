import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/test', JWT_SECRET: 'test-signing-key-'.repeat(4), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) };

describe('environment validation', () => {
  it('converts numbers and booleans with secure defaults', () => {
    const config = loadConfig({ ...base, PORT: '3100', DOCS_ENABLED: 'false' });
    expect(config.port).toBe(3100);
    expect(config.docsEnabled).toBe(false);
    expect(config.trustProxyHops).toBe(0);
    expect(config.credentialDeliveryEnabled).toBe(true);
    expect(config.credentialDeliveryIntervalMs).toBe(5000);
    expect(config.commercialJobsEnabled).toBe(false);
    expect(config.commercialJobsIntervalMs).toBe(5000);
  });
  it('validates automatic commercial processing settings', () => {
    const config = loadConfig({ ...base, COMMERCIAL_JOBS_ENABLED: 'true', COMMERCIAL_JOBS_INTERVAL_MS: '2000' });
    expect(config.commercialJobsEnabled).toBe(true); expect(config.commercialJobsIntervalMs).toBe(2000);
    expect(() => loadConfig({ ...base, COMMERCIAL_JOBS_INTERVAL_MS: '0' })).toThrow();
    expect(() => loadConfig({ ...base, COMMERCIAL_JOBS_ENABLED: 'maybe' })).toThrow();
  });
  it('allows disabling the embedded worker and empty optional SMTP settings', () => {
    const config = loadConfig({ ...base, CREDENTIAL_DELIVERY_ENABLED: 'false', SMTP_HOST: '', MAIL_FROM: '', SMTP_USER: '', SMTP_PASSWORD: '' });
    expect(config.credentialDeliveryEnabled).toBe(false);
    expect(config.smtpHost).toBeUndefined();
    expect(() => loadConfig({ ...base, CREDENTIAL_DELIVERY_INTERVAL_MS: '0' })).toThrow();
    expect(() => loadConfig({ ...base, CREDENTIAL_DELIVERY_INTERVAL_MS: '60001' })).toThrow();
  });
  it.each([
    { MONGODB_URI: '' }, { MONGODB_URI: 'https://not-mongo' }, { PORT: '0' },
    { RATE_LIMIT_MAX: '-1' }, { DOCS_ENABLED: 'maybe' }, { BODY_LIMIT_BYTES: '2000000' },
    { TRUST_PROXY_HOPS: 'true' }, { REDIS_URL: 'https://bad' }, { AWS_REGION: 'invalid' },
  ])('rejects invalid settings %j', (settings) => {
    expect(() => loadConfig({ ...base, ...settings })).toThrow();
  });
  it.each(['*', 'https://app.example/path', 'https://user:pass@app.example', 'null', 'http://localhost:5173,'])('rejects unsafe origin %s', (origin) => {
    expect(() => loadConfig({ ...base, CORS_ORIGINS: origin })).toThrow();
  });
  it('requires HTTPS origins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow();
    expect(loadConfig({ ...base, NODE_ENV: 'production', RATE_LIMIT_STORE: 'mongo', CORS_ORIGINS: 'https://app.example', CREDENTIAL_UI_ORIGIN: 'https://app.example' }).docsEnabled).toBe(false);
  });
  it('forbids public production docs', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example', DOCS_ENABLED: 'true' })).toThrow();
  });
  it('does not leak rejected secret values', () => {
    expect(() => loadConfig({ ...base, MONGODB_URI: 'secret-password-123' })).toThrow('Invalid environment variables: MONGODB_URI');
  });
  it('requires independent signing and credential-delivery keys', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: '' })).toThrow();
    expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: '' })).toThrow();
    expect(() => loadConfig({ ...base, JWT_SECRET: base.TOKEN_ENCRYPTION_KEY })).toThrow('independent');
  });
  it('rejects inconsistent lifetime, delivery origin and SMTP settings', () => {
    expect(() => loadConfig({ ...base, REFRESH_TTL_DAYS: '7', REFRESH_ABSOLUTE_DAYS: '1' })).toThrow();
    expect(() => loadConfig({ ...base, CREDENTIAL_UI_ORIGIN: 'https://attacker.invalid' })).toThrow();
    expect(() => loadConfig({ ...base, SMTP_USER: 'mail-user' })).toThrow();
    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.invalid' })).toThrow();
  });
  it('requires paired private photo storage configuration', () => {
    expect(() => loadConfig({ ...base, AWS_REGION: 'ap-south-1' })).toThrow('configured together');
    expect(() => loadConfig({ ...base, S3_BUCKET: 'private-photos' })).toThrow('configured together');
    expect(loadConfig({ ...base, AWS_REGION: 'ap-south-1', S3_BUCKET: 'private-photos' }).s3Bucket).toBe('private-photos');
  });
  it('requires shared protection in production and bounds pool/monitoring settings', () => {
    const production = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example', CREDENTIAL_UI_ORIGIN: 'https://app.example' };
    expect(() => loadConfig(production)).toThrow('RATE_LIMIT_STORE=mongo');
    expect(loadConfig({ ...production, RATE_LIMIT_STORE: 'mongo' }).rateLimitStore).toBe('mongo');
    expect(() => loadConfig({ ...base, MONGODB_WAIT_QUEUE_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadConfig({ ...base, SLOW_QUERY_MS: '0' })).toThrow();
  });
});
