import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The system suite creates protected Chromium/proxy pairs. Bound parallelism
  // keeps short action-timeout regression fixtures deterministic in CI.
  workers: 4,
});
