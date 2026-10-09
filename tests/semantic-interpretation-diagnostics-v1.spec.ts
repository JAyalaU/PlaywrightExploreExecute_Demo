import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SemanticInterpretationDiagnosticsV1Store } from
  '../app/evidence/semantic-interpretation-diagnostics-v1.js';
import { parseProductTrustedConfiguration } from '../app/local/product-contracts.js';
import { runSemanticGeneralLocalWorkflowV1 } from '../app/local/semantic-general-workflow.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';

test('semantic-general interpretation rejection retains authenticated closed diagnostics privately', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-interpretation-diag-'));
  const root = 'https://example.com/';
  try {
    const config = parseProductTrustedConfiguration({
      profiles: [{ id: 'desktop', version: '1', profileSchemaVersion: '5',
        browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows',
        presentationMode: 'headless', browser: 'chromium',
        viewport: { width: 900, height: 600 }, locale: 'en-US',
        timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 2000 } } }],
      artifactRoot, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    });
    const request = { taskText: `Go to ${root}\nActivate the "Control" button.`, targetUrl: root,
      executionProfileRef: { id: 'desktop', version: '1' } };
    const response = await runSemanticGeneralLocalWorkflowV1(request, config,
      new NativeProfileCatalog(config.profiles),
      { provider: { apiKey: () => undefined } }, { semanticModels: {
        primary: { complete: async () => JSON.stringify({ response: { kind: 'extraction', steps: [
          { id: 's1', type: 'navigate', authoredText: 'Go to site', url: root, dependsOnStepId: null },
          { id: 's2', type: 'action_intent', authoredText: 'Check Control', target: {
            category: 'button', exactName: 'Control', context: null, ordinal: null,
            relation: 'unspecified', relatedStepId: null }, desiredEffect: 'set_checked',
          value: null, checkedState: null, authoredMechanic: null, dependsOnStepId: 's1' },
        ] } }) }, reviewer: { complete: async () => { throw new Error('Reviewer must not run'); } },
      } });
    expect(response).toMatchObject({ kind: 'typed_stop', context: { result: { terminal: {
      stage: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'INVALID_TEST_SPEC',
    }, cleanup: 'not_started' } } });
    expect(JSON.stringify(response)).not.toMatch(/normalizationDiagnostic|INVALID_ACTION_EFFECT_ARGUMENT|Control/);
    if (response.kind !== 'typed_stop') throw new Error('Expected interpretation stop');
    const testSpecId = response.context.result.testSpecId;
    const store = new SemanticInterpretationDiagnosticsV1Store(artifactRoot);
    const records = await store.readByCorrelation({ testSpecId });
    expect(records).toMatchObject([{ testSpecId, publicCode: 'INVALID_SOURCE_REPRESENTATION',
      diagnostic: { phase: 'spec_cross_step', predicate: 'INVALID_ACTION_EFFECT_ARGUMENT',
        stepIndex: 1, fieldFamily: 'action_argument' } }]);
    expect(JSON.stringify(records)).not.toContain('Control');
    const file = path.join(artifactRoot, 'semantic-interpretation-diagnostics-v1', `${testSpecId}.json`);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: {
      diagnostic: { predicate: string } }; authentication: string };
    envelope.data.diagnostic.predicate = 'INVALID_STEP_DEPENDENCY';
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.readByCorrelation({ testSpecId })).rejects.toThrow(
      'INVALID_SEMANTIC_INTERPRETATION_DIAGNOSTIC_AUTHENTICATION');
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
