import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SemanticPrimaryOutputDiagnosticsV1Store } from
  '../app/evidence/semantic-primary-output-diagnostics-v1.js';
import { createOpenAISemanticIntentModelsV3 } from '../app/interpretation/semantic-intent-v3-adapters.js';
import { interpretSemanticIntentV3 } from '../app/interpretation/semantic-intent-v3.js';
import { interpretSemanticIntentWithEvidenceV3, SemanticPrimaryDiagnosticPersistenceFailureV1 } from
  '../app/interpretation/semantic-intent-v3-boundary.js';
import { prepareSemanticGroundingFixtureInterpretationV1 } from
  '../app/interpretation/semantic-grounding-fixture-preparation-v1.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';
import { parseProductTrustedConfiguration } from '../app/local/product-contracts.js';
import { runSemanticGeneralLocalWorkflowV1 } from '../app/local/semantic-general-workflow.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';

const source = { testSpecId: 'primary-diagnostic-fixture', sourceInstruction: 'Go to https://example.com/',
  executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
const envelope = (text: string) => new Response(JSON.stringify({ id: 'resp_fixture', status: 'completed',
  error: null, incomplete_details: null, output: [{ type: 'message', status: 'completed',
    role: 'assistant', content: [{ type: 'output_text', text }] }] }), { status: 200 });
const models = (response: Response) => createOpenAISemanticIntentModelsV3({ apiKey: () => 'fixture-only',
  fetchImpl: (async () => response) as typeof fetch });

test('primary extraction retains closed envelope, JSON and schema causes without changing public stop', async () => {
  const cases: Array<{ label: string; response: Response; predicate: string;
    status?: string; family?: string }> = [
    { label: 'empty output', response: new Response(JSON.stringify({ status: 'completed', output: [] })),
      predicate: 'STRUCTURED_OUTPUT_MISSING' },
    { label: 'output not array', response: new Response(JSON.stringify({ status: 'completed',
      output: null })), predicate: 'STRUCTURED_OUTPUT_MISSING' },
    { label: 'unexpected tool output', response: new Response(JSON.stringify({ status: 'completed',
      output: [{ type: 'function_call' }] })), predicate: 'STRUCTURED_OUTPUT_MISSING' },
    { label: 'malformed message', response: new Response(JSON.stringify({ status: 'completed',
      output: [{ type: 'message', status: 'completed', role: 'user', content: [] }] })),
    predicate: 'OUTPUT_MESSAGE_SHAPE_INVALID' },
    { label: 'multiple content parts', response: new Response(JSON.stringify({ status: 'completed',
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [
        { type: 'output_text', text: '{}' }, { type: 'output_text', text: '{}' }] }] })),
    predicate: 'OUTPUT_CONTENT_SHAPE_INVALID' },
    { label: 'missing text', response: new Response(JSON.stringify({ status: 'completed',
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [
        { type: 'output_text' }] }] })), predicate: 'STRUCTURED_OUTPUT_MISSING' },
    { label: 'invalid response JSON', response: new Response('{'), predicate: 'JSON_PARSE_FAILED',
      status: 'unavailable' },
    { label: 'invalid output JSON', response: envelope('{'), predicate: 'JSON_PARSE_FAILED' },
    { label: 'response object absent', response: envelope('{}'),
      predicate: 'RESPONSE_FORMAT_MISMATCH' },
    { label: 'missing required field', response: envelope(JSON.stringify({ response: {
      kind: 'extraction' } })), predicate: 'WIRE_SCHEMA_REQUIRED_FIELD_MISSING', family: 'steps' },
    { label: 'wrong field type', response: envelope(JSON.stringify({ response: {
      kind: 'extraction', steps: 'bad' } })), predicate: 'WIRE_SCHEMA_TYPE_MISMATCH', family: 'steps' },
    { label: 'invalid enum', response: envelope(JSON.stringify({ response: { kind: 'invalid' } })),
      predicate: 'WIRE_SCHEMA_ENUM_INVALID' },
    { label: 'unsupported field', response: envelope(JSON.stringify({ response: {
      kind: 'unresolved', reasonCode: 'unclear_effect', extra: 'private' } })),
    predicate: 'WIRE_SCHEMA_SHAPE_INVALID' },
    { label: 'refusal', response: new Response(JSON.stringify({ status: 'completed', output: [{
      type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal',
        refusal: 'private' }] }] })), predicate: 'PROVIDER_REFUSAL' },
    { label: 'incomplete', response: new Response(JSON.stringify({ status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }, output: [] })),
    predicate: 'RESPONSE_INCOMPLETE', status: 'incomplete' },
  ];
  for (const item of cases) {
    const result = await interpretSemanticIntentV3(source, models(item.response));
    expect(result, item.label).toMatchObject({ kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID',
      primaryOutputDiagnostic: { predicate: item.predicate,
        ...(item.status ? { responseStatus: item.status } : {}),
        ...(item.family ? { fieldFamily: item.family } : {}) } });
    if (result.kind !== 'rejected') continue;
    const diagnostic = result.primaryOutputDiagnostic;
    expect(diagnostic?.providerCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(diagnostic?.model).toBe('gpt-5.6-terra');
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|fixture-only|sourceInstruction|Go to/);
  }
});

test('valid structured primary response still reaches the existing unresolved branch', async () => {
  const result = await interpretSemanticIntentV3(source, models(envelope(JSON.stringify({ response: {
    kind: 'unresolved', reasonCode: 'unclear_effect' } }))));
  expect(result).toEqual({ kind: 'rejected', code: 'SEMANTIC_INTERPRETATION_UNRESOLVED' });
});

test('shared entrypoint persists completed invalid output under the reported source ID', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-primary-shared-'));
  try {
    const result = await interpretSemanticIntentWithEvidenceV3(source, models(envelope('{')), artifactRoot);
    expect(result).toMatchObject({ kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID' });
    const stored = await new SemanticPrimaryOutputDiagnosticsV1Store(artifactRoot)
      .readByCorrelation({ testSpecId: source.testSpecId });
    expect(stored).toMatchObject([{ testSpecId: source.testSpecId, diagnostic: {
      phase: 'output_text', predicate: 'JSON_PARSE_FAILED' } }]);
  } finally { await rm(artifactRoot, { recursive: true, force: true }); }
});

test('untyped and typed provider exceptions are non-output failures with no primary diagnostic', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-primary-errors-'));
  const reviewer = { complete: async () => { throw new Error('Reviewer must not run'); } };
  try {
    const cases = [
      { primary: { complete: async () => { throw new Error('private'); } }, code: 'MODEL_ERROR' },
      { primary: { complete: async () => { throw new ModelCompletionFailure('PROVIDER_ERROR'); } },
        code: 'PROVIDER_ERROR' },
      { primary: { complete: async () => { throw new ModelCompletionFailure('PROVIDER_TIMEOUT'); } },
        code: 'PROVIDER_TIMEOUT' },
      { primary: { complete: async () => { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); } },
        code: 'MODEL_ERROR' },
    ];
    for (const item of cases) {
      expect(await interpretSemanticIntentWithEvidenceV3(source, {
        primary: item.primary, reviewer }, artifactRoot)).toEqual({ kind: 'rejected', code: item.code });
      expect(await readdir(artifactRoot)).toEqual([]);
    }
  } finally { await rm(artifactRoot, { recursive: true, force: true }); }
});

test('malformed completed fidelity-review output retains malformed-output classification without primary evidence', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-reviewer-output-'));
  const validPrimary = JSON.stringify({ response: { kind: 'extraction', steps: [{ id: 's1',
    type: 'navigate', authoredText: 'Go to https://example.com/', url: 'https://example.com/',
    dependsOnStepId: null }] } });
  try {
    for (const reviewer of [
      { complete: async () => '{' },
      { complete: async () => { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); } },
    ]) {
      const result = await interpretSemanticIntentWithEvidenceV3(source, {
        primary: { complete: async () => validPrimary }, reviewer }, artifactRoot);
      expect(result).toEqual({ kind: 'rejected', code: 'REVIEWER_OUTPUT_INVALID' });
      expect(await readdir(artifactRoot)).toEqual([]);
    }
  } finally { await rm(artifactRoot, { recursive: true, force: true }); }
});

test('diagnostic persistence failure cannot return output-invalid', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-primary-write-'));
  const blocked = path.join(artifactRoot, 'not-a-directory');
  await writeFile(blocked, 'fixture');
  try {
    await expect(interpretSemanticIntentWithEvidenceV3(source, models(envelope('{')), blocked))
      .rejects.toBeInstanceOf(SemanticPrimaryDiagnosticPersistenceFailureV1);
  } finally { await rm(artifactRoot, { recursive: true, force: true }); }
});

test('fixture script uses the shared production boundary and explicit artifact root', async () => {
  const script = await readFile(path.join(process.cwd(),
    'tools/experiments/semantic/grounding/semantic-grounding-v1-stability-experiment.mjs'), 'utf8');
  expect(script).toContain("importProduct('interpretation/semantic-grounding-fixture-preparation-v1.js')");
  expect(script).toMatch(/prepareSemanticGroundingFixtureInterpretationV1\(source,\s*measuredModels, artifactRoot/);
});

test('local workflow keeps provider failures and diagnostic-store failures out of interpretation stops', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-local-primary-'));
  const blockedRoot = path.join(artifactRoot, 'blocked');
  await writeFile(blockedRoot, 'fixture');
  const configFor = (root: string) => parseProductTrustedConfiguration({
    profiles: [{ id: 'desktop', version: '1', profileSchemaVersion: '5', browserIsolation: 'local-windows',
      browserRuntime: 'playwright-chromium-windows',
      presentationMode: 'headless', browser: 'chromium', viewport: { width: 900, height: 600 },
      locale: 'en-US', timeoutPolicy: { actionMs: 3000, navigationMs: 3000,
        waits: { default: 2000 } } }],
    artifactRoot: root, retentionDays: 7,
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false },
  });
  const run = async (root: string, primary: { complete: () => Promise<string> },
    reviewer: { complete: () => Promise<string> } =
      { complete: async () => { throw new Error('Reviewer must not run'); } }) => {
    const config = configFor(root);
    return runSemanticGeneralLocalWorkflowV1({ taskText: source.sourceInstruction,
      targetUrl: 'https://example.com/', executionProfileRef: source.executionProfileRef }, config,
    new NativeProfileCatalog(config.profiles),
    { provider: { apiKey: () => undefined } }, { semanticModels: {
      primary, reviewer,
    } });
  };
  try {
    const provider = await run(artifactRoot, { complete: async () => {
      throw new ModelCompletionFailure('PROVIDER_ERROR'); } });
    expect(provider).toMatchObject({ kind: 'typed_stop', context: { result: { terminal: {
      stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'PROVIDER_ERROR' } } } });
    const storage = await run(blockedRoot, { complete: async () => '{' });
    expect(storage).toMatchObject({ kind: 'typed_stop', context: { result: { terminal: {
      stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'REDACTED_REASON' } } } });
    const reviewer = await run(artifactRoot, { complete: async () => JSON.stringify({ response: {
      kind: 'extraction', steps: [{ id: 's1', type: 'navigate',
        authoredText: 'Go to https://example.com/', url: 'https://example.com/',
        dependsOnStepId: null }] } }) }, { complete: async () => '{' });
    expect(reviewer).toMatchObject({ kind: 'typed_stop', context: { result: { terminal: {
      stage: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'MALFORMED_MODEL_OUTPUT',
    } } } });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test('local route stores authenticated private primary diagnostics and preserves public mapping', async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-primary-diag-'));
  try {
    const config = parseProductTrustedConfiguration({
      profiles: [{ id: 'desktop', version: '1', profileSchemaVersion: '5', browserIsolation: 'local-windows',
        browserRuntime: 'playwright-chromium-windows',
        presentationMode: 'headless', browser: 'chromium', viewport: { width: 900, height: 600 },
        locale: 'en-US', timeoutPolicy: { actionMs: 3000, navigationMs: 3000,
          waits: { default: 2000 } } }],
      artifactRoot, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
        failureVideo: false, sensitiveBinaryApproved: false },
    });
    const response = await runSemanticGeneralLocalWorkflowV1({ taskText: source.sourceInstruction,
      targetUrl: 'https://example.com/', executionProfileRef: source.executionProfileRef }, config,
    new NativeProfileCatalog(config.profiles),
    { provider: { apiKey: () => undefined } }, { semanticModels: models(envelope('{')) });
    expect(response).toMatchObject({ kind: 'typed_stop', context: { result: { terminal: {
      stage: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'MALFORMED_MODEL_OUTPUT',
    }, cleanup: 'not_started' } } });
    expect(JSON.stringify(response)).not.toMatch(/JSON_PARSE_FAILED|primaryOutputDiagnostic/);
    if (response.kind !== 'typed_stop') throw new Error('Expected typed stop');
    const testSpecId = response.context.result.testSpecId;
    const store = new SemanticPrimaryOutputDiagnosticsV1Store(artifactRoot);
    const productionRecord = await store.readByCorrelation({ testSpecId });
    expect(productionRecord).toMatchObject([{ testSpecId,
      publicCode: 'PROVIDER_OUTPUT_INVALID', diagnostic: { phase: 'output_text',
        predicate: 'JSON_PARSE_FAILED', fieldFamily: 'response' } }]);
    const fixtureSource = { ...source, testSpecId: 'fixture-preparation-correlation' };
    const fixtureResult = await prepareSemanticGroundingFixtureInterpretationV1(fixtureSource,
      models(envelope('{')), artifactRoot, new AbortController().signal);
    expect(fixtureResult).toMatchObject({ kind: 'rejected', code: 'PROVIDER_OUTPUT_INVALID',
      primaryOutputDiagnostic: { phase: 'output_text', predicate: 'JSON_PARSE_FAILED' } });
    const fixtureRecord = await store.readByCorrelation({ testSpecId: fixtureSource.testSpecId });
    expect(fixtureRecord).toMatchObject([{ testSpecId: fixtureSource.testSpecId,
      publicCode: 'PROVIDER_OUTPUT_INVALID', diagnostic: { phase: 'output_text',
        predicate: 'JSON_PARSE_FAILED', fieldFamily: 'response' } }]);
    expect(fixtureRecord[0]?.diagnostic.predicate).toBe(productionRecord[0]?.diagnostic.predicate);
    expect(fixtureRecord[0]?.diagnostic.phase).toBe(productionRecord[0]?.diagnostic.phase);
    expect(fixtureRecord[0]?.diagnostic.responseStatus).toBe(productionRecord[0]?.diagnostic.responseStatus);
    expect(fixtureRecord[0]?.diagnostic.providerCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(productionRecord[0]?.diagnostic.providerCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixtureRecord[0]?.diagnostic.providerCallId)
      .not.toBe(productionRecord[0]?.diagnostic.providerCallId);
    const fixtureFile = path.join(artifactRoot, 'semantic-primary-output-diagnostics-v1',
      `${fixtureSource.testSpecId}.json`);
    expect(JSON.parse(await readFile(fixtureFile, 'utf8'))).toMatchObject({
      data: { testSpecId: fixtureSource.testSpecId }, authentication: expect.any(String),
    });
    const file = path.join(artifactRoot, 'semantic-primary-output-diagnostics-v1', `${testSpecId}.json`);
    const record = JSON.parse(await readFile(file, 'utf8')) as { data: { diagnostic: {
      predicate: string } }; authentication: string };
    record.data.diagnostic.predicate = 'RESPONSE_FORMAT_MISMATCH';
    await writeFile(file, JSON.stringify(record));
    await expect(store.readByCorrelation({ testSpecId })).rejects.toThrow(
      'INVALID_SEMANTIC_PRIMARY_OUTPUT_DIAGNOSTIC_AUTHENTICATION');
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
