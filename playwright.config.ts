import { defineConfig } from '@playwright/test';
import { loadProjectEnv } from './app/local/project-env.js';

loadProjectEnv();

export default defineConfig({
  testDir: './tests',
  // The system suite creates protected Chromium/proxy pairs; P2-2 adds a
  // headed exploration plus two fresh replays. Two workers avoid exhausting
  // local browser/socket resources while keeping independent contracts parallel.
  workers: 2,
});
