import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config/env.js';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/sunvika-test', LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-signing-key-'.repeat(4), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  ...overrides,
});

export function testApp(overrides: Partial<AppConfig> = {}, isDatabaseReady = () => Promise.resolve(true)) {
  const config = testConfig(overrides);
  return createApp(config, { logger: createLogger(config), isDatabaseReady });
}
