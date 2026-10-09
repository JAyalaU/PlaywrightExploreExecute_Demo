import { test, expect } from '@playwright/test';
import { authoredDigest, type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { AdaptiveBrowser } from '../app/adaptive/browser.js';
import { OpenAIAdaptiveReasoningModel } from '../app/adaptive/openai-reasoning.js';
import { runAdaptiveVerticalSlice } from '../app/adaptive/vertical-slice.js';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { startPhase3aFixture, type Phase3aFamily } from './support/adaptive-phase3a-fixture.js';
import { adaptivePhase3aDiagnosticsEnabled, diagnosticReasoningModel,
  projectHeldoutDiagnostics } from
  './support/adaptive-phase3a-diagnostic-projection.js';

const heldOut: ReadonlyArray<{ family: Phase3aFamily; instruction: string }> = [
  { family: 'activity', instruction: 'Visit Activity. Confirm that the browser path is /activity.' },
  { family: 'security', instruction: 'Open Profile; choose Security; switch on Login alerts; verify that Login alerts stay checked.' },
];

for (const item of heldOut) test(`opt-in Phase 3A held-out ${item.family} task`, async () => {
  test.skip(process.env.ADAPTIVE_PHASE3A_HELDOUT_LIVE !== '1' || !process.env.OPENAI_API_KEY ||
    !process.env.ADAPTIVE_LIVE_MODEL, 'Requires explicit held-out live opt-in, model and credential');
  test.setTimeout(210_000);
  let browsers = 0;
  const fixture = await startPhase3aFixture(item.family, () => browsers);
  const task: TaskEnvelopeV1 = { version: '1', taskId: 'heldout_local',
    authoredInstruction: item.instruction, authoredDigest: authoredDigest(item.instruction),
    startUrl: `${fixture.baseUrl}/`, approvalRef: 'heldout_local_approved',
    stateResetRef: 'phase3a_reset', operatorConstraints: { allowedOrigins: [fixture.baseUrl],
      prohibitedEffects: [], confirmationRequiredEffects: [],
      allowedOperations: ['click', 'check', 'uncheck'],
      budgets: { maxActions: 8, maxObservations: 15, maxScreenshots: 2 } } };
  const adapter = new OpenAIAdaptiveReasoningModel(
    process.env.OPENAI_API_KEY!, process.env.ADAPTIVE_LIVE_MODEL!);
  const diagnosticsEnabled = adaptivePhase3aDiagnosticsEnabled(process.env.ADAPTIVE_PHASE3A_DIAGNOSTICS);
  const diagnosticModel = diagnosticsEnabled ? diagnosticReasoningModel(adapter) : undefined;
  let intakeCalls = 0, proposalCalls = 0;
  const model = diagnosticModel?.model ?? {
    interpretRequirements: (context: Parameters<typeof adapter.interpretRequirements>[0]) => {
      intakeCalls++; return adapter.interpretRequirements(context);
    },
    propose: (context: Parameters<typeof adapter.propose>[0]) => {
      proposalCalls++; return adapter.propose(context);
    },
  };
  const catalog = new NativeProfileCatalog([{ id: 'adaptive_heldout', version: '1',
    browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: {} },
    profileSchemaVersion: '5', presentationMode: 'headless',
    browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' }]);
  const factory = new ProtectedContextFactory(catalog);
  try {
    const report = await runAdaptiveVerticalSlice({ task, model,
    reset: fixture.reset, openBrowser: async () => { browsers++;
      const session = await factory.open({ id: 'adaptive_heldout', version: '1' });
      return new AdaptiveBrowser(await session.context.newPage(), () => session.close()); },
    maxModelTurns: 10, maxElapsedMs: 150_000, maxIneffectiveActions: 2,
    ...(diagnosticsEnabled ? { diagnostics: true } : {}) });
    const oracle = await fixture.oracle();
    const base = { outcome: report.result.outcome,
      explorationActions: report.explorationActions.length,
      cleanActions: report.result.actionEvidenceIds.length,
      cleanReset: report.result.cleanStart, coverage: report.result.requirementCoverage,
      timingsMs: report.timingsMs,
      oracle: { alertsEnabled: oracle.alertsEnabled, resetGeneration: oracle.resetGeneration } };
    if (diagnosticModel) {
      const diagnostic = projectHeldoutDiagnostics({
        ...(report.stopReason ? { stopReason: report.stopReason } : {}),
        ...(report.diagnostics ? { diagnostics: report.diagnostics } : {}),
        outcome: report.result.outcome, calls: diagnosticModel.calls });
      console.log(`ADAPTIVE_PHASE3A_HELDOUT_${item.family.toUpperCase()}=${JSON.stringify({ ...base,
        terminalCategory: diagnostic.terminalCategory,
        ...(diagnostic.validationCode ? { validationCode: diagnostic.validationCode } : {}),
        intakeCalls: diagnosticModel.calls.filter(call => call.stage === 'intake' ||
          call.stage === 'refinement').length,
        proposalCalls: diagnosticModel.calls.filter(call => call.stage === 'proposal' ||
          call.stage === 'clean_visual').length,
        diagnostics: diagnostic.diagnostics, modelCalls: diagnostic.modelCalls,
        requiredActionReceipts: diagnostic.requiredActionReceipts })}`);
    } else {
      console.log(`ADAPTIVE_PHASE3A_HELDOUT_${item.family.toUpperCase()}=${JSON.stringify({ ...base,
        stopReason: report.stopReason, intakeCalls, proposalCalls,
        finalCleanState: report.finalCleanState })}`);
    }
    expect(report.result.outcome).toBe('VERIFIED_PASS');
    expect(report.result.requirementCoverage.every(goal => goal.status === 'verified_true')).toBe(true);
    if (item.family === 'security') expect(oracle.alertsEnabled).toBe(true);
  } finally { await fixture.close(); }
});
