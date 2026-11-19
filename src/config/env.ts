import { z } from 'zod';
import {
  DB_CONNECTION_TIMEOUT_MS_BOUNDS,
  DB_IDLE_TIMEOUT_MS_BOUNDS,
  DB_POOL_MAX_BOUNDS,
  type DatabasePoolConfig,
} from './database.js';

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export interface ConfigIssue {
  variable: string;
  reason: string;
}

/** Names the invalid variables and why. It never carries a supplied value. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.variable} ${i.reason}`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

// Provider groups (Phase 5, Decision 2). A group is either completely unset or completely set.
export const PROVIDER_VARIABLES = {
  clerk: ['CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SECRET'],
  database: ['DATABASE_URL'],
  redis: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  qstash: ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'],
  r2: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'],
  thirdweb: ['THIRDWEB_SECRET_KEY', 'THIRDWEB_WEBHOOK_SECRET'],
  alchemy: ['ALCHEMY_API_KEY'],
  sentry: ['SENTRY_DSN'],
  posthog: ['POSTHOG_API_KEY', 'POSTHOG_HOST'],
  turnstile: ['TURNSTILE_SECRET_KEY'],
  x: ['X_BEARER_TOKEN'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
} as const;

export type ProviderName = keyof typeof PROVIDER_VARIABLES;

/** true means the provider must be fully configured in staging and production. */
export type RequirementPolicy = Readonly<Record<ProviderName, boolean>>;

/**
 * The requirement policy. Every provider stays optional until the phase that first consumes it.
 * database is required in staging and production from Phase 7 (Technical Lead, E1).
 * That phase flips its own flag here and adds missing-credential and valid-credential tests.
 *
 * Recorded at Phase 5 Gate C (Tech Lead, 31 Oct 2026): x activates in Phase 18 and telegram in
 * Phase 20. sentry, posthog and turnstile stay optional until their consuming phases and
 * credential requirements are formally assigned; no speculative requirements are added.
 */
export const PROVIDER_REQUIREMENTS: RequirementPolicy = {
  clerk: false,
  database: true,
  redis: false,
  qstash: false,
  r2: false,
  thirdweb: false,
  alchemy: false,
  sentry: false,
  posthog: false,
  turnstile: false,
  x: false,
  telegram: false,
};

export interface ProviderValues {
  clerk: { secretKey: string; webhookSecret: string };
  database: { url: string };
  redis: { restUrl: string; restToken: string };
  qstash: { token: string; currentSigningKey: string; nextSigningKey: string };
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  thirdweb: { secretKey: string; webhookSecret: string };
  alchemy: { apiKey: string };
  sentry: { dsn: string };
  posthog: { apiKey: string; host: string };
  turnstile: { secretKey: string };
  x: { bearerToken: string };
  telegram: { botToken: string; webhookSecret: string };
}

export type ProviderConfig = { [P in ProviderName]?: ProviderValues[P] };

export interface AppConfig {
  appEnv: AppEnv;
  port: number;
  shutdownTimeoutMs: number;
  providers: ProviderConfig;
  databasePool: DatabasePoolConfig;
}

type FieldKind = 'text' | 'postgres-url' | 'https-url' | 'web-url';

const KINDS: Readonly<Record<FieldKind, { protocols: readonly string[] | null; reason: string }>> =
  {
    text: {
      protocols: null,
      reason: 'must be a non-empty value without leading or trailing whitespace',
    },
    'postgres-url': {
      protocols: ['postgres:', 'postgresql:'],
      reason: 'must be a postgres:// or postgresql:// URL without surrounding whitespace',
    },
    'https-url': {
      protocols: ['https:'],
      reason: 'must be an https:// URL without surrounding whitespace',
    },
    'web-url': {
      protocols: ['http:', 'https:'],
      reason: 'must be an http:// or https:// URL without surrounding whitespace',
    },
  };

interface Field {
  key: string;
  kind: FieldKind;
}

const FIELDS: Readonly<Record<string, Field>> = {
  CLERK_SECRET_KEY: { key: 'secretKey', kind: 'text' },
  CLERK_WEBHOOK_SECRET: { key: 'webhookSecret', kind: 'text' },
  DATABASE_URL: { key: 'url', kind: 'postgres-url' },
  UPSTASH_REDIS_REST_URL: { key: 'restUrl', kind: 'https-url' },
  UPSTASH_REDIS_REST_TOKEN: { key: 'restToken', kind: 'text' },
  QSTASH_TOKEN: { key: 'token', kind: 'text' },
  QSTASH_CURRENT_SIGNING_KEY: { key: 'currentSigningKey', kind: 'text' },
  QSTASH_NEXT_SIGNING_KEY: { key: 'nextSigningKey', kind: 'text' },
  R2_ACCOUNT_ID: { key: 'accountId', kind: 'text' },
  R2_ACCESS_KEY_ID: { key: 'accessKeyId', kind: 'text' },
  R2_SECRET_ACCESS_KEY: { key: 'secretAccessKey', kind: 'text' },
  R2_BUCKET: { key: 'bucket', kind: 'text' },
  THIRDWEB_SECRET_KEY: { key: 'secretKey', kind: 'text' },
  THIRDWEB_WEBHOOK_SECRET: { key: 'webhookSecret', kind: 'text' },
  ALCHEMY_API_KEY: { key: 'apiKey', kind: 'text' },
  SENTRY_DSN: { key: 'dsn', kind: 'web-url' },
  POSTHOG_API_KEY: { key: 'apiKey', kind: 'text' },
  POSTHOG_HOST: { key: 'host', kind: 'web-url' },
  TURNSTILE_SECRET_KEY: { key: 'secretKey', kind: 'text' },
  X_BEARER_TOKEN: { key: 'bearerToken', kind: 'text' },
  TELEGRAM_BOT_TOKEN: { key: 'botToken', kind: 'text' },
  TELEGRAM_WEBHOOK_SECRET: { key: 'webhookSecret', kind: 'text' },
};

function isValid(kind: FieldKind, value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  const { protocols } = KINDS[kind];
  if (protocols === null) return true;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function loadProviders(
  env: EnvSource,
  appEnv: AppEnv | undefined,
  policy: RequirementPolicy,
  addIssue: (variable: string, reason: string) => void,
): ProviderConfig {
  const providers: Record<string, Record<string, string>> = {};
  for (const provider of Object.keys(PROVIDER_VARIABLES) as ProviderName[]) {
    const names: readonly string[] = PROVIDER_VARIABLES[provider];
    if (!names.some((name) => env[name] !== undefined)) {
      if (policy[provider] && (appEnv === 'staging' || appEnv === 'production')) {
        for (const name of names) addIssue(name, 'is required in staging and production');
      }
      continue;
    }
    const values: Record<string, string> = {};
    let complete = true;
    for (const name of names) {
      const value = env[name];
      const field = FIELDS[name];
      if (value === undefined) {
        complete = false;
        addIssue(name, `is required because other ${provider} variables are set`);
      } else if (field === undefined || !isValid(field.kind, value)) {
        complete = false;
        addIssue(name, KINDS[field?.kind ?? 'text'].reason);
      } else {
        values[field.key] = value;
      }
    }
    if (complete) providers[provider] = values;
  }
  // The shape of each group follows the FIELDS table; the typed-values tests cover it.
  return providers as unknown as ProviderConfig;
}

// Documented defaults. 8080 is Cloud Run's default port; 8000 ms stays below its 10 s termination window.
const DEFAULT_PORT = '8080';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = '8000';

// Digits only: rejects '', ' 8080', '80.5', '1e3', '0x1F90' and signs instead of normalizing them.
const digits = z.string().regex(/^\d+$/);

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  PORT: digits.transform(Number).pipe(z.number().int().min(1).max(65535)),
  SHUTDOWN_TIMEOUT_MS: digits.transform(Number).pipe(z.number().int().min(1)),
  DB_POOL_MAX: digits
    .transform(Number)
    .pipe(z.number().int().min(DB_POOL_MAX_BOUNDS.min).max(DB_POOL_MAX_BOUNDS.max)),
  DB_IDLE_TIMEOUT_MS: digits
    .transform(Number)
    .pipe(z.number().int().min(DB_IDLE_TIMEOUT_MS_BOUNDS.min).max(DB_IDLE_TIMEOUT_MS_BOUNDS.max)),
  DB_CONNECTION_TIMEOUT_MS: digits
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(DB_CONNECTION_TIMEOUT_MS_BOUNDS.min)
        .max(DB_CONNECTION_TIMEOUT_MS_BOUNDS.max),
    ),
});

/** The core variables the schema reads. Derived from the schema, so it cannot drift from it. */
export const CORE_VARIABLES = Object.keys(schema.shape) as Array<keyof typeof schema.shape>;

// Reasons are written here, never taken from Zod, because Zod messages can echo the input.
const INVALID_REASONS: Readonly<Record<string, string>> = {
  APP_ENV: `must be one of: ${APP_ENVS.join(', ')}`,
  PORT: 'must be an integer from 1 to 65535',
  SHUTDOWN_TIMEOUT_MS: 'must be a positive integer number of milliseconds',
  DB_POOL_MAX: `must be an integer from ${DB_POOL_MAX_BOUNDS.min} to ${DB_POOL_MAX_BOUNDS.max}`,
  DB_IDLE_TIMEOUT_MS: `must be an integer from ${DB_IDLE_TIMEOUT_MS_BOUNDS.min} to ${DB_IDLE_TIMEOUT_MS_BOUNDS.max} milliseconds`,
  DB_CONNECTION_TIMEOUT_MS: `must be an integer from ${DB_CONNECTION_TIMEOUT_MS_BOUNDS.min} to ${DB_CONNECTION_TIMEOUT_MS_BOUNDS.max} milliseconds`,
};

export function loadConfig(
  env: EnvSource = process.env,
  policy: RequirementPolicy = PROVIDER_REQUIREMENTS,
): AppConfig {
  const issues = new Map<string, ConfigIssue>();
  const addIssue = (variable: string, reason: string): void => {
    if (!issues.has(variable)) issues.set(variable, { variable, reason });
  };

  const result = schema.safeParse({
    APP_ENV: env['APP_ENV'],
    PORT: env['PORT'] ?? DEFAULT_PORT,
    SHUTDOWN_TIMEOUT_MS: env['SHUTDOWN_TIMEOUT_MS'] ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    DB_POOL_MAX: env['DB_POOL_MAX'] ?? String(DB_POOL_MAX_BOUNDS.default),
    DB_IDLE_TIMEOUT_MS: env['DB_IDLE_TIMEOUT_MS'] ?? String(DB_IDLE_TIMEOUT_MS_BOUNDS.default),
    DB_CONNECTION_TIMEOUT_MS:
      env['DB_CONNECTION_TIMEOUT_MS'] ?? String(DB_CONNECTION_TIMEOUT_MS_BOUNDS.default),
  });
  if (!result.success) {
    for (const issue of result.error.issues) {
      const variable = String(issue.path[0] ?? 'configuration');
      addIssue(
        variable,
        env[variable] === undefined ? 'is required' : (INVALID_REASONS[variable] ?? 'is invalid'),
      );
    }
  }

  const providers = loadProviders(
    env,
    result.success ? result.data.APP_ENV : undefined,
    policy,
    addIssue,
  );

  if (!result.success || issues.size > 0) {
    throw new ConfigError([...issues.values()]);
  }

  const { APP_ENV, PORT, SHUTDOWN_TIMEOUT_MS } = result.data;
  return {
    appEnv: APP_ENV,
    port: PORT,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    providers,
    databasePool: {
      max: result.data.DB_POOL_MAX,
      idleTimeoutMs: result.data.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: result.data.DB_CONNECTION_TIMEOUT_MS,
    },
  };
}

export interface ConfigSummary {
  appEnv: AppEnv;
  port: number;
  shutdownTimeoutMs: number;
  providers: Record<string, 'configured' | 'not configured'>;
}

/**
 * A redacted summary that is safe to log. Provider values are never included, not even URLs,
 * because a URL can carry credentials. Each provider shows only whether its group is configured.
 */
export function describeConfig(config: AppConfig): ConfigSummary {
  const providers: Record<string, 'configured' | 'not configured'> = {};
  for (const name of Object.keys(PROVIDER_VARIABLES) as ProviderName[]) {
    providers[name] = config.providers[name] === undefined ? 'not configured' : 'configured';
  }
  return {
    appEnv: config.appEnv,
    port: config.port,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    providers,
  };
}
