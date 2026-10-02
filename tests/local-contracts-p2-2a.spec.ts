import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ResultRecordSchema, TestSpecSchema } from '../app/domain/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import {
  LocalWorkflowOutcomeSchema, LocalWorkflowRequestSchema, ObservationEventSchema,
  ObservationJournal, ObservationStateSchema, parseTrustedLocalConfiguration,
  toInterpretationRequest,
} from '../app/local/index.js';
import { ProfileCatalog, profilePresentationMode } from '../app/profile/index.js';

const policy = { id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [4173], addresses: ['127.0.0.1'] }] };
const legacyProfile = {
  id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
  locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
  networkPolicyRef: { id: 'local', version: '1' },
};
const request = {
  taskText: ' Select Save. ', targetUrl: 'http://127.0.0.1:4173/',
  executionProfileRef: { id: 'desktop', version: '1' },
};
const evidencePolicy = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

test('P2-2A untrusted request is closed and maps its original text and URL only to start state', () => {
  const mapped = toInterpretationRequest(request, 'task-1');
  expect(mapped).toEqual({
    sourceInstruction: request.taskText, testSpecId: 'task-1',
    executionProfileRef: request.executionProfileRef, startState: { url: request.targetUrl },
  });
  for (const extra of [
    { apiKey: 'secret' }, { artifactRoot: 'jobs' }, { evidencePolicy },
    { networkPolicy: policy }, { headless: false },
  ]) expect(() => LocalWorkflowRequestSchema.parse({ ...request, ...extra })).toThrow();
  for (const targetUrl of ['file:///etc/passwd', 'not a URL']) {
    expect(() => LocalWorkflowRequestSchema.parse({ ...request, targetUrl })).toThrow();
  }
});

test('P2-2A trusted settings validate policy references and evidence approval separately', () => {
  const config = { profiles: [legacyProfile], networkPolicies: [policy], evidencePolicy, artifactRoot: 'jobs', retentionDays: 7 };
  expect(parseTrustedLocalConfiguration(config)).toEqual(config);
  expect(parseTrustedLocalConfiguration({ ...config, networkPolicies: [] }).networkPolicies).toEqual([]);
  expect(() => parseTrustedLocalConfiguration({ ...config, evidencePolicy: { ...evidencePolicy, failureTrace: true } })).toThrow();
  expect(() => parseTrustedLocalConfiguration({ ...config, apiKey: 'secret' })).toThrow();
});

test('PoC profile requires no policy reference, pins, or approved destination', () => {
  const { networkPolicyRef: _legacy, ...runtimeProfile } = legacyProfile;
  const config = parseTrustedLocalConfiguration({ profiles: [runtimeProfile], evidencePolicy,
    artifactRoot: 'jobs', retentionDays: 7 });
  expect(config.networkPolicies).toEqual([]);
  const effective = new ProfileCatalog(config.profiles, config.networkPolicies)
    .resolve({ id: runtimeProfile.id, version: runtimeProfile.version });
  expect(effective.policy.destinations).toEqual([]);
  expect(effective.fingerprint).toBe(createHash('sha256').update(JSON.stringify(runtimeProfile)).digest('hex'));
});

test('P2-2A profile versions preserve legacy fingerprint/readback and distinguish headed mode', async () => {
  const v2Base = { ...legacyProfile, profileSchemaVersion: '2' as const, version: '2' as const };
  const headless = { ...v2Base, presentationMode: 'headless' as const };
  const headed = { ...v2Base, id: 'desktop-headed', presentationMode: 'headed' as const };
  const catalog = new ProfileCatalog([legacyProfile, headless, headed], [policy]);
  const legacy = catalog.resolve({ id: 'desktop', version: '1' });
  const { networkPolicyRef: _legacy, ...runtimeProfile } = legacyProfile;
  const expectedLegacyFingerprint = createHash('sha256').update(JSON.stringify(runtimeProfile)).digest('hex');
  expect(legacy.fingerprint).toBe(expectedLegacyFingerprint);
  expect(profilePresentationMode(legacy.profile)).toBe('headless');
  expect('presentationMode' in legacy.profile).toBe(false);
  const second = catalog.resolve({ id: 'desktop', version: '2' });
  const third = catalog.resolve({ id: 'desktop-headed', version: '2' });
  expect(profilePresentationMode(second.profile)).toBe('headless');
  expect(profilePresentationMode(third.profile)).toBe('headed');
  expect(second.fingerprint).not.toBe(legacy.fingerprint);
  expect(third.fingerprint).not.toBe(second.fingerprint);
  const headedSameIdentity = new ProfileCatalog([{ ...v2Base, presentationMode: 'headed' }], [policy])
    .resolve({ id: 'desktop', version: '2' });
  expect(headedSameIdentity.fingerprint).not.toBe(second.fingerprint);
  expect(() => new ProfileCatalog([{ ...legacyProfile, presentationMode: 'headed' }], [policy])).toThrow();
  const legacyCustomVersion = { ...legacyProfile, id: 'prior-custom', version: '2' };
  const custom = new ProfileCatalog([legacyCustomVersion], [policy]).resolve({ id: 'prior-custom', version: '2' });
  expect(custom.profile).toEqual(legacyCustomVersion);
  const { networkPolicyRef: _customPolicy, ...customRuntime } = legacyCustomVersion;
  expect(custom.fingerprint).toBe(createHash('sha256').update(JSON.stringify(customRuntime)).digest('hex'));
  expect(() => new ProfileCatalog([{ ...v2Base }], [policy])).toThrow();

  const root = await mkdtemp(path.join(tmpdir(), 'p2-2a-'));
  try {
    const source = TestSpecSchema.parse({
      schemaVersion: '2', testSpecId: 'task-1', sourceInstruction: 'Select Save.',
      executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' },
      steps: [{ id: 's1', type: 'click', sourceText: 'Select Save.', target: { description: 'Save' } }],
    });
    const store = new LocalArtifactStore(root);
    await store.createJob(source, legacy);
    const read = await store.readJob(source.testSpecId);
    expect(read.profile.fingerprint).toBe(expectedLegacyFingerprint);
    expect(read.profile.profile).toEqual(legacyProfile);
    await expect(store.createJob(source, second)).rejects.toThrow('Job profile differs');
    const v2Source = { ...source, testSpecId: 'task-2', executionProfileRef: { id: 'desktop-headed', version: '2' } };
    await store.createJob(v2Source, third);
    const readV2 = await store.readJob('task-2');
    expect(readV2.profile.profile).toEqual(headed);
    expect(readV2.profile.fingerprint).toBe(third.fingerprint);
    expect(() => catalog.resolve({ id: 'desktop-headed', version: '3' })).toThrow('Unavailable execution profile');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-2A intervention records append in order and read back without rewriting prior facts', () => {
  const correlation = {
    testSpecId: 'task-1', owner: { kind: 'run' as const, id: 'run-1' },
    executionProfileRef: { id: 'desktop', version: '2' }, profileFingerprint: 'a'.repeat(64),
  };
  const log = new ObservationJournal(correlation, 'headless');
  expect(log.state(false)).toEqual({ state: 'unobserved', autonomousEligible: false, eventIds: [] });
  expect(log.state(true)).toEqual({ state: 'no_intervention', autonomousEligible: true, eventIds: [] });
  const first = {
    ...correlation, eventId: 'evt-1', occurredAt: '2026-09-21T12:00:00.000Z',
    inputCategory: 'keyboard' as const, attribution: 'outside_scope' as const,
    interventionReason: 'INPUT_OUTSIDE_SCOPE' as const,
  };
  expect(log.autonomousEligible).toBe(true);
  expect(log.append(first).sequence).toBe(0);
  const second = {
    ...correlation, eventId: 'evt-2', occurredAt: '2026-09-21T12:00:01.000Z',
    inputCategory: 'pointer' as const, attribution: 'uncertain' as const,
    interventionReason: 'UNCERTAIN_ORIGIN' as const,
    automationScope: { scopeId: 'scope-1', actionId: 'action-1', originStepId: 's1', executionStepId: 'x1' },
  };
  expect(log.append(second).sequence).toBe(1);
  expect(log.autonomousEligible).toBe(false);
  expect(log.state(true)).toEqual({ state: 'intervened', autonomousEligible: false, eventIds: ['evt-1', 'evt-2'] });
  const copy = log.records();
  copy[0]!.eventId = 'mutated';
  expect(log.records()[0]!.eventId).toBe('evt-1');
  const restored = ObservationJournal.readback(correlation, JSON.parse(JSON.stringify(log.records())) as unknown, 'headless');
  expect(restored.records()).toEqual(log.records());
  expect(restored.autonomousEligible).toBe(false);
  expect(() => log.append(first)).toThrow('already exists');
  expect(() => ObservationJournal.readback(correlation, [{ ...log.records()[0], sequence: 1 }], 'headless')).toThrow('order mismatch');
  expect(() => log.append({ ...second, eventId: 'evt-3', owner: { kind: 'attempt', id: 'explore-1' } })).toThrow('correlation mismatch');
  expect(() => ObservationEventSchema.parse({ ...first, sequence: 2, automationScope: second.automationScope })).toThrow();
  expect(() => ObservationEventSchema.parse({ ...first, sequence: 2, inputPayload: 'secret' })).toThrow();
  expect(ObservationStateSchema.parse({ state: 'intervened', autonomousEligible: false, eventIds: ['evt-1'] }).state).toBe('intervened');
  expect(() => ObservationStateSchema.parse({ state: 'intervened', autonomousEligible: true, eventIds: ['evt-1'] })).toThrow();
  expect(() => TestSpecSchema.parse({ schemaVersion: '2', intervention: log.records() })).toThrow();
  expect(() => ResultRecordSchema.parse({ status: 'QA_ASSERTION_PASSED', intervention: true })).toThrow();
});

test('P2-2A headed observations never establish autonomous provenance, including an empty log', () => {
  const correlation = {
    testSpecId: 'task-1', owner: { kind: 'run' as const, id: 'run-1' },
    executionProfileRef: { id: 'desktop-headed', version: '2' }, profileFingerprint: 'b'.repeat(64),
  };
  const log = new ObservationJournal(correlation, 'headed');
  const empty = { state: 'observational', inputProvenance: 'unverified',
    autonomousEligible: false, eventIds: [] };
  expect(log.autonomousEligible).toBe(false);
  expect(log.state(false)).toEqual(empty);
  expect(log.state(true)).toEqual(empty);
  expect(ObservationStateSchema.parse(empty)).toEqual(empty);
  expect(() => ObservationStateSchema.parse({ ...empty, autonomousEligible: true })).toThrow();
  log.append({ ...correlation, eventId: 'evt-1', occurredAt: '2026-09-21T12:00:00.000Z',
    inputCategory: 'pointer', attribution: 'uncertain', interventionReason: 'UNCERTAIN_ORIGIN' });
  const detected = { ...empty, eventIds: ['evt-1'] };
  expect(log.state(true)).toEqual(detected);
  expect(log.autonomousEligible).toBe(false);
  const restored = ObservationJournal.readback(correlation, log.records(), 'headed');
  expect(restored.state(true)).toEqual(detected);
  expect(restored.records()).toEqual(log.records());
});

test('P2-2A local outcome preserves typed handoff and keeps intervention out of QA status', () => {
  const now = '2026-09-21T12:00:00.000Z';
  const outcome = {
    testSpecId: 'task-1', executionProfileRef: request.executionProfileRef,
    profileFingerprint: 'a'.repeat(64), presentationMode: 'headless',
    handoff: { kind: 'stopped', result: {
      phase: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION', testSpecId: 'task-1',
      retryable: false, startedAt: now, finishedAt: now, evidenceRefs: [],
    } },
    report: { kind: 'unavailable' },
    observation: { state: 'intervened', autonomousEligible: false, eventIds: ['evt-1'] },
  };
  const parsed = LocalWorkflowOutcomeSchema.parse(outcome);
  expect(parsed.handoff.kind).toBe('stopped');
  if (parsed.handoff.kind === 'stopped') expect(parsed.handoff.result.status).toBe('AMBIGUOUS_INSTRUCTION');
  expect(() => LocalWorkflowOutcomeSchema.parse({ ...outcome, observation: { ...outcome.observation, autonomousEligible: true } })).toThrow();
  expect(() => LocalWorkflowOutcomeSchema.parse({ ...outcome, browserActions: [] })).toThrow();
  const headed = { ...outcome, presentationMode: 'headed',
    observation: { state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false, eventIds: [] } };
  expect(LocalWorkflowOutcomeSchema.parse(headed).handoff).toEqual(outcome.handoff);
  expect(() => LocalWorkflowOutcomeSchema.parse({ ...headed, observation: outcome.observation })).toThrow();
  expect(() => LocalWorkflowOutcomeSchema.parse({ ...headed,
    observation: { ...headed.observation, autonomousEligible: true } })).toThrow();
  expect(() => LocalWorkflowOutcomeSchema.parse({ ...outcome, observation: headed.observation })).toThrow();
});
