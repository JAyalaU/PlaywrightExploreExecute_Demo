import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
import {
  createOpenAIResponsesClient, INTERPRETATION_RESPONSE_FORMAT,
  type InterpretationModel, type StepDecisionModel,
} from '../app/interpretation/index.js';
import { LocalWorkflowError, runLocalWorkflow } from '../app/local/index.js';
import { LiveEventProducer, type LiveEvent } from '../app/observability/live-events.js';
import type { LiveImageFrame } from '../app/observability/live-images.js';

async function fixture() {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<button aria-label="Save" onclick="this.textContent=\'Saved\'">Save</button>');
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

function trusted(port: number, artifactRoot: string) {
  return {
    profiles: [{
      id: 'local-desktop', version: '1', browser: 'chromium' as const,
      viewport: { width: 900, height: 600 }, locale: 'en-US',
      timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
      networkPolicyRef: { id: 'local-policy', version: '1' },
    }],
    networkPolicies: [{ id: 'local-policy', version: '1', destinations: [
      { host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] },
    ] }],
    evidencePolicy: {
      finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false,
    },
    artifactRoot, retentionDays: 7,
  };
}

const dependencies = { provider: { apiKey: () => undefined } };

function models(url: string): { interpretationModel: InterpretationModel; stepDecisionModel: StepDecisionModel } {
  return {
    interpretationModel: { complete: async ({ userInstruction }) => {
      expect(userInstruction).toBe(`Select Save. Assert the URL is ${url}.`);
      return JSON.stringify({ kind: 'test_spec', steps: [
        { id: 's1', type: 'click', sourceText: 'Select Save', target: { description: 'Save' } },
        { id: 's2', type: 'assert_url', sourceText: `Assert the URL is ${url}`,
          expectedUrl: url, match: 'exact' },
      ] });
    } },
    stepDecisionModel: { complete: async ({ context }) => {
      const ref = /button "Save" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
      return JSON.stringify(ref
        ? { kind: 'target', ref, element: 'Save button' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
    } },
  };
}

function request(url: string) {
  return { targetUrl: url, taskText: `Select Save. Assert the URL is ${url}.`,
    executionProfileRef: { id: 'local-desktop', version: '1' } };
}

test('P2-2B runs a local task through M7, MCP, and two protected deterministic replays', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-success-'));
  const events: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { events.push(event); });
  try {
    const outcome = await runLocalWorkflow(request(site.url), trusted(site.port, root), dependencies,
      { modelAdapters: models(site.url), events: producer });
    expect(outcome.testSpecId).toMatch(/^local-[a-f0-9-]+$/);
    expect(outcome.report).toEqual({ kind: 'available', artifactRoot: root, testSpecId: outcome.testSpecId });
    expect(outcome.observation).toEqual({ state: 'no_intervention', autonomousEligible: true, eventIds: [] });
    expect(outcome.handoff.kind).toBe('executed');
    if (outcome.handoff.kind !== 'executed') return;
    expect(outcome.handoff.testSpec.startState.url).toBe(site.url);
    expect(outcome.handoff.testSpec.sourceInstruction).toBe(request(site.url).taskText);
    expect(outcome.handoff.replay.map((run) => run.outcomes.at(-1)?.status))
      .toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    const stored = await readStoredJobReport(new LocalArtifactStore(root), outcome.testSpecId);
    expect(stored.effectiveProfile.fingerprint).toBe(outcome.profileFingerprint);
    expect(stored.attempts).toHaveLength(1);
    expect(stored.resolvedSpecs).toHaveLength(1);
    expect(stored.runs).toHaveLength(2);
    expect(stored.resolvedSpecs[0]?.executionSteps.filter((step) => 'locator' in step)
      .every((step) => 'locator' in step && step.locator.quality.status === 'accepted')).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events[0]).toMatchObject({ kind: 'workflow_started', context: { testSpecId: outcome.testSpecId } });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'interpretation_started', 'interpretation_finished', 'exploration_started',
      'step_decision_started', 'step_decision_finished', 'mcp_tool_started', 'mcp_tool_finished',
      'locator_assessed', 'resolved_spec_ready', 'replay_started', 'replay_finished', 'report_completed',
    ]));
    expect(events.filter((event) => event.kind === 'replay_started').map((event) => event.data))
      .toEqual([{ ordinal: 1 }, { ordinal: 2 }]);
    expect(events.filter((event) => event.kind === 'replay_finished').map((event) => event.data))
      .toEqual([{ ordinal: 1, status: 'QA_ASSERTION_PASSED' }, { ordinal: 2, status: 'QA_ASSERTION_PASSED' }]);
    expect(events.filter((event) => event.kind === 'locator_assessed'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ data: {
        outcome: 'accepted', basis: 'mcp_generated', reasons: [],
      } })]));
    expect(events.filter((event) => event.kind === 'step_decision_started' || event.kind === 'locator_assessed')
      .map((event) => event.context?.originStepId)).toEqual(['event_step_1', 'event_step_1']);
    expect(JSON.stringify(events)).not.toContain('"originStepId":"s1"');
    expect(JSON.stringify(events)).not.toContain(site.url);
    expect(JSON.stringify(events)).not.toContain('Save button');
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P4-2A captures ephemeral frames from the protected exploration session without changing QA or evidence', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p4-2a-workflow-'));
  const events: LiveEvent[] = [];
  const frames: LiveImageFrame[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { events.push(event); });
  const injected = models(site.url);
  try {
    const outcome = await runLocalWorkflow(request(site.url), {
      ...trusted(site.port, root),
      liveImagePolicy: { liveImagePolicyVersion: '1', captureApproved: true, displayApproved: true },
    }, dependencies, {
      events: producer, liveImageSink: (frame) => { frames.push(frame); },
      modelAdapters: { ...injected, stepDecisionModel: {
        complete: async (value) => {
          await new Promise((resolve) => setTimeout(resolve, 350));
          return injected.stepDecisionModel.complete(value);
        },
      } },
    });
    expect(outcome.handoff.kind).toBe('executed');
    if (outcome.handoff.kind !== 'executed') return;
    expect(outcome.handoff.replay.map((run) => run.outcomes.at(-1)?.status))
      .toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).toMatchObject({ liveImageVersion: '1', streamId: producer.streamId,
        testSpecId: outcome.testSpecId, profileFingerprint: outcome.profileFingerprint,
        mimeType: 'image/jpeg' });
      expect(frame.sourceEventSequence).toBeGreaterThan(0);
      expect(frame.sourceEventSequence).toBeLessThanOrEqual(events.length);
      expect(frame.byteCount).toBeLessThanOrEqual(128 * 1024);
      expect(frame.owner.kind).toMatch(/^(attempt|run)$/);
    }
    const report = await readStoredJobReport(new LocalArtifactStore(root), outcome.testSpecId);
    expect(report.evidence.every((descriptor) => descriptor.mediaType === 'application/json')).toBe(true);
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B preserves typed interpretation stop before job creation', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-stop-'));
  const events: LiveEvent[] = [];
  try {
    const outcome = await runLocalWorkflow(request(site.url), trusted(site.port, root), dependencies, {
      events: new LiveEventProducer(randomUUID(), (event) => { events.push(event); }),
      modelAdapters: {
        interpretationModel: { complete: async () => JSON.stringify({ kind: 'ambiguous', reason: 'Unclear Save target' }) },
        stepDecisionModel: { complete: async () => { throw new Error('step model must not run'); } },
      },
    });
    expect(outcome.handoff.kind).toBe('stopped');
    if (outcome.handoff.kind === 'stopped') {
      expect(outcome.handoff.result).toMatchObject({ phase: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION' });
    }
    expect(outcome.report).toEqual({ kind: 'unavailable' });
    expect((await new LocalArtifactStore(root).readInterpretation(outcome.testSpecId)).outcome).toBe('rejected');
    expect(events.map((event) => event.kind)).toEqual([
      'workflow_started', 'interpretation_started', 'interpretation_finished', 'report_completed',
    ]);
    await expect(new LocalArtifactStore(root).readJob(outcome.testSpecId)).rejects.toThrow();
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B rejects invalid request, absent profile, denied URL, and invalid provider setup before browser use', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-reject-'));
  const config = trusted(site.port, root);
  const expected = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({ name: 'LocalWorkflowError', code, message: code });
  };
  try {
    await expected(runLocalWorkflow({ ...request(site.url), apiKey: 'do-not-record' }, config, dependencies), 'INVALID_REQUEST');
    await expected(runLocalWorkflow(request(site.url), { ...config, profiles: [] }, dependencies), 'INVALID_TRUSTED_CONFIGURATION');
    await expected(runLocalWorkflow({ ...request(site.url), executionProfileRef: { id: 'missing', version: '1' } },
      config, dependencies), 'PROFILE_UNAVAILABLE');
    await expected(runLocalWorkflow({ ...request(site.url), targetUrl: 'file:///tmp/x' },
      config, dependencies), 'INVALID_REQUEST');
    await expected(runLocalWorkflow(request(site.url), config,
      { provider: { apiKey: () => 'secret', model: 'invalid model' } }), 'PROVIDER_CONFIGURATION_ERROR');
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B keeps missing provider credentials as an M7 typed stop', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-key-'));
  try {
    const outcome = await runLocalWorkflow(request(site.url), trusted(site.port, root), dependencies);
    expect(outcome.handoff.kind).toBe('stopped');
    if (outcome.handoff.kind === 'stopped') expect(outcome.handoff.result)
      .toMatchObject({ phase: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'PROVIDER_CONFIGURATION_ERROR' });
    expect(outcome.report).toEqual({ kind: 'unavailable' });
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B cancellation closes an active protected exploration session', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-cancel-'));
  const controller = new AbortController();
  let decisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { decisionStarted = resolve; });
  try {
    const pending = runLocalWorkflow(request(site.url), trusted(site.port, root), dependencies, {
      signal: controller.signal,
      modelAdapters: {
        interpretationModel: models(site.url).interpretationModel,
        stepDecisionModel: { complete: async ({ context }) => {
          expect(context.snapshot).toContain('button "Save"');
          decisionStarted();
          return new Promise<string>(() => undefined);
        } },
      },
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'LocalWorkflowError', code: 'CANCELLED' });
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B sanitizes thrown artifact setup failure and leaves no browser session', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2b-setup-'));
  const file = path.join(root, 'occupied');
  await writeFile(file, 'occupied');
  try {
    await expect(runLocalWorkflow(request(site.url), trusted(site.port, file), dependencies, {
      modelAdapters: { interpretationModel: { complete: async () => JSON.stringify({ kind: 'ambiguous', reason: 'Unclear' }) },
        stepDecisionModel: { complete: async () => { throw new Error('unexpected'); } } },
    })).rejects.toMatchObject({ code: 'WORKFLOW_FAILED', message: 'WORKFLOW_FAILED' });
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2B provider HTTP failure never prints its private response body', async () => {
  const secret = 'private-provider-body-do-not-log';
  const output: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { output.push(values); };
  try {
    const client = createOpenAIResponsesClient({
      apiKey: () => 'private-key',
      fetchImpl: (async () => new Response(secret, { status: 503 })) as typeof fetch,
    });
    const outcome = await client.complete({
      systemInstruction: 'Use the closed schema.', input: 'Select Save.',
      format: INTERPRETATION_RESPONSE_FORMAT, signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain('private-key');
  } finally { console.error = original; }
});
