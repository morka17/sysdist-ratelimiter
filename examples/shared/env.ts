import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let loaded = false;

/** Loads `.env` from the repo root (and cwd) without overriding existing env vars. */
export function loadDotEnv(): void {
  if (loaded) {
    return;
  }

  loaded = true;

  for (const envPath of [resolve(repoRoot, '.env'), resolve(process.cwd(), '.env')]) {
    if (!existsSync(envPath)) {
      continue;
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
}

export function getPort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new RangeError(`Invalid PORT: ${raw}`);
  }
  return port;
}

export function useRedis(): boolean {
  return process.env.USER_REDIS === 'true' && Boolean(process.env.REDIS_URL);
}

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is required when USER_REDIS=true');
  }
  return url;
}

export function getRateLimitPoints(): number {
  return Number(process.env.RATE_LIMIT_POINTS ?? 100);
}

export function getRateLimitDuration(): number {
  return Number(process.env.RATE_LIMIT_DURATION ?? 60);
}
