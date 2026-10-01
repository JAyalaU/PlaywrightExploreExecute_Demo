import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS !== '1') {
  console.error('Live interpretation tests require PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1.');
  process.exit(2);
}

const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'test', 'tests/deferred-action-live-interpretation.spec.ts', '--workers=1'], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) {
  console.error(`Could not start the live interpretation suite: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
