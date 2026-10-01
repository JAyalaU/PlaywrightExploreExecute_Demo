import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
import {
  createOpenAIModelAdapters, type InterpretationModel, type StepDecisionModel,
} from '../app/interpretation/index.js';
import {
  LOCAL_COMMAND_EXIT, runLocalCommand, runLocalWorkflow,
  type LocalWorkflowOutcome,
} from '../app/local/index.js';
import { ProfileCatalog } from '../app/profile/index.js';

const liveEnabled = process.env.P2_2_HEADED_LIVE === '1';

async function serve() {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`
      <button aria-label="Account menu" onclick="document.getElementById('menu').hidden=false">Menu</button>
      <div id="menu" role="menu" hidden>
        <button role="menuitem" onclick="document.getElementById('status').textContent='Admin selected'">Admin</button>
      </div>
      <p id="status" role="status" aria-label="Selection status">Waiting</p>
    `);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not start');
  return {
    url: `http://127.0.0.1:${address.port}/`, port: address.port,
    connections: () => new Promise<number>((resolve, reject) => server.getConnections((error, count) =>
      error ? reject(error) : resolve(count))),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function trustedConfiguration(port: number, artifactRoot: string) {
  const common = {
    version: '2', profileSchemaVersion: '2' as const, browser: 'chromium' as const,
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5_000, navigationMs: 5_000, waits: { default: 3_000 } },
    networkPolicyRef: { id: 'p2-2-policy', version: '1' },
  };
  return {
    profiles: [
      { ...common, id: 'p2-2-headless', presentationMode: 'headless' as const },
      { ...common, id: 'p2-2-headed', presentationMode: 'headed' as const },
    ],
    networkPolicies: [{ id: 'p2-2-policy', version: '1', destinations: [
      { host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] },
    ] }],
    evidencePolicy: {
      finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false,
    },
    artifactRoot, retentionDays: 7,
  };
}

const task = 'Select Admin from the Account menu. Assert the Selection status contains Admin selected.';

function ref(snapshot: string, description: string): string | undefined {
  const escaped = description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}"?\\s*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
}

function deterministicModels(): { interpretationModel: InterpretationModel; stepDecisionModel: StepDecisionModel } {
  return {
    interpretationModel: { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
      { id: 's1', type: 'click', sourceText: 'Select Admin from the Account menu.',
        target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Account menu' }] } },
      { id: 's2', type: 'assert_text', sourceText: 'Assert the Selection status contains Admin selected.',
        target: { description: 'Selection status' }, expectedText: 'Admin selected', match: 'contains' },
    ] }) },
    stepDecisionModel: { complete: async ({ context }) => {
      if (context.authoredStep.id === 's1') {
        const admin = ref(context.snapshot, 'Admin');
        if (admin) return JSON.stringify({ kind: 'target', ref: admin, element: 'Admin menuitem' });
        const menu = ref(context.snapshot, 'Account menu');
        return JSON.stringify(menu
          ? { kind: 'prerequisite', ref: menu, element: 'Account menu button', reason: 'Open Account menu', action: 'click' }
          : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
      }
      const status = ref(context.snapshot, 'Selection status');
      return JSON.stringify(status
        ? { kind: 'target', ref: status, element: 'Selection status' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
    } },
  };
}

function request(url: string, mode: 'headed' | 'headless') {
  return { targetUrl: url, taskText: task,
    executionProfileRef: { id: `p2-2-${mode}`, version: '2' } };
}

function normalized(outcome: LocalWorkflowOutcome) {
  expect(outcome.handoff.kind).toBe('executed');
  if (outcome.handoff.kind !== 'executed') throw new Error('Expected an executed handoff');
  return {
    testSpec: outcome.handoff.testSpec.steps.map(({ id: _id, sourceText: _sourceText, ...step }) => step),
    execution: outcome.handoff.replay.map((run) => run.outcomes.map((result) => ({
      phase: result.phase, status: result.status, reason: result.reason,
      originStepId: result.originStepId,
    }))),
  };
}

function comparableProfile(profile: Record<string, unknown>) {
  const { id: _id, version: _version, presentationMode: _presentationMode, ...settings } = profile;
  return settings;
}

async function runFromCommand(url: string, mode: 'headed' | 'headless', configFile: string,
  trusted: ReturnType<typeof trustedConfiguration>): Promise<{ code: number; output: string[]; outcome: LocalWorkflowOutcome }> {
  const output: string[] = [];
  let captured: LocalWorkflowOutcome | undefined;
  const code = await runLocalCommand([
    '--config', configFile, '--profile', `p2-2-${mode}@2`, '--mode', mode,
    '--url', url, '--task', task,
  ], {
    stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    apiKey: () => undefined,
    workflow: async (input, parsed, dependencies, options) => {
      captured = await runLocalWorkflow(input, parsed, dependencies, {
        ...options, modelAdapters: deterministicModels(),
      });
      return captured;
    },
  });
  if (!captured) throw new Error(`Command did not invoke workflow: ${JSON.stringify(trusted)}`);
  return { code, output, outcome: captured };
}

test('P2-2E local command preserves controlled engine semantics across observational headed and autonomous headless runs', async () => {
  const site = await serve();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2e-equivalence-'));
  try {
    const trusted = trustedConfiguration(site.port, path.join(root, 'artifacts'));
    const configFile = path.join(root, 'trusted.json');
    await writeFile(configFile, JSON.stringify(trusted));
    // Each execution creates exploration plus two fresh replay sessions. Run
    // them serially so the controlled fixture cannot hide a lifecycle race.
    const headed = await runFromCommand(site.url, 'headed', configFile, trusted);
    const headless = await runFromCommand(site.url, 'headless', configFile, trusted);

    expect(headed.code).toBe(LOCAL_COMMAND_EXIT.success);
    expect(headless.code).toBe(LOCAL_COMMAND_EXIT.success);
    expect(headed.output).toContain('provenance=observational:unverified');
    expect(headed.output).toContain('autonomousEligible=false');
    expect(headless.output).toContain('autonomousEligible=true');
    expect(headed.outcome.presentationMode).toBe('headed');
    expect(headless.outcome.presentationMode).toBe('headless');
    expect(headed.outcome.profileFingerprint).not.toBe(headless.outcome.profileFingerprint);
    expect(normalized(headed.outcome)).toEqual(normalized(headless.outcome));

    const catalog = new ProfileCatalog(trusted.profiles, trusted.networkPolicies);
    const headedProfile = catalog.resolve(headed.outcome.executionProfileRef);
    const headlessProfile = catalog.resolve(headless.outcome.executionProfileRef);
    expect(comparableProfile(headedProfile.profile as Record<string, unknown>))
      .toEqual(comparableProfile(headlessProfile.profile as Record<string, unknown>));
    expect(headedProfile.fingerprint).toBe(headed.outcome.profileFingerprint);
    expect(headlessProfile.fingerprint).toBe(headless.outcome.profileFingerprint);

    for (const outcome of [headed.outcome, headless.outcome]) {
      expect(outcome.report.kind).toBe('available');
      if (outcome.report.kind !== 'available' || outcome.handoff.kind !== 'executed') continue;
      const report = await readStoredJobReport(new LocalArtifactStore(outcome.report.artifactRoot), outcome.testSpecId);
      expect(report.effectiveProfile.fingerprint).toBe(outcome.profileFingerprint);
      expect(report.attempts).toHaveLength(1);
      expect(report.resolvedSpecs).toHaveLength(1);
      expect(report.runs).toHaveLength(2);
      const steps = report.resolvedSpecs[0]!.executionSteps;
      expect(steps.some((step) => step.source === 'discoveredPrerequisite' && step.originStepId === 's1')).toBe(true);
      expect(steps.filter((step) => 'locator' in step).every((step) =>
        'locator' in step && step.locator.quality.status === 'accepted')).toBe(true);
      expect(report.runs.map((run) => run.outcomes.at(-1)?.status))
        .toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    }
    expect(headed.outcome.observation.state).toBe('observational');
    expect(headed.outcome.observation.autonomousEligible).toBe(false);
    expect(headed.outcome.observation.eventIds.length).toBeGreaterThan(0);
    expect(headless.outcome.observation).toEqual({ state: 'no_intervention', autonomousEligible: true, eventIds: [] });
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2E preserves denied targets, profile-mode mismatch, legacy fingerprints, and typed QA failure isolation', async () => {
  const site = await serve();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2e-controls-'));
  try {
    const trusted = trustedConfiguration(site.port, path.join(root, 'artifacts'));
    const configFile = path.join(root, 'trusted.json');
    await writeFile(configFile, JSON.stringify(trusted));
    const legacy = {
      id: 'legacy', version: '1', browser: 'chromium' as const,
      viewport: { width: 900, height: 600 }, locale: 'en-US',
      timeoutPolicy: { actionMs: 5_000, navigationMs: 5_000, waits: { default: 3_000 } },
      networkPolicyRef: { id: 'p2-2-policy', version: '1' },
    };
    const before = new ProfileCatalog([legacy, ...trusted.profiles], trusted.networkPolicies)
      .resolve({ id: 'legacy', version: '1' });
    const after = new ProfileCatalog([legacy, ...trusted.profiles], trusted.networkPolicies)
      .resolve({ id: 'legacy', version: '1' });
    expect(after.fingerprint).toBe(before.fingerprint);

    const output: string[] = [];
    expect(await runLocalCommand([
      '--config', configFile, '--profile', 'p2-2-headless@2', '--mode', 'headed',
      '--url', site.url, '--task', task,
    ], { stderr: (line) => output.push(line) })).toBe(LOCAL_COMMAND_EXIT.misuse);
    expect(output.join('\n')).not.toContain(task);

    await expect(runLocalWorkflow(
      { ...request(site.url, 'headless'), targetUrl: 'http://127.0.0.1:1/' }, trusted,
      { provider: { apiKey: () => undefined } }, { modelAdapters: deterministicModels() },
    )).rejects.toMatchObject({ name: 'LocalWorkflowError', code: 'DESTINATION_DENIED' });

    const failureModels = deterministicModels();
    failureModels.interpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
      { id: 's1', type: 'click', sourceText: 'Select Admin from the Account menu.',
        target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Account menu' }] } },
      { id: 's2', type: 'assert_text', sourceText: 'Assert the Selection status contains Admin selected.',
        target: { description: 'Selection status' }, expectedText: 'Not selected', match: 'exact' },
    ] }) };
    const failed = await runLocalWorkflow(request(site.url, 'headed'), trusted,
      { provider: { apiKey: () => undefined } }, { modelAdapters: failureModels });
    expect(failed.handoff.kind).toBe('executed');
    if (failed.handoff.kind === 'executed') {
      expect(failed.handoff.replay.map((run) => run.outcomes.at(-1)?.status))
        .toEqual(['QA_ASSERTION_FAILED', 'QA_ASSERTION_FAILED']);
    }
    expect(failed.observation).toMatchObject({ state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false });
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2E opt-in live headed proof uses the local command and preserves observational evidence', async ({}, testInfo) => {
  test.skip(!liveEnabled, 'Set P2_2_HEADED_LIVE=1 to run the credentialed headed release gate.');
  test.setTimeout(300_000);
  expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required when P2_2_HEADED_LIVE=1').toBeTruthy();
  const site = await serve();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2e-live-'));
  try {
    const trusted = trustedConfiguration(site.port, path.join(root, 'artifacts'));
    const configFile = path.join(root, 'trusted.json');
    await writeFile(configFile, JSON.stringify(trusted));
    const output: string[] = [];
    const exitCode = await runLocalCommand([
      '--config', configFile, '--profile', 'p2-2-headed@2', '--mode', 'headed',
      '--url', site.url, '--task', task,
    ], { stdout: (line) => output.push(line), stderr: (line) => output.push(line) });
    expect(exitCode).toBe(LOCAL_COMMAND_EXIT.success);
    const testSpecId = output.find((line) => line.startsWith('testSpecId='))?.slice('testSpecId='.length);
    expect(testSpecId).toBeTruthy();
    expect(output).toContain('provenance=observational:unverified');
    expect(output).toContain('autonomousEligible=false');
    const store = new LocalArtifactStore(trusted.artifactRoot);
    const report = await readStoredJobReport(store, testSpecId!);
    expect(report.attempts).toHaveLength(1);
    expect(report.resolvedSpecs).toHaveLength(1);
    expect(report.resolvedSpecs[0]?.executionSteps.some((step) => step.source === 'discoveredPrerequisite')).toBe(true);
    expect(report.resolvedSpecs[0]?.executionSteps.filter((step) => 'locator' in step)
      .every((step) => 'locator' in step && step.locator.quality.status === 'accepted')).toBe(true);
    expect(report.runs).toHaveLength(2);
    expect(report.runs.every((run) => run.outcomes.at(-1)?.status === 'QA_ASSERTION_PASSED')).toBe(true);
    await testInfo.attach('p2-2-headed-live-proof.json', {
      contentType: 'application/json',
      body: JSON.stringify({ testSpecId, profile: 'p2-2-headed@2',
        profileFingerprint: report.effectiveProfile.fingerprint,
        explorationAttemptId: report.attempts[0]?.explorationAttemptId,
        resolvedSpecId: report.resolvedSpecs[0]?.resolvedSpecId,
        executionRunIds: report.runs.map((run) => run.executionRunId),
        observation: { state: 'observational', inputProvenance: 'unverified', autonomousEligible: false },
      }),
    });
  } finally {
    await site.close();
    if (process.env.P2_2_KEEP_ARTIFACTS !== '1') await rm(root, { recursive: true, force: true });
    else console.log('Preserving P2-2E artifacts at:', root);
  }
});
