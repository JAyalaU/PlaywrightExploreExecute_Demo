import { expect, test } from '@playwright/test';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { fixtureResetTask } from '../app/adaptive-minimal/browser-tools.js';
import { runMinimalAdaptiveAgent } from '../app/adaptive-minimal/controller.js';
import { OpenAIMinimalModel } from '../app/adaptive-minimal/model.js';
import type { MinimalTask } from '../app/adaptive-minimal/types.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { startAdaptiveFixture } from './support/adaptive-fixture.js';

test('opt-in real-model variant C gear and persistent notifications', async () => {
  test.skip(process.env.ADAPTIVE_MINIMAL_LIVE !== '1' || !process.env.OPENAI_API_KEY ||
    !process.env.ADAPTIVE_LIVE_MODEL, 'Requires explicit live opt-in, model, and credential');
  test.setTimeout(210_000);
  let browsers = 0;
  const fixture = await startAdaptiveFixture('c', () => browsers);
  const task: MinimalTask = {
    instruction: 'Open account settings using the gear icon, turn on Email notifications, and confirm they remain enabled.',
    startUrl: `${fixture.baseUrl}/`, allowedOrigins: [fixture.baseUrl], resetRef: 'fixture_reset',
    maxModelTurns: 12, maxActions: 6, maxScreenshots: 2, maxElapsedMs: 165_000 };
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_minimal_live', version: '1',
    browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} },
    profileSchemaVersion: '5', presentationMode: 'headless',
    browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  try {
    const report = await runMinimalAdaptiveAgent({ task,
      model: new OpenAIMinimalModel(process.env.OPENAI_API_KEY!, process.env.ADAPTIVE_LIVE_MODEL!),
      reset: current => fixture.reset.prepareCleanState(fixtureResetTask(current)),
      openBrowser: async () => {
        browsers++;
        const session = await factory.open({ id: 'adaptive_minimal_live', version: '1' });
        return new AdaptiveBrowser(await session.context.newPage(), () => session.close());
      } });
    // The oracle checks the harness outcome only; it never enters model or evaluator input.
    expect(report.outcome, report.explanation).toBe('PASS');
    expect(await fixture.state()).toBe(true);
    expect(report.clean?.resetProof.applicationStateVerified).toBe(true);
    expect(report.clean?.observations[0]?.sessionId).not.toBe(report.discovery.observations[0]?.sessionId);
  } finally { await fixture.close(); }
});
