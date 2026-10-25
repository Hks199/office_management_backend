import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

function runServer(overrides: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', DOCS_ENABLED: 'false',
        JWT_SECRET: 'test-signing-key-'.repeat(4), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
        DOTENV_CONFIG_PATH: '.env.does-not-exist', CORS_ORIGINS: 'http://localhost:5173', ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Server did not fail closed within its startup deadline'));
    }, 15000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timeout); resolve({ exitCode, output }); });
  });
}

it('rejects invalid startup configuration without logging secrets', async () => {
  const result = await runServer({ MONGODB_URI: 'invalid-private-startup-secret' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Startup failed');
  expect(result.output).not.toContain('invalid-private-startup-secret');
  expect(result.output).not.toContain('API listening');
}, 20000);

it('fails before HTTP binding when MongoDB is unavailable without logging URI credentials', async () => {
  const result = await runServer({ MONGODB_URI: 'mongodb://user:private-mongo-secret@127.0.0.1:1/test',
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '100' });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Startup failed');
  expect(result.output).not.toContain('private-mongo-secret');
  expect(result.output).not.toContain('API listening');
}, 20000);

it('refuses a standalone production database before HTTP binding', async () => {
  const mongo = await MongoMemoryServer.create();
  try {
    const result = await runServer({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'mongo', MONGODB_URI: mongo.getUri('standalone'),
      CORS_ORIGINS: 'https://app.example.invalid', CREDENTIAL_UI_ORIGIN: 'https://app.example.invalid' });
    expect(result.exitCode).toBe(1); expect(result.output).toContain('Startup failed'); expect(result.output).not.toContain('API listening');
  } finally { await mongo.stop(); }
}, 30000);
