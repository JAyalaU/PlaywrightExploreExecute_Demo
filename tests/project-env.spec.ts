import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProjectEnv } from '../app/local/project-env.js';

test('local dotenv loads defaults without replacing the launch environment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-env-'));
  const file = path.join(root, '.env');
  const first = process.env.PLAYWRIGHT_DEMO_ENV_TEST_FIRST;
  const second = process.env.PLAYWRIGHT_DEMO_ENV_TEST_SECOND;
  try {
    await writeFile(file, 'PLAYWRIGHT_DEMO_ENV_TEST_FIRST=from-file\nPLAYWRIGHT_DEMO_ENV_TEST_SECOND=from-file\n');
    delete process.env.PLAYWRIGHT_DEMO_ENV_TEST_FIRST;
    process.env.PLAYWRIGHT_DEMO_ENV_TEST_SECOND = 'from-launch';
    loadProjectEnv(file);
    expect(process.env.PLAYWRIGHT_DEMO_ENV_TEST_FIRST).toBe('from-file');
    expect(process.env.PLAYWRIGHT_DEMO_ENV_TEST_SECOND).toBe('from-launch');
  } finally {
    if (first === undefined) delete process.env.PLAYWRIGHT_DEMO_ENV_TEST_FIRST;
    else process.env.PLAYWRIGHT_DEMO_ENV_TEST_FIRST = first;
    if (second === undefined) delete process.env.PLAYWRIGHT_DEMO_ENV_TEST_SECOND;
    else process.env.PLAYWRIGHT_DEMO_ENV_TEST_SECOND = second;
    await rm(root, { recursive: true, force: true });
  }
});

test('missing local dotenv is optional', () => {
  expect(() => loadProjectEnv(path.join(tmpdir(), 'playwright-demo-absent-env-file'))).not.toThrow();
});
