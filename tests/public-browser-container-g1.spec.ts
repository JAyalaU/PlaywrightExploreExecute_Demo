import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('G1 browser container declares a mountless internal-only compartment', async () => {
  const compose = await readFile(new URL('infra/public-browser/compose.yaml', root), 'utf8');
  expect(compose).toContain('read_only: true');
  expect(compose).toContain('cap_drop:');
  expect(compose).toContain('no-new-privileges:true');
  expect(compose).toContain('internal: true');
  expect(compose).not.toMatch(/^\s*volumes:/m);
  expect(compose).not.toContain('OPENAI_API_KEY');
  expect(compose).not.toMatch(/^\s*ports:/m);
});

test('G1 browser image uses ordinary networking without destination proxy', async () => {
  const entrypoint = await readFile(new URL('infra/public-browser/entrypoint.sh', root), 'utf8');
  expect(entrypoint).toContain("*/chrome-linux64/chrome");
  expect(entrypoint).toContain("*/chrome-linux/chrome");
  expect(entrypoint).not.toContain('PUBLIC_BROWSER_PROXY');
  expect(entrypoint).not.toContain('--proxy-server=');
});
