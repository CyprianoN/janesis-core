import { z } from 'zod';

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

export interface AppConfig {
  appEnv: AppEnv;
}

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS),
});

// Reasons are written here, never taken from Zod, because Zod messages can echo the input.
const INVALID_REASONS: Readonly<Record<string, string>> = {
  APP_ENV: `must be one of: ${APP_ENVS.join(', ')}`,
};

export function loadConfig(env: EnvSource): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const variable = String(issue.path[0] ?? 'configuration');
        const reason =
          env[variable] === undefined ? 'is required' : (INVALID_REASONS[variable] ?? 'is invalid');
        return { variable, reason };
      }),
    );
  }
  return { appEnv: result.data.APP_ENV };
}
