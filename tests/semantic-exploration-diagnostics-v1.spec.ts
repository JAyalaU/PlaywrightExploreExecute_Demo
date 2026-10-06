import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifySemanticExplorationFailureV1, SemanticExplorationDiagnosticCollectorV1,
  SemanticExplorationDiagnosticV1Schema,
  semanticExplorationBrowserSnapshotV1, type SemanticExplorationBoundaryV1,
  type SemanticExplorationBrowserSnapshotV1 } from '../app/domain/semantic-exploration-diagnostics-v1.js';
import { SemanticExplorationDiagnosticsV1Store } from '../app/evidence/semantic-exploration-diagnostics-v1.js';

const state = (overrides: Partial<SemanticExplorationBrowserSnapshotV1> = {}):
  SemanticExplorationBrowserSnapshotV1 => ({ browserLaunchAttempted: true, browser: 'connected',
    context: 'open', page: 'open', pageCount: 1, mainFramePresent: true,
    sanitizedUrl: 'https://example.test/', documentGenerationId: 'document-1',
    readyState: 'complete', domContentLoadedObserved: true, mainResponseStatusClass: '2xx',
    navigation: 'returned', viewer: 'not_requested', ...overrides });

test('closed first-boundary taxonomy distinguishes launch, context, page, HTTP, readiness and grounding', () => {
  const cases: [SemanticExplorationBoundaryV1, Partial<SemanticExplorationBrowserSnapshotV1>, string | undefined, string][] = [
    ['browser_launch_started', {}, undefined, 'BROWSER_LAUNCH_FAILED'],
    ['context_create_started', {}, undefined, 'CONTEXT_CREATE_FAILED'],
    ['page_create_started', {}, undefined, 'PAGE_CREATE_FAILED'],
    ['root_navigation_started', { mainResponseStatusClass: '5xx' }, undefined, 'ROOT_NAVIGATION_HTTP_FAILURE'],
    ['root_navigation_started', {}, undefined, 'ROOT_NAVIGATION_FAILED'],
    ['document_readiness_started', {}, undefined, 'DOCUMENT_READINESS_FAILED'],
    ['candidate_read_started', {}, undefined, 'GROUNDING_STATE_READ_FAILED'],
    ['candidate_read_completed', {}, 'UNRESOLVED_TARGET', 'GROUNDING_CANDIDATE_FAILED'],
    ['action_dispatch_started', {}, undefined, 'ACTION_DISPATCH_FAILED'],
    ['action_effect_started', {}, undefined, 'ACTION_EFFECT_FAILED'],
    ['verification_observation_started', {}, undefined, 'VERIFICATION_OBSERVATION_FAILED'],
    ['step_grounded', { browser: 'disconnected' }, undefined, 'BROWSER_DISCONNECTED'],
    ['step_grounded', { context: 'closed' }, undefined, 'CONTEXT_CLOSED'],
    ['step_grounded', { page: 'closed' }, undefined, 'PAGE_CLOSED'],
  ];
  for (const [boundary, browser, reason, expected] of cases)
    expect(classifySemanticExplorationFailureV1(boundary, state(browser), reason)).toBe(expected);
});

test('first failure and bounded ordered semantic milestones survive cleanup without raw content', async () => {
  const collector = new SemanticExplorationDiagnosticCollectorV1('local-1', 'semantic-attempt-1');
  collector.record('browser_launch_started'); collector.record('browser_launch_completed');
  collector.record('context_create_started'); collector.record('context_create_completed');
  collector.record('page_create_started'); collector.record('page_create_completed');
  collector.record('root_navigation_started', { stepId: 's1', kind: 'navigation', family: 'navigate',
    ordinalPresent: false, relationshipPresent: false, mechanic: null, observation: null });
  collector.record('root_navigation_committed'); collector.record('root_navigation_returned');
  collector.record('document_readiness_started'); collector.record('document_readiness_completed');
  collector.record('grounding_session_initialized');
  collector.record('step_started', { stepId: 's2', kind: 'action', family: 'set_checked',
    ordinalPresent: true, relationshipPresent: false, mechanic: null, observation: null });
  collector.record('candidate_read_started'); collector.record('candidate_read_completed');
  collector.record('step_grounded', { stepId: 's2', kind: 'action', family: 'set_checked',
    ordinalPresent: true, relationshipPresent: false, mechanic: 'check', observation: null });
  collector.record('action_dispatch_started'); collector.record('action_dispatch_completed');
  collector.record('action_effect_started'); collector.record('action_effect_completed');
  collector.record('verification_observation_started');
  await collector.fail('VERIFICATION_OBSERVATION_FAILED', Promise.resolve(state()), 's3');
  collector.record('cleanup_started'); collector.record('cleanup_completed');
  await collector.fail('UNKNOWN_EXPLORATION_FAILURE', Promise.resolve(state()), null);
  const record = collector.snapshot();
  expect(record.firstFailure?.category).toBe('VERIFICATION_OBSERVATION_FAILED');
  expect(record.firstFailure?.stepId).toBe('s3');
  expect(record.finalBoundary).toBe('cleanup_completed');
  expect(record.milestones.map(m => m.ordinal)).toEqual(record.milestones.map((_, i) => i + 1));
  expect(JSON.stringify(record)).not.toMatch(/raw DOM|secret-page-text|stack trace/);
  expect(SemanticExplorationDiagnosticV1Schema.safeParse({ ...record,
    rawError: 'secret-page-text' }).success).toBe(false);
  const noBrowser = await semanticExplorationBrowserSnapshotV1(undefined, {
    browserLaunchAttempted: false, documentGenerationId: null, domContentLoadedObserved: null,
    mainResponseStatusClass: null, navigation: 'not_started', viewer: 'not_requested' });
  expect(noBrowser.browser).toBe('unknown');
});

test('post-ready viewer unavailability stays observational when semantic trace succeeds', () => {
  const collector = new SemanticExplorationDiagnosticCollectorV1('local-viewer', 'semantic-attempt-viewer');
  collector.record('viewer_open_started'); collector.record('viewer_open_completed');
  collector.record('step_started', { stepId: 'check1', kind: 'action', family: 'set_checked',
    ordinalPresent: true, relationshipPresent: false, mechanic: null, observation: null });
  collector.record('step_grounded', { stepId: 'check1', kind: 'action', family: 'set_checked',
    ordinalPresent: true, relationshipPresent: false, mechanic: 'check', observation: null });
  collector.setViewerActivity({ captureTimeouts: 1, unavailableEvents: 1,
    recovered: true, channelLost: false });
  collector.record('trace_issued');
  expect(collector.snapshot().firstFailure).toBeNull();
  expect(collector.snapshot().viewerActivity.recovered).toBe(true);
  expect(state({ viewer: 'transient_unavailable' }).viewer).toBe('transient_unavailable');
});

test('milestone cap retains attempt creation and the latest failure boundary', async () => {
  const collector = new SemanticExplorationDiagnosticCollectorV1('local-cap', 'semantic-attempt-cap');
  for (let index = 0; index < 600; index++) collector.record('candidate_read_started');
  collector.record('verification_observation_started');
  await collector.fail('VERIFICATION_OBSERVATION_FAILED', Promise.resolve(state()), 'v1');
  const record = collector.snapshot();
  expect(record.milestones).toHaveLength(512);
  expect(record.milestones[0]?.boundary).toBe('attempt_created');
  expect(record.finalBoundary).toBe('verification_observation_started');
  expect(record.firstFailure?.boundary).toBe('verification_observation_started');
});

test('authenticated readback rejects tamper and keeps latest 64 attempts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'semantic-exploration-diagnostics-'));
  try {
    const store = new SemanticExplorationDiagnosticsV1Store(root);
    for (let n = 0; n < 65; n++) {
      const collector = new SemanticExplorationDiagnosticCollectorV1('local-test', `semantic-attempt-${n}`);
      collector.record('trace_issued'); collector.record('cleanup_started'); collector.record('cleanup_completed');
      await store.write(collector.snapshot());
      if (n === 64) await store.write(collector.snapshot());
    }
    const directory = path.join(root, 'semantic-exploration-diagnostics-v1');
    expect((await readdir(directory)).length).toBe(64);
    const latest = (await store.readByCorrelation({ explorationAttemptId: 'semantic-attempt-64' }))[0]!;
    expect(latest.firstFailure).toBeNull();
    const file = path.join(directory, 'semantic-attempt-64.json');
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: { testSpecId: string } };
    envelope.data.testSpecId = 'local-forged';
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.readByCorrelation({ explorationAttemptId: 'semantic-attempt-64' }))
      .rejects.toThrow('INVALID_SEMANTIC_EXPLORATION_DIAGNOSTIC_AUTHENTICATION');
    expect(JSON.stringify(latest)).not.toContain('secret-page-text');
  } finally { await rm(root, { recursive: true, force: true }); }
});
