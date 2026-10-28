import Joi from 'joi';

// Messages contain only fixed guidance or schema variable names, never supplied values.
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  mongodbUri: string;
  mongoMaxPoolSize: number;
  mongoServerSelectionTimeoutMs: number;
  corsOrigins: string[];
  trustProxyHops: number;
  bodyLimitBytes: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitStore: 'memory' | 'mongo';
  mongoWaitQueueTimeoutMs: number;
  slowQueryMs: number;
  docsEnabled: boolean;
  shutdownTimeoutMs: number;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  refreshAbsoluteDays: number;
  tokenEncryptionKey: string;
  credentialUiOrigin: string;
  credentialDeliveryEnabled: boolean;
  credentialDeliveryIntervalMs: number;
  commercialJobsEnabled: boolean;
  commercialJobsIntervalMs: number;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  mailFrom?: string;
  awsRegion?: string;
  s3Bucket?: string;
  redisUrl?: string;
}

const schema = Joi.object<Environment>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  HOST: Joi.string().hostname().default('0.0.0.0'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  MONGODB_URI: Joi.string().pattern(/^mongodb(?:\+srv)?:\/\//).required(),
  MONGODB_MAX_POOL_SIZE: Joi.number().integer().min(1).max(200).default(20),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: Joi.number().integer().min(100).max(30000).default(5000),
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),
  BODY_LIMIT_BYTES: Joi.number().integer().min(1024).max(1048576).default(102400),
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).max(3600000).default(60000),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).max(100000).default(100),
  RATE_LIMIT_STORE: Joi.string().valid('memory', 'mongo').default('memory'),
  MONGODB_WAIT_QUEUE_TIMEOUT_MS: Joi.number().integer().min(100).max(10000).default(2000),
  SLOW_QUERY_MS: Joi.number().integer().min(100).max(30000).default(1000),
  DOCS_ENABLED: Joi.boolean().default(false),
  SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(10000),
  JWT_SECRET: Joi.string().min(48).max(512).required(),
  JWT_ISSUER: Joi.string().max(100).default('sunvika-office-api'),
  JWT_AUDIENCE: Joi.string().max(100).default('sunvika-office-web'),
  ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(900).default(600),
  REFRESH_TTL_DAYS: Joi.number().integer().min(1).max(14).default(7),
  REFRESH_ABSOLUTE_DAYS: Joi.number().integer().min(1).max(90).default(30),
  TOKEN_ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  CREDENTIAL_UI_ORIGIN: Joi.string().default('http://localhost:5173'),
  CREDENTIAL_DELIVERY_ENABLED: Joi.boolean().default(true),
  CREDENTIAL_DELIVERY_INTERVAL_MS: Joi.number().integer().min(1000).max(60000).default(5000),
  COMMERCIAL_JOBS_ENABLED: Joi.boolean().default(false),
  COMMERCIAL_JOBS_INTERVAL_MS: Joi.number().integer().min(1000).max(60000).default(5000),
  SMTP_HOST: Joi.string().hostname().empty(''), SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
  SMTP_SECURE: Joi.boolean().default(false), SMTP_USER: Joi.string().max(254).empty(''),
  SMTP_PASSWORD: Joi.string().max(500).empty(''), MAIL_FROM: Joi.string().email().empty(''),
  AWS_REGION: Joi.string().pattern(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  S3_BUCKET: Joi.string().pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }),
}).unknown(true);

interface Environment {
  NODE_ENV: AppConfig['nodeEnv']; HOST: string; PORT: number; LOG_LEVEL: AppConfig['logLevel'];
  MONGODB_URI: string; MONGODB_MAX_POOL_SIZE: number; MONGODB_SERVER_SELECTION_TIMEOUT_MS: number;
  CORS_ORIGINS: string; TRUST_PROXY_HOPS: number; BODY_LIMIT_BYTES: number;
  RATE_LIMIT_WINDOW_MS: number; RATE_LIMIT_MAX: number; DOCS_ENABLED: boolean; SHUTDOWN_TIMEOUT_MS: number;
  RATE_LIMIT_STORE: AppConfig['rateLimitStore']; MONGODB_WAIT_QUEUE_TIMEOUT_MS: number; SLOW_QUERY_MS: number;
  JWT_SECRET: string; JWT_ISSUER: string; JWT_AUDIENCE: string; ACCESS_TTL_SECONDS: number;
  REFRESH_TTL_DAYS: number; REFRESH_ABSOLUTE_DAYS: number; TOKEN_ENCRYPTION_KEY: string;
  CREDENTIAL_UI_ORIGIN: string; SMTP_HOST?: string; SMTP_PORT: number; SMTP_SECURE: boolean;
  CREDENTIAL_DELIVERY_ENABLED: boolean; CREDENTIAL_DELIVERY_INTERVAL_MS: number;
  COMMERCIAL_JOBS_ENABLED: boolean; COMMERCIAL_JOBS_INTERVAL_MS: number;
  SMTP_USER?: string; SMTP_PASSWORD?: string; MAIL_FROM?: string;
  AWS_REGION?: string; S3_BUCKET?: string; REDIS_URL?: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.validate(environment, { abortEarly: false });
  if (result.error) {
    // Joi messages can contain credentials; report only offending variable names.
    throw new ConfigurationError(`Invalid environment variables: ${result.error.details.map((detail) => detail.path.join('.')).join(', ')}`);
  }
  const value = result.value;
  const corsOrigins = value.CORS_ORIGINS.split(',').map((origin) => origin.trim());
  if (corsOrigins.some((origin) => {
    try {
      const url = new URL(origin);
      return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
        (value.NODE_ENV === 'production' && url.protocol !== 'https:' && origin !== 'http://localhost:5173');
    } catch { return true; }
  })) throw new ConfigurationError('CORS_ORIGINS must contain exact HTTP(S) origins; production requires HTTPS except http://localhost:5173');
  if (value.NODE_ENV === 'production' && value.DOCS_ENABLED) {
    throw new ConfigurationError('Public API documentation must be disabled in production');
  }
  if (value.NODE_ENV === 'production' && value.RATE_LIMIT_STORE !== 'mongo') {
    throw new ConfigurationError('Production requires RATE_LIMIT_STORE=mongo for shared request protection');
  }
  if (!corsOrigins.includes(value.CREDENTIAL_UI_ORIGIN)) throw new ConfigurationError('CREDENTIAL_UI_ORIGIN must be an allowed CORS origin');
  if (value.REFRESH_TTL_DAYS > value.REFRESH_ABSOLUTE_DAYS) throw new ConfigurationError('Refresh sliding lifetime exceeds absolute lifetime');
  if (value.JWT_SECRET === value.TOKEN_ENCRYPTION_KEY) throw new ConfigurationError('Use independent signing and encryption keys');
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) throw new ConfigurationError('SMTP credentials must be configured together');
  if (value.SMTP_HOST && !value.MAIL_FROM) throw new ConfigurationError('MAIL_FROM is required with SMTP_HOST');
  if (Boolean(value.AWS_REGION) !== Boolean(value.S3_BUCKET)) throw new ConfigurationError('AWS_REGION and S3_BUCKET must be configured together');
  return {
    nodeEnv: value.NODE_ENV, host: value.HOST, port: value.PORT, logLevel: value.LOG_LEVEL,
    mongodbUri: value.MONGODB_URI, mongoMaxPoolSize: value.MONGODB_MAX_POOL_SIZE,
    mongoServerSelectionTimeoutMs: value.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    corsOrigins: [...new Set(corsOrigins)], trustProxyHops: value.TRUST_PROXY_HOPS,
    bodyLimitBytes: value.BODY_LIMIT_BYTES, rateLimitWindowMs: value.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: value.RATE_LIMIT_MAX, docsEnabled: value.DOCS_ENABLED,
    rateLimitStore: value.RATE_LIMIT_STORE, mongoWaitQueueTimeoutMs: value.MONGODB_WAIT_QUEUE_TIMEOUT_MS,
    slowQueryMs: value.SLOW_QUERY_MS,
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    jwtSecret: value.JWT_SECRET, jwtIssuer: value.JWT_ISSUER, jwtAudience: value.JWT_AUDIENCE,
    accessTtlSeconds: value.ACCESS_TTL_SECONDS, refreshTtlDays: value.REFRESH_TTL_DAYS,
    refreshAbsoluteDays: value.REFRESH_ABSOLUTE_DAYS, tokenEncryptionKey: value.TOKEN_ENCRYPTION_KEY,
    credentialUiOrigin: value.CREDENTIAL_UI_ORIGIN, smtpPort: value.SMTP_PORT, smtpSecure: value.SMTP_SECURE,
    credentialDeliveryEnabled: value.CREDENTIAL_DELIVERY_ENABLED,
    commercialJobsEnabled: value.COMMERCIAL_JOBS_ENABLED, commercialJobsIntervalMs: value.COMMERCIAL_JOBS_INTERVAL_MS,
    credentialDeliveryIntervalMs: value.CREDENTIAL_DELIVERY_INTERVAL_MS,
    ...(value.SMTP_HOST ? { smtpHost: value.SMTP_HOST } : {}),
    ...(value.SMTP_USER ? { smtpUser: value.SMTP_USER } : {}),
    ...(value.SMTP_PASSWORD ? { smtpPassword: value.SMTP_PASSWORD } : {}),
    ...(value.MAIL_FROM ? { mailFrom: value.MAIL_FROM } : {}),
    ...(value.AWS_REGION ? { awsRegion: value.AWS_REGION } : {}),
    ...(value.S3_BUCKET ? { s3Bucket: value.S3_BUCKET } : {}),
    ...(value.REDIS_URL ? { redisUrl: value.REDIS_URL } : {}),
  };
}
