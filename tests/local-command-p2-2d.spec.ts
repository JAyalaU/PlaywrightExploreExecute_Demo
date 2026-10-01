import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  LOCAL_COMMAND_EXIT, runLocalCommand, summarizeLocalOutcome,
  type LocalWorkflowOutcome,
} from '../app/local/index.js';

const policy = { id: 'local-policy', version: '1', destinations: [
  { host: '127.0.0.1', ports: [4173], addresses: ['127.0.0.1'] },
] };
const baseProfile = {
  profileSchemaVersion: '2', version: '2', browser: 'chromium',
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
  networkPolicyRef: { id: 'local-policy', version: '1' },
};
const config = (root: string) => ({
  profiles: [
    { ...baseProfile, id: 'desktop', presentationMode: 'headless' },
    { ...baseProfile, id: 'desktop-headed', presentationMode: 'headed' },
  ],
  networkPolicies: [policy],
  evidencePolicy: {
    finalScreenshot: false, failureScreenshot: false, failureTrace: false,
    failureVideo: false, sensitiveBinaryApproved: false,
  },
  artifactRoot: path.join(root, 'artifacts'), retentionDays: 7,
});
const args = (file: string, profile = 'desktop@2') => [
  '--config', file, '--profile', profile, '--url', 'http://127.0.0.1:4173/',
  '--task', 'Select Save.',
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-2d-'));
  const file = path.join(root, 'trusted.json');
  await writeFile(file, JSON.stringify(config(root)));
  return { root, file, close: () => rm(root, { recursive: true, force: true }) };
}

function stopped(status: 'AMBIGUOUS_INSTRUCTION' | 'INTERPRETATION_FAILED',
  presentationMode: 'headless' | 'headed', reason = 'MATERIAL_AMBIGUITY'): LocalWorkflowOutcome {
  const now = new Date().toISOString();
  return {
    testSpecId: 'local-1', executionProfileRef: { id: presentationMode === 'headed' ? 'desktop-headed' : 'desktop', version: '2' },
    profileFingerprint: 'a'.repeat(64), presentationMode,
    handoff: { kind: 'stopped', result: {
      phase: 'interpretation', status, testSpecId: 'local-1', reason,
      retryable: false, startedAt: now, finishedAt: now, evidenceRefs: [],
    } },
    report: { kind: 'unavailable' },
    observation: presentationMode === 'headed'
      ? { state: 'observational', inputProvenance: 'unverified', autonomousEligible: false, eventIds: [] }
      : { state: 'unobserved', autonomousEligible: false, eventIds: [] },
  };
}

test('P2-2D selects trusted headed/headless profiles without overriding presentation mode', async () => {
  const fixtureState = await fixture();
  const output: string[] = [];
  const requests: unknown[] = [];
  try {
    for (const [profile, mode] of [['desktop@2', 'headless'], ['desktop-headed@2', 'headed']] as const) {
      const code = await runLocalCommand([...args(fixtureState.file, profile), '--mode', mode], {
        stdout: (line) => output.push(line), stderr: (line) => output.push(line),
        workflow: async (request, trusted, deps) => {
          requests.push({ request, trusted, key: deps.provider.apiKey() });
          return stopped('AMBIGUOUS_INSTRUCTION', mode);
        },
        apiKey: () => 'external-key',
      });
      expect(code).toBe(LOCAL_COMMAND_EXIT.automationStop);
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ request: {
      taskText: 'Select Save.', targetUrl: 'http://127.0.0.1:4173/',
      executionProfileRef: { id: 'desktop', version: '2' },
    }, key: 'external-key' });
    expect(requests[1]).toMatchObject({ request: { executionProfileRef: {
      id: 'desktop-headed', version: '2',
    } } });
    expect(output.join('\n')).toContain('provenance=observational:unverified');
    expect(output.join('\n')).toContain('autonomousEligible=false');
    expect(output.join('\n')).not.toContain('external-key');
    expect(output.join('\n')).not.toContain('Select Save.');
  } finally { await fixtureState.close(); }
});

test('P2-2D rejects mode mismatch, unknown profile, invalid URL, and untrusted flag shapes', async () => {
  const fixtureState = await fixture();
  const output: string[] = [];
  let calls = 0;
  const options = { stderr: (line: string) => output.push(line),
    workflow: (async () => { calls++; throw new Error('Must not call workflow'); }) as never };
  try {
    expect(await runLocalCommand([...args(fixtureState.file), '--mode', 'headed'], options))
      .toBe(LOCAL_COMMAND_EXIT.misuse);
    expect(await runLocalCommand(args(fixtureState.file, 'missing@2'), options))
      .toBe(LOCAL_COMMAND_EXIT.automationStop);
    expect(await runLocalCommand([...args(fixtureState.file).slice(0, 4), '--url', 'file:///etc/passwd',
      '--task', 'Select Save.'], options)).toBe(LOCAL_COMMAND_EXIT.misuse);
    expect(await runLocalCommand([...args(fixtureState.file), '--api-key', 'secret'], options))
      .toBe(LOCAL_COMMAND_EXIT.misuse);
    expect(await runLocalCommand([...args(fixtureState.file), '--task', 'override'], options))
      .toBe(LOCAL_COMMAND_EXIT.misuse);
    expect(calls).toBe(0);
    expect(output.join('\n')).not.toContain('secret');
  } finally { await fixtureState.close(); }
});

test('P2-2D preserves typed missing-key and denied-target stops without browser launch', async () => {
  const fixtureState = await fixture();
  const output: string[] = [];
  const options = { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line),
    apiKey: () => undefined };
  try {
    expect(await runLocalCommand(args(fixtureState.file), options)).toBe(LOCAL_COMMAND_EXIT.automationStop);
    expect(output.join('\n')).toContain('terminalStatus=INTERPRETATION_FAILED');
    expect(output.join('\n')).toContain('reason=PROVIDER_CONFIGURATION_ERROR');
    output.length = 0;
    const denied = args(fixtureState.file);
    denied[5] = 'http://127.0.0.1:4174/';
    expect(await runLocalCommand(denied, options)).toBe(LOCAL_COMMAND_EXIT.automationStop);
    expect(output).toContain('terminalStatus=DESTINATION_DENIED');
  } finally { await fixtureState.close(); }
});

test('P2-2D reports QA failures separately from automation stops and redacts unsafe reasons', () => {
  const base = stopped('INTERPRETATION_FAILED', 'headed', 'private page content / token');
  const run = (id: string, status: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' | 'LOCATOR_BINDING_FAILED') => ({
    executionRunId: id, outcomes: [{ phase: 'execution', status, testSpecId: 'local-1',
      reason: status === 'QA_ASSERTION_FAILED' ? 'NO_MATCH' : undefined,
      retryable: false, startedAt: '', finishedAt: '', evidenceRefs: [],
    }],
  });
  const withRuns = (status: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' | 'LOCATOR_BINDING_FAILED') => ({
    ...base,
    report: { kind: 'available', artifactRoot: path.join('jobs', 'local-demo'), testSpecId: 'local-1' },
    handoff: { kind: 'executed', testSpec: {}, resolvedSpecId: 'resolved-1',
      attemptId: 'attempt-1', replay: [run('run-1', status), run('run-2', status)] },
  }) as unknown as LocalWorkflowOutcome;
  expect(summarizeLocalOutcome(base)).toMatchObject({ exitCode: LOCAL_COMMAND_EXIT.automationStop });
  expect(summarizeLocalOutcome(base).lines).toContain('reason=REDACTED_REASON');
  expect(summarizeLocalOutcome(withRuns('QA_ASSERTION_PASSED')).exitCode).toBe(LOCAL_COMMAND_EXIT.success);
  expect(summarizeLocalOutcome(withRuns('QA_ASSERTION_PASSED')).lines).toContain('run2Id=run-2');
  expect(summarizeLocalOutcome(withRuns('QA_ASSERTION_PASSED')).lines)
    .toContain(`report=${JSON.stringify(path.join('jobs', 'local-demo', 'local-1'))}`);
  expect(summarizeLocalOutcome(withRuns('QA_ASSERTION_FAILED'))).toMatchObject({ exitCode: LOCAL_COMMAND_EXIT.qaFailure });
  expect(summarizeLocalOutcome(withRuns('LOCATOR_BINDING_FAILED')).exitCode).toBe(LOCAL_COMMAND_EXIT.automationStop);
});

test('P2-2D cancellation and bad trusted file have bounded output', async () => {
  const fixtureState = await fixture();
  const output: string[] = [];
  try {
    const controller = new AbortController();
    controller.abort();
    expect(await runLocalCommand(args(fixtureState.file), {
      signal: controller.signal, stderr: (line) => output.push(line),
    })).toBe(LOCAL_COMMAND_EXIT.cancelled);
    expect(output).toContain('terminalStatus=CANCELLED');
    output.length = 0;
    await writeFile(fixtureState.file, '{ "apiKey": "private-value" }');
    expect(await runLocalCommand(args(fixtureState.file), {
      stderr: (line) => output.push(line),
    })).toBe(LOCAL_COMMAND_EXIT.automationStop);
    expect(output).toContain('terminalStatus=INVALID_TRUSTED_CONFIGURATION');
    expect(output.join('\n')).not.toContain('private-value');
  } finally { await fixtureState.close(); }
});
