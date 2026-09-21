const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './replay-tests',
  fullyParallel: false,
  workers: 1,
  outputDir: 'artifacts/replays/test-results',
  reporter: [['list'], ['json', { outputFile: 'artifacts/replays/playwright-report.json' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure'
  }
});
