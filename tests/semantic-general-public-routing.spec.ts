import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { parseActivePocTrustedConfiguration, selectActivePocBrowserProfile } from '../app/local/contracts.js';
import { SemanticExplorationDiagnosticsV1Store } from '../app/evidence/semantic-exploration-diagnostics-v1.js';

async function child(entry: string, config: string, wire: unknown, env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: '' };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]; else childEnv[key] = value;
  }
  const run = spawn('node', [entry, '--config', config], { windowsHide: true,
    env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  run.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  run.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  run.stdin.end(`${JSON.stringify(wire)}\n`);
  const [code] = await once(run, 'close') as [number];
  return { code, stdout, stderr };
}

test('closed Node selector rejects missing gate and unknown workflow before provider/browser', async () => {
  const entry = path.resolve('dist/subprocess/agentic-cli.js');
  const wire = { protocolVersion: '2', request: { taskText: 'Offline', targetUrl: 'http://127.0.0.1/',
    executionProfileRef: { id: 'desktop', version: '1' } } };
  for (const env of [
    { PLAYWRIGHT_DEMO_WORKFLOW_VERSION: 'semantic-general-v1', PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE: '' },
    { PLAYWRIGHT_DEMO_WORKFLOW_VERSION: 'unknown-workflow', PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE: 'offline-review' },
  ]) {
    const result = await child(entry, 'unused-config', wire, env);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ protocolVersion: '2', kind: 'bridge_error',
      code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
    expect(result.code).toBe(64);
  }
});

test('Python UI host launches gated v7 to v10 route and renders two fresh offline QA passes', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<input type="checkbox"><input type="checkbox" checked>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const rootUrl = `http://127.0.0.1:${address.port}/`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-public-routing-'));
  const configPath = path.join(root, 'config.json');
  const config = { profiles: [{ id: 'desktop', version: '1', profileSchemaVersion: '3',
    browserIsolation: 'docker', presentationMode: 'headless', browser: 'chromium',
    viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 3000, waits: { default: 2000 } },
    networkPolicyRef: { id: 'fixture', version: '1' } }],
    networkPolicies: [{ id: 'fixture', version: '1', destinations: [{ host: '127.0.0.1',
      ports: [address.port], addresses: ['127.0.0.1'] }] }],
    artifactRoot: path.join(root, 'artifacts'), retentionDays: 7,
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false } };
  await writeFile(configPath, JSON.stringify(config));
  const selected = selectActivePocBrowserProfile(parseActivePocTrustedConfiguration(config), 'local-windows');
  const wire = { protocolVersion: '2', request: { taskText: 'Offline checkbox test', targetUrl: rootUrl,
    executionProfileRef: selected.reference } };
  const selectedCli = await child(path.resolve('dist/subprocess/agentic-cli.js'), configPath, wire, {
    PLAYWRIGHT_DEMO_WORKFLOW_VERSION: 'semantic-general-v1',
    PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE: 'offline-review',
    PLAYWRIGHT_DEMO_BROWSER_BACKEND: 'local-windows', PLAYWRIGHT_DEMO_LIVE_VIEW: '0',
  });
  expect(JSON.parse(selectedCli.stdout)).toMatchObject({ kind: 'bridge_error',
    code: 'PROVIDER_CONFIGURATION_ERROR', cleanup: 'not_started' });
  const defaultCli = await child(path.resolve('dist/subprocess/agentic-cli.js'), configPath,
    { ...wire, request: { ...wire.request, executionProfileRef: { id: 'desktop', version: '1' } } }, {
    PLAYWRIGHT_DEMO_WORKFLOW_VERSION: undefined, PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE: undefined,
    PLAYWRIGHT_DEMO_BROWSER_BACKEND: 'local-windows', PLAYWRIGHT_DEMO_LIVE_VIEW: '0',
  });
  expect(JSON.parse(defaultCli.stdout)).toMatchObject({ kind: 'bridge_error',
    code: 'PROVIDER_CONFIGURATION_ERROR', cleanup: 'not_started' });
  const deferredCli = await child(path.resolve('dist/subprocess/agentic-cli.js'), configPath, wire, {
    PLAYWRIGHT_DEMO_WORKFLOW_VERSION: 'deferred-action-v1',
    PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE: 'offline-review',
    PLAYWRIGHT_DEMO_BROWSER_BACKEND: 'local-windows', PLAYWRIGHT_DEMO_LIVE_VIEW: '0',
  });
  expect(JSON.parse(deferredCli.stdout)).toMatchObject({ kind: 'bridge_error',
    code: 'PROVIDER_CONFIGURATION_ERROR', cleanup: 'not_started' });
  const alias = path.join(root, 'ui-build', 'dist', 'subprocess');
  await mkdir(alias, { recursive: true });
  await writeFile(path.join(alias, 'agentic-cli.js'),
    `import ${JSON.stringify(new URL(`file:///${path.resolve('dist/subprocess/semantic-general-test-harness.js').replaceAll('\\', '/')}`).href)};\n`);
  await writeFile(path.join(alias, 'report-projection-v2-cli.js'), '');
  await mkdir(path.join(root, 'ui-build', 'dist', 'profile'), { recursive: true });
  await writeFile(path.join(root, 'ui-build', 'dist', 'profile', 'admission-cli.js'), '');
  const script = [
    'import json,sys',
    'from unittest.mock import patch',
    'from playwright_demo.ui_shell import UiRequest',
    'from playwright_demo.ui_workflow import run_ui_workflow',
    'ref=json.loads(sys.argv[4]); fingerprint=sys.argv[5]',
    'approval={"kind":"approved","admissionVersion":"1","canonicalUrl":sys.argv[3],"executionProfileRef":ref,"profileFingerprint":fingerprint}',
    'with patch("playwright_demo.ui_workflow.lookup_public_admission",return_value=approval):',
    '  result=run_ui_workflow(UiRequest(sys.argv[3],"Go to site. Check checkbox 1. Verify checkbox 1 is checked."),config_path=sys.argv[1],build_root=__import__("pathlib").Path(sys.argv[2]),workflow_version="semantic-general-v1")',
    'out=result.outcome',
    'print(json.dumps({"uiKind":result.kind,"workflow":result.workflow_version,"wireKind":out["kind"],"record":out.get("context",{}).get("result"),"projection":result.projection}))',
  ].join('\n');
  const python = path.resolve('.venv/Scripts/python.exe');
  const run = spawn(python, ['-c', script, configPath, path.join(root, 'ui-build'), rootUrl,
    JSON.stringify(selected.reference), selected.fingerprint], { windowsHide: true,
    env: { ...process.env, OPENAI_API_KEY: '', PLAYWRIGHT_DEMO_WORKFLOW_VERSION: 'semantic-general-v1',
      PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE: 'offline-review',
      PLAYWRIGHT_DEMO_BROWSER_BACKEND: 'local-windows', PLAYWRIGHT_DEMO_LIVE_VIEW: '0',
      PYTHONPATH: path.resolve('src') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  run.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  run.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  try {
    const [code] = await once(run, 'close') as [number];
    expect(code, stderr).toBe(0);
    const value = JSON.parse(stdout) as { uiKind: string; workflow: string; wireKind: string;
      record: { testSpecId: string; successfulTraceId: string; compilerAttemptId: string;
        resolvedSpecId: string; executionRunIds: string[]; terminal: { status: string };
        semanticReplay: { sourceSchemaVersion: string; sourceContractVersion: string;
          groundingVersion: string; compilerVersion: string; resolvedSchemaVersion: string;
          runnerVersion: string; replayPairVersion: string; executionSessionIds: string[] } } };
    expect(value).toMatchObject({ uiKind: 'engine', workflow: 'semantic-general-v1', wireKind: 'success',
      record: { terminal: { status: 'QA_ASSERTION_PASSED' } } });
    expect(value.record.successfulTraceId).toMatch(/^semantic-trace-/);
    expect(value.record.compilerAttemptId).toMatch(/^semantic-compiler-/);
    expect(value.record.resolvedSpecId).toMatch(/^semantic-resolved-/);
    expect(value.record.executionRunIds).toHaveLength(2);
    expect(new Set(value.record.executionRunIds).size).toBe(2);
    expect(value.record.semanticReplay).toMatchObject({ sourceSchemaVersion: '7',
      sourceContractVersion: '3', groundingVersion: 'semantic_capability_discovery_v1',
      compilerVersion: '5', resolvedSchemaVersion: '10', runnerVersion: '10',
      replayPairVersion: '2' });
    expect(new Set(value.record.semanticReplay.executionSessionIds).size).toBe(2);
    const exploration = await new SemanticExplorationDiagnosticsV1Store(config.artifactRoot)
      .readByCorrelation({ testSpecId: value.record.testSpecId });
    expect(exploration).toHaveLength(1);
    expect(exploration[0]?.firstFailure).toBeNull();
    expect(exploration[0]?.successfulTraceId).toBe(value.record.successfulTraceId);
    expect(exploration[0]?.milestones.map(item => item.boundary)).toEqual(
      expect.arrayContaining(['attempt_created', 'browser_launch_started', 'browser_launch_completed',
        'context_create_completed', 'page_create_started', 'page_create_completed', 'root_navigation_returned',
        'grounding_session_initialized', 'step_grounded', 'action_dispatch_completed',
        'action_effect_completed', 'verification_observation_completed', 'trace_issued',
        'cleanup_completed']));
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
