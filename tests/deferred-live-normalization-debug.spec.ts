import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { interpretDeferredActionTaskV2, projectActionSemanticStopV2 } from '../app/interpretation/deferred-action-v2-interpret.js';
import { normalizePrimaryActionExtractionV6Wire, PrimaryActionExtractionV6WireSchema } from '../app/interpretation/deferred-action-v2-wire.js';
import { parseTestSpecV6V2 } from '../app/domain/test-spec-v6-v2.js';
import { unspannedDecision, unspannedWire } from './helpers/deferred-v3-wire.js';
import { choose, spec } from './helpers/action-v2-fixtures.js';

const debugRoot = resolve('artifacts', 'live-debug');
const testModel = `local-test-model-${randomUUID()}`;
const debugTestSpecId = `local-debug-${randomUUID()}`;
const envNames = ['PLAYWRIGHT_DEMO_LIVE_LLM_TESTS', 'PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG'] as const;

function dirs(): string[] {
  try { return readdirSync(debugRoot); } catch { return []; }
}

async function withGates<T>(live: string | undefined, debug: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = envNames.map((name) => process.env[name]);
  if (live === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS;
  else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS = live;
  if (debug === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG;
  else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG = debug;
  try { return await fn(); }
  finally {
    for (const [i, name] of envNames.entries()) {
      if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i];
    }
  }
}

function newArtifacts(before: string[]): string[] {
  return dirs().filter((name) => !before.includes(name)).map((name) => resolve(debugRoot, name)).filter((path) => {
    try {
      const metadata = JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')) as { model?: unknown; testSpecId?: unknown };
      return metadata.model === testModel || metadata.testSpecId === debugTestSpecId;
    } catch { return false; }
  });
}

function removeTestArtifacts(paths: string[]): void {
  for (const path of paths) {
    if (!path.startsWith(`${debugRoot}${sep}`)) throw new Error('Unexpected debug artifact path');
    const metadata = JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')) as { model?: unknown; testSpecId?: unknown };
    if (metadata.model !== testModel && metadata.testSpecId !== debugTestSpecId)
      throw new Error('Refusing to remove another run\'s artifact');
    rmSync(path, { recursive: true, force: true });
  }
}

function providerBody(output: string): Response {
  return new Response(JSON.stringify({ status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: output }] }] }));
}

function models(output: string, independentOutput = output) {
  const config = (body: string) => ({ apiKey: () => 'test-api-key-never-persist',
    model: testModel, fetchImpl: (async (_url: unknown, init: RequestInit | undefined) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key-never-persist');
      return providerBody(body);
    }) as typeof fetch });
  return createOpenAIActionSemanticExtractionModelsV2(config(output), config(independentOutput));
}

const malformedWire = { response: { kind: 'extraction', steps: [{ type: 'impossible' }], instructionAccounting: [] } };

test.describe.configure({ mode: 'serial' });

test('raw provider wire stays absent with debug flag absent or only live gate enabled', async () => {
  const before = dirs();
  try {
    for (const [live, debug] of [[undefined, undefined], ['1', undefined], [undefined, '1']] as const) {
      await withGates(live, debug, async () => {
        await expect(models(JSON.stringify(malformedWire)).primary.complete({ systemInstruction: 'test',
          userInstruction: 'Choose Option 1.', signal: new AbortController().signal }))
          .rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
      });
      expect(newArtifacts(before)).toEqual([]);
    }
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('successful extraction writes parsed wire and outcome only with both gates', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const output = await withGates('1', '1', () => models(JSON.stringify(unspannedWire(draft, 'primary')))
      .primary.complete({ systemInstruction: 'test', userInstruction: draft.sourceInstruction,
        signal: new AbortController().signal }));
    expect(JSON.parse(output).kind).toBe('extraction');
    const [path] = newArtifacts(before);
    expect(path).toBeTruthy();
    expect(JSON.parse(readFileSync(resolve(path!, 'provider-wire.json'), 'utf8'))).toEqual(unspannedWire(draft, 'primary'));
    expect(JSON.parse(readFileSync(resolve(path!, 'metadata.json'), 'utf8'))).toMatchObject({
      phase: 'primary', normalizedOutcomeKind: 'extraction', model: testModel,
      responseFormat: 'qa_deferred_action_interpretation_v10', providerCompletionState: 'completed',
    });
    expect(newArtifacts(before)).toHaveLength(1);
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('parsed successful extraction remains private unless both gates are enabled', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const wire = JSON.stringify(unspannedWire(draft, 'primary'));
    for (const [live, debug] of [[undefined, undefined], ['1', undefined], [undefined, '1']] as const) {
      const output = await withGates(live, debug, () => models(wire).primary.complete({ systemInstruction: 'test',
        userInstruction: draft.sourceInstruction, signal: new AbortController().signal }));
      expect(JSON.parse(output).kind).toBe('extraction');
      expect(newArtifacts(before)).toEqual([]);
    }
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('numbered navigation derives list framing while marker-inclusive clause accounting rejects', () => {
  const sourceInstruction = '1. Go to https://example.com/';
  const wire = { response: { kind: 'extraction', steps: [{ id: 's1', type: 'navigate', url: 'https://example.com/',
    sourceText: 'Go to https://example.com/' }], instructionAccounting: [{ classification: 'clause' }] } };
  const normalized = JSON.parse(normalizePrimaryActionExtractionV6Wire(wire, sourceInstruction)) as {
    steps: { sourceText: string; sourceInstructionSpan: { start: number; end: number } }[];
    instructionAccounting: unknown[];
  };
  expect(normalized.steps[0]?.sourceText).toBe('Go to https://example.com/');
  expect(normalized.instructionAccounting).toMatchObject([
    { classification: 'neutral', authoredText: '1. ' },
    { classification: 'clause', authoredText: 'Go to https://example.com/' },
  ]);
  expect(() => parseTestSpecV6V2({ schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'numbered-nav',
    sourceInstruction, executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' },
    steps: normalized.steps, instructionAccounting: normalized.instructionAccounting })).not.toThrow();
  const included = structuredClone(wire);
  (included.response.instructionAccounting[0] as { authoredText?: string }).authoredText = sourceInstruction;
  expect(() => normalizePrimaryActionExtractionV6Wire(included, sourceInstruction)).toThrow();
});

test('accepted full interpretation persists only a bounded admission decision', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const input = { testSpecId: debugTestSpecId, sourceInstruction: draft.sourceInstruction,
      executionProfileRef: draft.executionProfileRef, startState: draft.startState };
    const outcome = await withGates('1', '1', () => interpretDeferredActionTaskV2(input,
      models(JSON.stringify(unspannedWire(draft, 'primary')), JSON.stringify(unspannedWire(draft, 'independent')))));
    expect(outcome.kind).toBe('accepted');
    const artifacts = newArtifacts(before);
    expect(artifacts).toHaveLength(3);
    const admissionPath = artifacts.find((path) =>
      JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')).phase === 'admission');
    expect(JSON.parse(readFileSync(resolve(admissionPath!, 'admission-diagnostic.json'), 'utf8'))).toEqual({
      finalKind: 'accepted', knownContributingPhases: [],
    });
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('independent unresolved wire and bounded admission cause are captured locally', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const unresolvedWire = unspannedDecision(draft.sourceInstruction, { kind: 'unresolved',
      reasonCode: 'unclassified_material', sourceEvidence: [{ authoredText: draft.sourceInstruction,
        sourceSpan: { start: 0, end: draft.sourceInstruction.length } }] });
    const input = { testSpecId: debugTestSpecId, sourceInstruction: draft.sourceInstruction,
      executionProfileRef: draft.executionProfileRef, startState: draft.startState };
    const ordinary = await withGates('1', undefined, () => interpretDeferredActionTaskV2(input,
      models(JSON.stringify(unspannedWire(draft, 'primary')), JSON.stringify(unresolvedWire))));
    expect(ordinary.kind).toBe('rejected');
    expect(newArtifacts(before)).toEqual([]);
    const debugged = await withGates('1', '1', () => interpretDeferredActionTaskV2(input,
      models(JSON.stringify(unspannedWire(draft, 'primary')), JSON.stringify(unresolvedWire))));
    expect(debugged.kind).toBe('rejected');
    if (ordinary.kind !== 'rejected' || debugged.kind !== 'rejected') return;
    expect(projectActionSemanticStopV2(debugged)).toEqual(projectActionSemanticStopV2(ordinary));
    const artifacts = newArtifacts(before);
    expect(artifacts).toHaveLength(3);
    const byPhase = new Map(artifacts.map((path) => [JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')).phase as string, path]));
    expect(JSON.parse(readFileSync(resolve(byPhase.get('primary')!, 'metadata.json'), 'utf8')).normalizedOutcomeKind).toBe('extraction');
    expect(JSON.parse(readFileSync(resolve(byPhase.get('independent')!, 'metadata.json'), 'utf8')).normalizedOutcomeKind).toBe('unresolved');
    expect(JSON.parse(readFileSync(resolve(byPhase.get('independent')!, 'provider-wire.json'), 'utf8'))).toEqual(unresolvedWire);
    const admission = JSON.parse(readFileSync(resolve(byPhase.get('admission')!, 'admission-diagnostic.json'), 'utf8'));
    expect(admission).toEqual({ finalKind: 'rejected', stage: 'admission', rejectionCategory: 'unresolved',
      rejectionCode: 'SEMANTIC_INTERPRETATION_UNRESOLVED', knownContributingPhases: ['independent'] });
    const persisted = artifacts.map((path) => readdirSync(path).map((name) => readFileSync(resolve(path, name), 'utf8')).join('\n')).join('\n');
    expect(persisted).not.toContain('test-api-key-never-persist');
    expect(persisted).not.toContain('Authorization');
    expect(persisted).not.toContain('Bearer');
    expect(JSON.stringify(debugged)).not.toContain('provider-wire');
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('semantic disagreement diagnostic identifies the compared phases without assigning blame', async () => {
  const before = dirs();
  try {
    const primary = spec(choose());
    const independent = structuredClone(primary);
    const goal = independent.steps[0];
    if (goal?.type !== 'action_goal') throw new Error('Expected action fixture');
    const effect = goal.obligations.find((item) => item.kind === 'effect');
    const argument = goal.obligations.find((item) => item.kind === 'argument');
    if (!effect || !argument) throw new Error('Expected effect and argument');
    effect.effect = 'enter_text';
    argument.purpose = 'entered_text';
    const input = { testSpecId: debugTestSpecId, sourceInstruction: primary.sourceInstruction,
      executionProfileRef: primary.executionProfileRef, startState: primary.startState };
    const result = await withGates('1', '1', () => interpretDeferredActionTaskV2(input,
      models(JSON.stringify(unspannedWire(primary, 'primary')),
        JSON.stringify(unspannedWire(independent, 'independent')))));
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'admission',
      category: 'semantic_disagreement', code: 'SEMANTIC_INTERPRETATION_DISAGREEMENT' } });
    const path = newArtifacts(before).find((entry) =>
      JSON.parse(readFileSync(resolve(entry, 'metadata.json'), 'utf8')).phase === 'admission');
    expect(JSON.parse(readFileSync(resolve(path!, 'admission-diagnostic.json'), 'utf8'))).toEqual({
      finalKind: 'rejected', stage: 'admission', rejectionCategory: 'semantic_disagreement',
      rejectionCode: 'SEMANTIC_INTERPRETATION_DISAGREEMENT',
      knownContributingPhases: ['primary', 'independent'], semanticDisagreementCategory: 'semantic_disagreement',
    });
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('both gates persist exact parsed primary and independent wires with Zod paths and bounded metadata', async () => {
  const before = dirs();
  try {
    await withGates('1', '1', async () => {
      const extraction = models(JSON.stringify(malformedWire));
      for (const model of [extraction.primary, extraction.independent]) {
        await expect(model.complete({ systemInstruction: 'test', userInstruction: 'Choose Option 1.',
          signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
      }
    });
    const artifacts = newArtifacts(before);
    expect(artifacts).toHaveLength(2);
    const phases = new Set<string>();
    for (const path of artifacts) {
      const raw = readFileSync(resolve(path, 'provider-wire.json'), 'utf8');
      const error = readFileSync(resolve(path, 'normalization-error.txt'), 'utf8');
      const metadata = JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(JSON.parse(raw)) === JSON.stringify(malformedWire)).toBe(true);
      expect(error).toContain('failure kind: closed_wire_schema_failure');
      expect(error).toContain('exception type: Zod error');
      expect(error).toMatch(/zod issues: .*"path":\["response"/);
      expect(error).toMatch(/"code":"(?:invalid_union|invalid_type|invalid_value|too_small)"/);
      expect(metadata).toMatchObject({ model: testModel, providerCompletionState: 'completed' });
      expect(typeof metadata.elapsedMs).toBe('number');
      expect(Object.keys(metadata).sort()).toEqual(['elapsedMs', 'model', 'phase', 'providerCompletionState',
        'responseFormat', 'timestamp', 'normalizedOutcomeKind'].sort());
      expect(metadata.normalizedOutcomeKind).toBeNull();
      phases.add(String(metadata.phase));
      const combined = raw + error + JSON.stringify(metadata);
      expect(combined).not.toContain('test-api-key-never-persist');
      expect(combined).not.toContain('Authorization');
      expect(combined).not.toContain('Bearer');
    }
    expect(phases).toEqual(new Set(['primary', 'independent']));
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('non-Zod normalizer failure retains its original class and message only in local diagnostics', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const wire = unspannedWire(draft, 'primary');
    await withGates('1', '1', async () => {
      await expect(models(JSON.stringify(wire)).primary.complete({ systemInstruction: 'test',
        userInstruction: 'An unrelated source sentence.', signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
    });
    const [path] = newArtifacts(before);
    expect(path).toBeTruthy();
    const error = readFileSync(resolve(path!, 'normalization-error.txt'), 'utf8');
    expect(error).toContain('failure kind: non_zod_normalizer_exception');
    expect(error).toContain('exception class: ContractValidationError');
    expect(error).toContain('exception message: INVALID_SOURCE_REPRESENTATION:');
    expect(JSON.stringify(JSON.parse(readFileSync(resolve(path!, 'provider-wire.json'), 'utf8'))) ===
      JSON.stringify(wire)).toBe(true);
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('valid closed wire with later Zod normalization failure retains the later issue path', async () => {
  const before = dirs();
  try {
    const wire = unspannedWire(spec(choose()), 'primary') as { response: {
      steps: { sourceAccounting: { authoredText: string }[] }[]; instructionAccounting: unknown[] } };
    wire.response.steps[0]!.sourceAccounting[0]!.authoredText = 'S'.repeat(600);
    wire.response.steps[0]!.sourceAccounting[2]!.authoredText = 'O'.repeat(600);
    const source = wire.response.steps[0]!.sourceAccounting.map((item) => item.authoredText).join('');
    expect(PrimaryActionExtractionV6WireSchema.safeParse(wire).success).toBe(true);
    await withGates('1', '1', async () => {
      await expect(models(JSON.stringify(wire)).primary.complete({ systemInstruction: 'test',
        userInstruction: source, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
    });
    const [path] = newArtifacts(before);
    expect(path).toBeTruthy();
    const error = readFileSync(resolve(path!, 'normalization-error.txt'), 'utf8');
    expect(error).toContain('failure kind: zod_normalization_failure');
    expect(error).toContain('exception type: Zod error');
    expect(error).toMatch(/zod issues: .*"path":\[0,"sourceText"\]/);
    expect(error).toMatch(/"code":"(?:invalid_union|too_big)"/);
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('normalization debug does not change the public stop projection', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const input = { testSpecId: debugTestSpecId, sourceInstruction: draft.sourceInstruction,
      executionProfileRef: draft.executionProfileRef, startState: draft.startState };
    const run = async (live: string | undefined, debug: string | undefined) => withGates(live, debug, async () => {
      const result = await interpretDeferredActionTaskV2(input, models(JSON.stringify(malformedWire)));
      expect(result.kind).toBe('rejected');
      return result.kind === 'rejected' ? projectActionSemanticStopV2(result) : undefined;
    });
    const ordinary = await run(undefined, undefined);
    const debugged = await run('1', '1');
    expect(debugged).toEqual(ordinary);
    expect(JSON.stringify(debugged)).not.toContain('impossible');
    expect(newArtifacts(before)).toHaveLength(2);
    const admissionPath = newArtifacts(before).find((path) =>
      JSON.parse(readFileSync(resolve(path, 'metadata.json'), 'utf8')).phase === 'admission');
    expect(JSON.parse(readFileSync(resolve(admissionPath!, 'admission-diagnostic.json'), 'utf8'))).toMatchObject({
      finalKind: 'rejected', stage: 'primary', rejectionCategory: 'structural',
      rejectionCode: 'INVALID_SOURCE_REPRESENTATION', knownContributingPhases: ['primary'],
    });
  } finally { removeTestArtifacts(newArtifacts(before)); }
});

test('transport rejects malformed provider JSON without a parsed-wire artifact or public projection drift', async () => {
  const before = dirs();
  try {
    const draft = spec(choose());
    const input = { testSpecId: debugTestSpecId, sourceInstruction: draft.sourceInstruction,
      executionProfileRef: draft.executionProfileRef, startState: draft.startState };
    const run = async (live: string | undefined, debug: string | undefined) => withGates(live, debug, async () => {
      const result = await interpretDeferredActionTaskV2(input, models('{bad-json'));
      expect(result.kind).toBe('rejected');
      return result.kind === 'rejected' ? projectActionSemanticStopV2(result) : undefined;
    });
    const ordinary = await run(undefined, undefined);
    const debugged = await run('1', '1');
    expect(debugged).toEqual(ordinary);
    expect(JSON.stringify(debugged)).not.toContain('{bad-json');
    // The Responses transport rejects unparseable output before it reaches the normalizer.
    const [path] = newArtifacts(before);
    expect(newArtifacts(before)).toHaveLength(1);
    expect(JSON.parse(readFileSync(resolve(path!, 'admission-diagnostic.json'), 'utf8'))).toMatchObject({
      finalKind: 'rejected', stage: 'primary', rejectionCode: 'INVALID_SOURCE_REPRESENTATION',
    });
  } finally { removeTestArtifacts(newArtifacts(before)); }
});
