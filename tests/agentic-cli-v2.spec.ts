import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runAgenticSubprocessAdapterV2 } from '../app/subprocess/agentic-entry.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';

async function child(entry: string, config: string, request: unknown,
  raw = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  // These subprocess boundary cases are offline fixtures. An explicit empty
  // value prevents the child dotenv loader from inheriting a developer key.
  childEnv.OPENAI_API_KEY = '';
  const childProcess = spawn('node', [entry, '--config', config], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
  let stdout = '', stderr = '';
  childProcess.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  childProcess.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  childProcess.stdin.end(raw ? String(request) : `${JSON.stringify(request)}\n`);
  const [code] = await once(childProcess, 'close') as [number | null];
  return { code, stdout, stderr };
}

async function pythonHost(entry: string, projectionEntry: string, config: string,
  request: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = [
    'import json, sys',
    'from playwright_demo.host import call_node',
    'from playwright_demo.report_projection_v2 import call_report_projection',
    'wire = json.loads(sys.argv[4])',
    'run = call_node(wire, node_entry=sys.argv[1], config_path=sys.argv[3], protocol_version="2")',
    'report = call_report_projection(run.outcome, node_entry=sys.argv[2], config_path=sys.argv[3])',
    'print(json.dumps({"kind":run.outcome["kind"], "status":run.outcome["context"]["result"]["terminal"]["status"], "projection":report.outcome["kind"]}))',
  ].join('\n');
  const python = path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const processChild = spawn(python, ['-c', script, entry, projectionEntry, config,
    JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  processChild.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  processChild.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [code] = await once(processChild, 'close') as [number | null];
  return { code, stdout, stderr };
}

test('agentic v2 child completes a protected seven-goal task, projects only safe facts, and denies cross-version input', async () => {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const pages: Record<string, string> = {
      '/': '<a href="/status_codes">Status Codes</a>',
      '/status_codes': '<a href="/status_codes/200">200</a>',
      '/status_codes/200': '<p>To return, go <a href="/status_codes">here</a></p>',
    };
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(pages[route] ?? '<p>missing</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-cli-v2-'));
  const base = `http://127.0.0.1:${address.port}/`;
  const configPath = path.join(root, 'config.json');
  const config = { profiles: [{ id: 'agentic-cli-profile', version: '1', browser: 'chromium',
    viewport: { width: 900, height: 650 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 4000, navigationMs: 4000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'agentic-cli-policy', version: '1' } }],
    networkPolicies: [{ id: 'agentic-cli-policy', version: '1',
      destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }],
    artifactRoot: path.join(root, 'artifacts'), retentionDays: 7,
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false } };
  await writeFile(configPath, JSON.stringify(config));
  const task = 'Go to site. Click Status Codes. Confirm Status Codes URL. Click 200. Confirm 200 URL. Click here. Confirm return URL.';
  const wire = { protocolVersion: '2', request: { taskText: task, targetUrl: base,
    executionProfileRef: { id: 'agentic-cli-profile', version: '1' } } };
  try {
    const unusedDecisionModel = { complete: async () => { throw new Error('Decision model must not run'); } };
    const providerStop = await runAgenticLocalWorkflow(wire.request, config,
      { provider: { apiKey: () => undefined } }, {
        interpretationModel: { complete: async () => { throw new ModelCompletionFailure('PROVIDER_ERROR'); } },
        decisionModel: unusedDecisionModel,
      });
    expect(providerStop).toMatchObject({ kind: 'typed_stop', stopKind: 'environment_stop',
      context: { result: { terminal: { stage: 'environment', status: 'ENVIRONMENT_FAILED',
        reason: 'PROVIDER_ERROR' }, cleanup: 'not_started' }, report: { kind: 'unavailable' } } });
    const invalidOutput = await runAgenticLocalWorkflow(wire.request, config,
      { provider: { apiKey: () => undefined } }, {
        interpretationModel: { complete: async () => '{invalid' },
        decisionModel: unusedDecisionModel,
      });
    expect(invalidOutput).toMatchObject({ kind: 'typed_stop', stopKind: 'automation_stop',
      context: { result: { terminal: { stage: 'interpretation', status: 'INTERPRETATION_FAILED',
        reason: 'MALFORMED_MODEL_OUTPUT' } } } });
    const entry = path.resolve('dist/subprocess/agentic-test-harness.js');
    const result = await child(entry, configPath, wire);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
    const response = JSON.parse(result.stdout) as { kind: string; context: { result: { terminal: { status: string } } } };
    expect(response.kind, result.stdout).toBe('success');
    expect(response.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');
    expect(result.code).toBe(0);
    const projection = await child(path.resolve('dist/subprocess/report-projection-v2-cli.js'),
      configPath, { reportProjectionVersion: '2', result: response });
    const report = JSON.parse(projection.stdout) as { kind: string; reportProjectionVersion: string;
      successfulTraceId?: string; executionRunIds?: string[] };
    expect(report.kind, projection.stdout).toBe('available');
    expect(report.reportProjectionVersion).toBe('2');
    expect(report.executionRunIds).toHaveLength(2);
    expect(projection.stdout).not.toContain('successfulPath');
    expect(projection.stdout).not.toContain('framePath');
    const python = await pythonHost(entry, path.resolve('dist/subprocess/report-projection-v2-cli.js'),
      configPath, wire);
    expect(python.code, python.stderr).toBe(0);
    expect(JSON.parse(python.stdout)).toMatchObject({ kind: 'success',
      status: 'QA_ASSERTION_PASSED', projection: 'available' });
    const denied = await child(path.resolve('dist/subprocess/agentic-cli.js'), configPath,
      { ...wire, protocolVersion: '1' });
    expect(JSON.parse(denied.stdout)).toMatchObject({ protocolVersion: '2', kind: 'bridge_error',
      code: 'PROTOCOL_UNSUPPORTED_VERSION' });
    expect(denied.code).toBe(64);
    const deniedLegacy = await child(path.resolve('dist/subprocess/cli.js'), configPath, wire);
    expect(JSON.parse(deniedLegacy.stdout)).toMatchObject({ protocolVersion: '1',
      kind: 'bridge_error', code: 'PROTOCOL_UNSUPPORTED_VERSION' });
    const malformed = await child(path.resolve('dist/subprocess/agentic-cli.js'),
      configPath, '{broken', true);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ protocolVersion: '2',
      kind: 'bridge_error', code: 'PROTOCOL_INVALID' });
    const oversized = await child(path.resolve('dist/subprocess/agentic-cli.js'),
      configPath, 'x'.repeat(65_537), true);
    expect(JSON.parse(oversized.stdout)).toMatchObject({ protocolVersion: '2',
      kind: 'bridge_error', code: 'REQUEST_TOO_LARGE' });
    const wrongProjection = await child(path.resolve('dist/subprocess/report-projection-v2-cli.js'),
      configPath, { reportProjectionVersion: '1', result: response });
    expect(JSON.parse(wrongProjection.stdout)).toMatchObject({ reportProjectionVersion: '2',
      kind: 'unavailable', reason: 'INVALID_REQUEST' });
    const early = await child(path.resolve('dist/subprocess/report-projection-v2-cli.js'),
      configPath, { reportProjectionVersion: '2', result: {
        ...response, context: { ...response.context, report: { kind: 'unavailable' } },
      } });
    expect(JSON.parse(early.stdout)).toMatchObject({ reportProjectionVersion: '2',
      kind: 'unavailable', reason: 'REPORT_UNAVAILABLE' });
    const noCredential = await child(path.resolve('dist/subprocess/agentic-cli.js'), configPath, wire);
    const noCredentialResponse = JSON.parse(noCredential.stdout) as { protocolVersion: string; kind: string;
      context?: { result: { terminal: { stage: string } } } };
    expect(noCredentialResponse.protocolVersion).toBe('2');
    expect(noCredentialResponse.kind).toBe('bridge_error');
    expect(noCredentialResponse.context?.result.terminal.stage).not.toBe('qa');
    expect(noCredential.stdout.trim().split('\n')).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('agentic v2 adapter rejects an already cancelled launch before config or browser access', async () => {
  const controller = new AbortController();
  controller.abort();
  let configReads = 0;
  const result = await runAgenticSubprocessAdapterV2(Readable.from([]), async () => {
    configReads++; return {};
  }, { provider: { apiKey: () => undefined } }, { signal: controller.signal });
  expect(result).toEqual({ protocolVersion: '2', kind: 'bridge_error', code: 'CANCELLED',
    cleanup: 'not_started' });
  expect(configReads).toBe(0);
});
