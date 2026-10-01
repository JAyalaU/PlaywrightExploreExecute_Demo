import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LocalArtifactStore, readStoredJobReport } from '../app/evidence/index.js';
import type { InterpretationModel, StepDecisionModel } from '../app/interpretation/index.js';
import { ObservationEventSchema, runLocalWorkflow } from '../app/local/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

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

function config(port: number, artifactRoot: string) {
  const base = {
    browser: 'chromium' as const, viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'local-policy', version: '1' }, profileSchemaVersion: '2' as const,
  };
  return {
    profiles: [
      { ...base, id: 'local-headed', version: '2', presentationMode: 'headed' as const },
      { ...base, id: 'local-headless', version: '2', presentationMode: 'headless' as const },
    ],
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

function models(url: string, expectedUrl = url): { interpretationModel: InterpretationModel; stepDecisionModel: StepDecisionModel } {
  return {
    interpretationModel: { complete: async () => JSON.stringify({ kind: 'test_spec', steps: [
      { id: 's1', type: 'click', sourceText: 'Select Save', target: { description: 'Save' } },
      { id: 's2', type: 'assert_url', sourceText: 'Assert URL', expectedUrl, match: 'exact' },
    ] }) },
    stepDecisionModel: { complete: async ({ context }) => {
      const ref = /button "Save" \[ref=(e\d+)\]/.exec(context.snapshot)?.[1];
      return JSON.stringify(ref
        ? { kind: 'target', ref, element: 'Save button' }
        : { kind: 'unresolved', reason: 'TARGET_NOT_FOUND' });
    } },
  };
}

function request(url: string, mode: 'headed' | 'headless') {
  return { targetUrl: url, taskText: 'Select Save. Assert URL.',
    executionProfileRef: { id: `local-${mode}`, version: '2' } };
}

test('P2-2C headed exploration and both replays use protected sessions and store correlated input observations', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2c-'));
  try {
    const trusted = config(site.port, root);
    const headed = await runLocalWorkflow(request(site.url, 'headed'), trusted,
      { provider: { apiKey: () => undefined } }, { modelAdapters: models(site.url) });
    expect(headed.handoff.kind).toBe('executed');
    expect(headed.observation).toMatchObject({ state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false });
    expect(headed.observation.eventIds.length).toBeGreaterThan(0);
    const store = new LocalArtifactStore(root);
    const report = await readStoredJobReport(store, headed.testSpecId);
    expect(report.attempts).toHaveLength(1);
    expect(report.runs).toHaveLength(2);
    expect(headed.handoff.kind === 'executed' && headed.handoff.replay.map((run) => run.outcomes.at(-1)?.status))
      .toEqual(['QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED']);
    const owners = [
      { kind: 'attempt', id: report.attempts[0]!.explorationAttemptId },
      ...report.runs.map((run) => ({ kind: 'run', id: run.executionRunId })),
    ];
    const observedOwners = new Set<string>();
    for (const eventId of headed.observation.eventIds) {
      let found = false;
      for (const owner of owners) {
        const ref = `evidence/${owner.kind}-${owner.id}/${eventId}/content.json`;
        const descriptor = await store.readEvidence(headed.testSpecId, ref).catch(() => undefined);
        if (!descriptor) continue;
        const event = ObservationEventSchema.parse(JSON.parse(Buffer.from(
          await store.readEvidenceContent(headed.testSpecId, ref)).toString('utf8')));
        expect(event).toMatchObject({ eventId, testSpecId: headed.testSpecId,
          executionProfileRef: request(site.url, 'headed').executionProfileRef,
          profileFingerprint: headed.profileFingerprint, owner,
          attribution: 'uncertain', interventionReason: 'UNCERTAIN_ORIGIN' });
        expect(JSON.stringify(event)).not.toContain('Saved');
        observedOwners.add(`${owner.kind}:${owner.id}`);
        found = true;
        break;
      }
      expect(found).toBe(true);
    }
    expect(observedOwners.has(`attempt:${report.attempts[0]!.explorationAttemptId}`)).toBe(true);
    expect(report.runs.every((run) => observedOwners.has(`run:${run.executionRunId}`))).toBe(true);
    const headless = await runLocalWorkflow(request(site.url, 'headless'), trusted,
      { provider: { apiKey: () => undefined } }, { modelAdapters: models(site.url) });
    expect(headless.observation).toEqual({ state: 'no_intervention', autonomousEligible: true, eventIds: [] });
    expect(headless.handoff.kind).toBe('executed');
    expect(headless.profileFingerprint).not.toBe(headed.profileFingerprint);
    if (headed.handoff.kind === 'executed' && headless.handoff.kind === 'executed') {
      expect(headless.handoff.replay.map((run) => run.outcomes.map((item) => item.status)))
        .toEqual(headed.handoff.replay.map((run) => run.outcomes.map((item) => item.status)));
    }
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2C empty headed observation log still cannot establish autonomous provenance', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2c-empty-'));
  try {
    const outcome = await runLocalWorkflow(request(site.url, 'headed'), config(site.port, root),
      { provider: { apiKey: () => undefined } }, { modelAdapters: {
        interpretationModel: { complete: async () => JSON.stringify({ kind: 'ambiguous', reason: 'Unclear' }) },
        stepDecisionModel: { complete: async () => { throw new Error('Must not run'); } },
      } });
    expect(outcome.observation).toEqual({ state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false, eventIds: [] });
    expect(outcome.handoff.kind).toBe('stopped');
    if (outcome.handoff.kind === 'stopped') expect(outcome.handoff.result.status).toBe('AMBIGUOUS_INSTRUCTION');
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2C headed QA failure retains its assertion status and observational provenance', async () => {
  const site = await fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2c-failure-'));
  try {
    const outcome = await runLocalWorkflow(request(site.url, 'headed'), config(site.port, root),
      { provider: { apiKey: () => undefined } },
      { modelAdapters: models(site.url, `http://127.0.0.1:${site.port}/not-the-page`) });
    expect(outcome.handoff.kind).toBe('executed');
    if (outcome.handoff.kind === 'executed') {
      expect(outcome.handoff.replay.map((run) => run.outcomes.at(-1)?.status))
        .toEqual(['QA_ASSERTION_FAILED', 'QA_ASSERTION_FAILED']);
    }
    expect(outcome.observation).toMatchObject({ state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false });
    expect(outcome.observation.eventIds.length).toBeGreaterThan(0);
    expect(await site.connections()).toBe(0);
  } finally { await site.close(); await rm(root, { recursive: true, force: true }); }
});

test('P2-2C headed factory retains auth and denies secondary traffic through the protected proxy', async () => {
  const site = await fixture();
  const denied = await fixture();
  const trusted = config(site.port, 'unused');
  const profile = { ...trusted.profiles[0]!, authStateRef: { id: 'fixture-auth', version: '1' } };
  let authLoads = 0;
  const factory = new ProtectedContextFactory(new ProfileCatalog([profile], trusted.networkPolicies), {
    load: async () => {
      authLoads++;
      return { cookies: [{ name: 'sid', value: 'private', domain: '127.0.0.1', path: '/', expires: -1,
        httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
    },
  });
  const session = await factory.open({ id: profile.id, version: profile.version });
  try {
    expect(session.effectiveProfile.fingerprint).toBe(factory.catalog.resolve({
      id: profile.id, version: profile.version,
    }).fingerprint);
    const page = await session.context.newPage();
    await page.goto(site.url);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect((await session.context.cookies(site.url)).some((cookie) => cookie.name === 'sid')).toBe(true);
    expect(JSON.stringify(session.effectiveProfile)).not.toContain('private');
    expect((await page.goto(denied.url))?.status()).toBe(403);
    expect(authLoads).toBe(1);
  } finally {
    await session.close(); await site.close(); await denied.close();
  }
  expect(await site.connections()).toBe(0);
  expect(await denied.connections()).toBe(0);
});
