import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function loadLuaScript(filename: string): string {
  return readFileSync(join(moduleDir, filename), 'utf8');
}
