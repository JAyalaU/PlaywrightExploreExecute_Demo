import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runSubprocessAdapter, serializeSubprocessResponse,
  type SubprocessResponse } from '../app/subprocess/index.js';
import { parseSubprocessResponse } from '../app/subprocess/protocol.js';
import type { LocalWorkflowOutcome } from '../app/local/contracts.js';
import type { LocalWorkflowOptions } from '../app/local/workflow.js';
import { LiveEventProducer, type LiveEvent } from '../app/observability/live-events.js';

const ref = { id: 'desktop', version: '2' };
const url = 'http://127.0.0.1:4173/';
const request = { protocolVersion: '1', request: {
  taskText: 'Select Save.', targetUrl: url, executionProfileRef: ref,
} };
const profile = {
  id: 'desktop', version: '2', profileSchemaVersion: '2' as const,
  presentationMode: 'headless' as const, browser: 'chromium' as const,
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 3000 } },
  networkPolicyRef: { id: 'policy', version: '1' },
};
const policy = { id: 'policy', version: '1', destinations: [
  { host: '127.0.0.1', ports: [4173], addresses: ['127.0.0.1'] },
] };
const config = {
  profiles: [profile], networkPolicies: [policy],
  evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
    failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
  artifactRoot: 'artifacts', retentionDays: 7,
};
const dependencies = { provider: { apiKey: () => undefined } };
const now = new Date().toISOString();
const record = (status: 'AMBIGUOUS_INSTRUCTION' | 'QA_ASSERTION_PASSED' |
  'QA_ASSERTION_FAILED' | 'LOCATOR_BINDING_FAILED', runId?: string) => ({
    phase: runId ? 'execution' as const : 'interpretation' as const, status,
    testSpecId: 'local-1', ...(runId ? { executionRunId: runId,
      resolvedSpecId: 'resolved-1', executionProfileRef: ref } : {}),
    retryable: false, startedAt: now, finishedAt: now, evidenceRefs: [],
  });

function stopped(): LocalWorkflowOutcome {
  return {
    testSpecId: 'local-1', executionProfileRef: ref, profileFingerprint: 'a'.repeat(64),
    presentationMode: 'headless', observation: {
      state: 'unobserved', autonomousEligible: false, eventIds: [],
    },
    handoff: { kind: 'stopped', result: {
      ...record('AMBIGUOUS_INSTRUCTION'), reason: 'secret page text',
    } }, report: { kind: 'unavailable' },
  };
}

function executed(lastStatus: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' |
  'LOCATOR_BINDING_FAILED'): LocalWorkflowOutcome {
  const testSpec = {
    schemaVersion: '2' as const, testSpecId: 'local-1',
    sourceInstruction: 'Select Save.', executionProfileRef: ref,
    startState: { url }, steps: [{ id: 's1', type: 'assert_url' as const,
      sourceText: 'Check the URL.', expectedUrl: url, match: 'exact' as const }],
  };
  const run = (executionRunId: string) => ({
    executionRunId, effectiveProfile: { profile, policy, fingerprint: 'a'.repeat(64) },
    versions: { node: '24', playwright: '1', browser: 'chromium' },
    outcomes: [{ ...record(lastStatus, executionRunId),
      ...(lastStatus === 'QA_ASSERTION_FAILED' ? { reason: 'NO_MATCH' }
        : lastStatus === 'LOCATOR_BINDING_FAILED' ? { reason: 'private selector text' } : {}) }],
  });
  return {
    testSpecId: 'local-1', executionProfileRef: ref, profileFingerprint: 'a'.repeat(64),
    presentationMode: 'headless', observation: {
      state: 'no_intervention', autonomousEligible: true, eventIds: [],
    },
    handoff: { kind: 'executed', testSpec, resolvedSpecId: 'resolved-1',
      attemptId: 'attempt-1', replay: [run('run-1'), run('run-2')] },
    report: { kind: 'available', artifactRoot: 'artifacts', testSpecId: 'local-1' },
  };
}

const input = (data: unknown) => Readable.from([Buffer.from(JSON.stringify(data))]);

test('P2-3B projects safe typed interpretation, QA, runtime and success outcomes', async () => {
  for (const [outcome, kind, exit] of [
    [stopped(), 'typed_stop', 2],
    [executed('QA_ASSERTION_PASSED'), 'success', 0],
    [executed('QA_ASSERTION_FAILED'), 'typed_stop', 1],
    [executed('LOCATOR_BINDING_FAILED'), 'typed_stop', 2],
  ] as const) {
    const events: LiveEvent[] = [];
    const result = await runSubprocessAdapter(input(request), async () => config, dependencies,
      { workflow: async () => outcome,
        events: new LiveEventProducer(randomUUID(), (event) => { events.push(event); }) });
    const wire = serializeSubprocessResponse(result);
    expect(wire.exitCode).toBe(exit);
    expect(wire.body).not.toContain('secret page text');
    expect(wire.body).not.toContain('private selector text');
    expect(wire.body).not.toContain('artifacts');
    expect(wire.body).not.toContain('Select Save.');
    expect(parseSubprocessResponse(wire.body).kind).toBe(kind);
    if (result.kind === 'bridge_error') throw new Error('Expected a typed engine result');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'terminal', data: {
      resultKind: result.kind, phase: result.terminal.phase, status: result.terminal.status,
    } });
    expect(JSON.stringify(events)).not.toContain('secret page text');
    expect(JSON.stringify(events)).not.toContain('private selector text');
    if (result.kind === 'typed_stop') {
      expect(result.terminal.reason).toBe(outcome.handoff.kind === 'stopped' ||
        result.terminal.status === 'LOCATOR_BINDING_FAILED' ? 'REDACTED_REASON' : 'NO_MATCH');
    }
  }
});

test('P2-3B rejects invalid framing and extra authority before trusted configuration or workflow', async () => {
  let configCalls = 0;
  let workflowCalls = 0;
  const options = { workflow: (async () => { workflowCalls++; return stopped(); }) as never };
  for (const data of [
    { ...request, request: { ...request.request, apiKey: 'private' } },
    { ...request, protocolVersion: '2' },
  ]) {
    const result = await runSubprocessAdapter(input(data), async () => {
      configCalls++; return config;
    }, dependencies, options);
    expect(result.kind).toBe('bridge_error');
    expect(serializeSubprocessResponse(result).exitCode).toBe(64);
  }
  const duplicate = Readable.from([Buffer.from(JSON.stringify(request) + JSON.stringify(request))]);
  expect((await runSubprocessAdapter(duplicate, async () => config, dependencies, options)).kind)
    .toBe('bridge_error');
  const huge = Readable.from([Buffer.alloc(65_537)]);
  const tooLarge = await runSubprocessAdapter(huge, async () => config, dependencies, options);
  expect(tooLarge).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'REQUEST_TOO_LARGE', cleanup: 'not_started' });
  expect(configCalls).toBe(0);
  expect(workflowCalls).toBe(0);
});

test('P2-3B propagates cancellation and reports uncertain cleanup after a started workflow', async () => {
  const controller = new AbortController();
  let cleaned = false;
  const running = runSubprocessAdapter(input(request), async () => config, dependencies, {
    signal: controller.signal,
    workflow: (async (_request: unknown, _config: unknown, _dependencies: unknown,
      options: LocalWorkflowOptions) => {
      try {
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      } finally { cleaned = true; }
      return stopped();
    }) as never,
  });
  setTimeout(() => controller.abort(), 20);
  expect(await running).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'CANCELLED', cleanup: 'unverified' });
  expect(cleaned).toBe(true);
});

test('P2-3B reports no started resources when destination approval denies the request', async () => {
  const denied = { ...request, request: {
    ...request.request, targetUrl: 'http://127.0.0.1:1/',
  } };
  const result = await runSubprocessAdapter(input(denied), async () => config, dependencies);
  expect(result).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'DESTINATION_DENIED', cleanup: 'not_started' });
  expect(serializeSubprocessResponse(result).exitCode).toBe(64);
});

async function child(args: string[], body: string, environment: Record<string, string> = {}):
  Promise<{ stdout: string; stderr: string; code: number | null }> {
  const subprocess = spawn(process.execPath, [path.join(process.cwd(), 'dist/subprocess/cli.js'), ...args], {
    cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: '', ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  subprocess.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  subprocess.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  subprocess.stdin.end(body);
  const [code] = await once(subprocess, 'close') as [number | null];
  return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code };
}

test('P2-3B built production child emits one protocol document and mapped exit without provider access', async () => {
  const compiler = spawn(process.execPath, [
    path.join(process.cwd(), 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json',
  ], { cwd: process.cwd(), stdio: 'ignore' });
  const [buildCode] = await once(compiler, 'close') as [number | null];
  expect(buildCode).toBe(0);
  const invalidArgs = await child([], JSON.stringify(request));
  expect(invalidArgs.code).toBe(64);
  expect(invalidArgs.stderr).toBe('');
  expect(JSON.parse(invalidArgs.stdout)).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
  expect(invalidArgs.stdout.trim().split('\n')).toHaveLength(1);
  const invalidRequest = await child(['--config', 'missing-config.json'],
    JSON.stringify({ ...request, request: { ...request.request, apiKey: 'private' } }));
  expect(invalidRequest.code).toBe(64);
  expect(invalidRequest.stderr).toBe('');
  expect(JSON.parse(invalidRequest.stdout)).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'PROTOCOL_INVALID', cleanup: 'not_started' });
  expect(invalidRequest.stdout.trim().split('\n')).toHaveLength(1);
  const missingConfig = await child(['--config', 'missing-config.json'], JSON.stringify(request));
  expect(missingConfig.code).toBe(64);
  expect(JSON.parse(missingConfig.stdout)).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
  const mockSwitch = await child(['--config', 'missing-config.json', '--mock-provider'],
    JSON.stringify(request));
  expect(mockSwitch.code).toBe(64);
  expect(JSON.parse(mockSwitch.stdout)).toEqual({ protocolVersion: '1', kind: 'bridge_error',
    code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
  const root = await mkdtemp(path.join(tmpdir(), 'qa-p2-3b-process-'));
  try {
    const file = path.join(root, 'trusted.json');
    await writeFile(file, JSON.stringify({ ...config, artifactRoot: path.join(root, 'artifacts') }));
    const withoutKey = await child(['--config', file], JSON.stringify(request));
    expect(withoutKey.code).toBe(2);
    expect(withoutKey.stderr).toBe('');
    const response = parseSubprocessResponse(withoutKey.stdout);
    expect(response.kind).toBe('typed_stop');
    if (response.kind === 'typed_stop') {
      expect(response.stopKind).toBe('automation_stop');
      expect(response.terminal.phase).toBe('interpretation');
      expect(response.terminal.status).toBe('INTERPRETATION_FAILED');
    }
    expect(withoutKey.stdout.trim().split('\n')).toHaveLength(1);
    expect(withoutKey.stdout).not.toContain('Select Save.');
    const diagnostic = await child(['--config', file], JSON.stringify(request),
      { PLAYWRIGHT_DEMO_UI_DIAGNOSTICS: '1' });
    expect(diagnostic.code).toBe(2);
    expect(parseSubprocessResponse(diagnostic.stdout).kind).toBe('typed_stop');
    const [line] = diagnostic.stderr.trim().split('\n');
    expect(diagnostic.stderr.trim().split('\n')).toHaveLength(1);
    expect(line).toMatch(/^PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC=/);
    expect(JSON.parse(line!.slice('PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC='.length)))
      .toMatchObject({ kind: 'provider_failure', stage: 'interpretation',
        code: 'PROVIDER_CONFIGURATION_ERROR', source: 'configuration' });
    expect(diagnostic.stderr).not.toContain('Select Save.');
    expect(diagnostic.stderr).not.toContain(file);
  } finally { await rm(root, { recursive: true, force: true }); }
});
