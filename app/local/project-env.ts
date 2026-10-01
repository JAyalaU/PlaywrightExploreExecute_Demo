import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Load operator-owned local defaults; an existing launch environment always wins. */
export function loadProjectEnv(file = fileURLToPath(new URL('../../.env', import.meta.url))): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
