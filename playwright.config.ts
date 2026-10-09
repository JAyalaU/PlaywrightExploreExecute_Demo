import { defineConfig } from '@playwright/test';
import { loadProjectEnv } from './app/local/project-env.js';

loadProjectEnv();

export default defineConfig({
  testDir: './tests',
  // Local semantic tests create fresh Chromium sessions for grounding,
  // compilation, and replay. Two workers bound browser/socket use.
  workers: 2,
});
