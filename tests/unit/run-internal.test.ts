import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { runInternal } from '../../src/scripts/run-internal.js';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock('../../src/config/database.js', () => ({ connectDatabase: vi.fn(), disconnectDatabase: vi.fn() }));

const actualEnv = await vi.importActual<typeof import('../../src/config/env.js')>('../../src/config/env.js');
const config = actualEnv.loadConfig({ MONGODB_URI: 'mongodb://127.0.0.1:27017/test', LOG_LEVEL: 'silent',
  JWT_SECRET: 'test-signing-key-'.repeat(4), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
const originalExitCode = process.exitCode;
const privateUri = 'mongodb://private-user:private-password@example.invalid/private-database';
let output = '';

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  output = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  vi.mocked(loadConfig).mockReturnValue(config);
  vi.mocked(connectDatabase).mockResolvedValue();
  vi.mocked(disconnectDatabase).mockResolvedValue();
});
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); });

// All mocked operations settle as promises; flush the complete async command and catch.
async function settle(): Promise<void> { await new Promise<void>((resolve) => { setImmediate(resolve); }); }

it('reports actual invalid configuration variable names without rejected credentials', async () => {
  vi.mocked(loadConfig).mockImplementation(() => actualEnv.loadConfig({ MONGODB_URI: 'private-invalid-uri',
    JWT_SECRET: 'private-short-secret', TOKEN_ENCRYPTION_KEY: 'private-invalid-key' }));
  const work = vi.fn();
  runInternal(work); await settle();
  expect(output).toContain('failed during configuration: Invalid environment variables: MONGODB_URI, JWT_SECRET, TOKEN_ENCRYPTION_KEY');
  for (const secret of ['private-invalid-uri', 'private-short-secret', 'private-invalid-key']) expect(output).not.toContain(secret);
  expect(connectDatabase).not.toHaveBeenCalled(); expect(disconnectDatabase).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it('reports exact HTTPS origin guidance without printing the supplied origin', async () => {
  vi.mocked(loadConfig).mockImplementation(() => actualEnv.loadConfig({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'mongo',
    MONGODB_URI: privateUri, JWT_SECRET: 'test-signing-key-'.repeat(4), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    CORS_ORIGINS: 'http://private-frontend.invalid', CREDENTIAL_UI_ORIGIN: 'http://private-frontend.invalid' }));
  runInternal(vi.fn()); await settle();
  expect(output).toContain('failed during configuration: CORS_ORIGINS must contain exact HTTP(S) origins; production requires HTTPS except http://localhost:5173');
  expect(output).not.toContain('private-frontend'); expect(output).not.toContain(privateUri);
  expect(process.exitCode).toBe(1);
});

it.each([
  [{ code: 18 }, 'authentication failed (code 18)'],
  [{ code: 'ENOTFOUND' }, 'Database DNS lookup failed'],
  [{ name: 'MongoParseError' }, 'connection settings could not be parsed'],
  [{ name: 'MongooseServerSelectionError' }, 'No MongoDB server could be selected'],
])('classifies database errors using fixed guidance only: %j', async (properties, guidance) => {
  vi.mocked(connectDatabase).mockRejectedValue(Object.assign(new Error(privateUri), properties));
  const work = vi.fn();
  runInternal(work); await settle();
  expect(output).toContain('failed during database:'); expect(output).toContain(guidance);
  expect(output).not.toContain(privateUri); expect(output).not.toContain('private-password');
  expect(work).not.toHaveBeenCalled(); expect(disconnectDatabase).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
});

it('identifies missing production replica set support without arbitrary error output', async () => {
  vi.mocked(connectDatabase).mockRejectedValue(new Error('Production requires transaction-capable MongoDB'));
  runInternal(vi.fn()); await settle();
  expect(output).toContain('failed during database: Production requires transaction-capable MongoDB. Use a replica set or sharded cluster.');
  expect(process.exitCode).toBe(1);
});

it('identifies command authorization failures and disconnects', async () => {
  const work = vi.fn().mockRejectedValue(Object.assign(new Error(privateUri), { code: 13 }));
  runInternal(work); await settle();
  expect(output).toContain('failed during command: MongoDB authorization denied (code 13)');
  expect(output).not.toContain(privateUri); expect(work).toHaveBeenCalledWith(config);
  expect(disconnectDatabase).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
});

it.each([
  Object.assign(new Error(privateUri), { name: 'private-driver-secret', code: 999999 }),
  { message: privateUri, stack: 'private-stack-secret', name: 'private-name-secret', code: 'private-code-secret' },
  new ConfigurationError('private-untrusted-command-message'),
  undefined,
])('keeps unknown command failures generic: %#', async (error) => {
  runInternal(vi.fn().mockRejectedValue(error)); await settle();
  expect(output).toBe('Internal command failed during command: Check configuration, database state and command prerequisites; no credentials were printed.\n');
  expect(disconnectDatabase).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
});

it('runs successful work, disconnects and keeps a successful exit status', async () => {
  const work = vi.fn().mockResolvedValue(undefined);
  runInternal(work); await settle();
  expect(work).toHaveBeenCalledWith(config); expect(disconnectDatabase).toHaveBeenCalledOnce();
  expect(output).toBe(''); expect(process.exitCode).toBeUndefined();
});

it('preserves a failing exit status supplied by a completed preflight', async () => {
  runInternal(() => { process.exitCode = 1; return Promise.resolve(); }); await settle();
  expect(disconnectDatabase).toHaveBeenCalledOnce(); expect(output).toBe(''); expect(process.exitCode).toBe(1);
});

it.each(['database', 'command'] as const)('preserves the primary %s failure when cleanup also fails', async (stage) => {
  const primary = Object.assign(new Error(privateUri), { code: 18 });
  const work = vi.fn().mockResolvedValue(undefined);
  if (stage === 'database') vi.mocked(connectDatabase).mockRejectedValue(primary);
  else work.mockRejectedValue(primary);
  vi.mocked(disconnectDatabase).mockRejectedValue(new Error('private-cleanup-secret'));
  runInternal(work); await settle();
  expect(output).toContain('cleanup also failed'); expect(output).toContain(`failed during ${stage}: MongoDB authentication failed (code 18)`);
  expect(output).not.toContain(privateUri); expect(output).not.toContain('private-cleanup-secret'); expect(process.exitCode).toBe(1);
});

it('fails during cleanup when successful work cannot disconnect', async () => {
  vi.mocked(disconnectDatabase).mockRejectedValue(new Error('private-cleanup-secret'));
  runInternal(vi.fn().mockResolvedValue(undefined)); await settle();
  expect(output).toContain('failed during cleanup: Check configuration, database state and command prerequisites');
  expect(output).not.toContain('private-cleanup-secret'); expect(process.exitCode).toBe(1);
});
