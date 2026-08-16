import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

/** Loads `.env` from the repo root once, without overriding existing process.env values. */
export function loadDotEnv(): void {
  if (loaded) {
    return;
  }

  loaded = true;
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Resolves the Redis URL for integration tests (`.env` REDIS_URL when USER_REDIS=true). */
export function resolveTestRedisUrl(): string | undefined {
  loadDotEnv();

  if (process.env.USER_REDIS === 'true' && process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }

  return undefined;
}
