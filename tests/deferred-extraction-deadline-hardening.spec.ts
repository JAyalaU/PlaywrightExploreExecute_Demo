import { expect, test } from '@playwright/test';
import { mock } from 'node:test';
import { DEFERRED_INTERPRETATION_DEADLINE_POLICY, interpretDeferredActionTaskV2,
  projectActionSemanticStopV2 } from '../app/interpretation/deferred-action-v2-interpret.js';
import { createOpenAIActionSemanticExtractionModelsV2 } from '../app/interpretation/deferred-action-v2-adapters.js';
import { ModelCompletionFailure } from '../app/interpretation/model-failure.js';
import { DeferredInterpretationTimingV1Schema } from '../app/domain/deferred-interpretation-timing.js';
import { DeferredWorkflowPrivateAccountingV1Schema } from '../app/domain/deferred-workflow-accounting.js';
import { choose, spec } from './helpers/action-v2-fixtures.js';

const draft = () => spec(choose());
const request = (source: ReturnType<typeof draft>) => ({ testSpecId: source.testSpecId,
  sourceInstruction: source.sourceInstruction, executionProfileRef: source.executionProfileRef, startState: source.startState });
const extraction = (source: ReturnType<typeof draft>) => JSON.stringify({ kind: 'extraction',
  steps: source.steps, instructionAccounting: source.instructionAccounting });
const pending = () => new Promise<string>(() => {});

test('primary provider deadline is bounded and reports only restricted timing', async () => {
  expect(DEFERRED_INTERPRETATION_DEADLINE_POLICY).toEqual({ perCallMs: 180_000, maxAttemptsPerPhase: 2, headroomMs: 60_000, sharedMs: 780_000 });
  const source = draft();
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    let independentCalls = 0;
    const outcome = interpretDeferredActionTaskV2(request(source), {
      primary: { complete: pending }, independent: { complete: async () => { independentCalls++; return extraction(source); } },
    });
    now = 180_000;
    mock.timers.tick(180_000);
    const result = await outcome;
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'environment', code: 'EXTRACTION_DEADLINE' },
      timing: { phase: 'primary', phaseElapsedMs: 180_000, totalElapsedMs: 180_000, perCallLimitMs: 180_000,
        sharedLimitMs: 780_000, remainingMs: 600_000, providerCompletedBeforeBoundary: false, deadlineOrigin: 'per_call' } });
    expect(independentCalls).toBe(0);
    if (result.kind !== 'rejected') throw new Error('Expected deadline stop');
    expect(DeferredInterpretationTimingV1Schema.parse(result.timing).phases).toHaveLength(1);
    expect(() => DeferredInterpretationTimingV1Schema.parse({ ...result.timing, sourceInstruction: source.sourceInstruction })).toThrow();
    expect(DeferredWorkflowPrivateAccountingV1Schema.parse({ groundingAttempts: [], successfulWitnesses: [] }))
      .not.toHaveProperty('interpretationTiming');
    expect(projectActionSemanticStopV2(result)).not.toHaveProperty('timing');
    expect(JSON.stringify(projectActionSemanticStopV2(result))).not.toContain(source.sourceInstruction);
  } finally { mock.timers.reset(); mock.restoreAll(); }
});

test('primary near its full limit plus parsing overhead leaves independent its full 180 seconds', async () => {
  const source = draft();
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let now = 0, primaryReturned = false, readsAfterPrimary = 0, independentCalls = 0;
  mock.method(performance, 'now', () => {
    if (primaryReturned && ++readsAfterPrimary === 2) now += 1_000; // local validation after timely provider completion
    return now;
  });
  try {
    const outcome = interpretDeferredActionTaskV2(request(source), {
      primary: { complete: async () => { now = 179_900; primaryReturned = true; return extraction(source); } },
      independent: { complete: () => { independentCalls++; return pending(); } },
    });
    for (let i = 0; i < 100 && independentCalls === 0; i++) await Promise.resolve();
    expect(independentCalls).toBe(1);
    now = 360_900;
    mock.timers.tick(180_000);
    const result = await outcome;
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'independent', code: 'EXTRACTION_DEADLINE' },
      timing: { phase: 'independent', perCallLimitMs: 180_000, sharedLimitMs: 780_000,
        remainingMs: 419_100,
        providerCompletedBeforeBoundary: false, deadlineOrigin: 'per_call', phases: [
          { phase: 'primary', allowedMs: 180_000, providerCompletedBeforeBoundary: true, deadlineOrigin: 'none' },
          { phase: 'independent', allowedMs: 180_000, providerCompletedBeforeBoundary: false, deadlineOrigin: 'per_call' },
        ] } });
    if (result.kind !== 'rejected') throw new Error('Expected deadline stop');
    expect(result.timing?.phases[1]?.remainingAtStartMs).toBeGreaterThanOrEqual(599_000);
  } finally { mock.timers.reset(); mock.restoreAll(); }
});

test('two full primary attempts preserve two full independent allowances', async () => {
  const source = draft(), output = extraction(source);
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let now = 0, primaryCalls = 0, independentCalls = 0;
  mock.method(performance, 'now', () => now);
  try {
    const running = interpretDeferredActionTaskV2(request(source), {
      primary: { complete: async ({ onProviderCompleted }) => {
        primaryCalls++;
        now = primaryCalls === 1 ? 179_900 : 359_800;
        onProviderCompleted?.('completed');
        if (primaryCalls === 1) throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true);
        return output;
      } },
      independent: { complete: ({ onProviderCompleted }) => {
        independentCalls++;
        if (independentCalls === 1) {
          now = 539_700;
          onProviderCompleted?.('completed');
          throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true);
        }
        return pending();
      } },
    });
    for (let i = 0; i < 100 && independentCalls < 2; i++) await Promise.resolve();
    expect([primaryCalls, independentCalls]).toEqual([2, 2]);
    now = 719_700;
    mock.timers.tick(180_000);
    const result = await running;
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'independent', code: 'EXTRACTION_DEADLINE' },
      timing: { deadlineOrigin: 'per_call', attempts: [
        { phase: 'primary', attempt: 1, allowedMs: 180_000, outcome: 'invalid_wire' },
        { phase: 'primary', attempt: 2, allowedMs: 180_000, outcome: 'valid_extraction' },
        { phase: 'independent', attempt: 1, allowedMs: 180_000, outcome: 'invalid_wire' },
        { phase: 'independent', attempt: 2, allowedMs: 180_000, outcome: 'deadline' },
      ] } });
  } finally { mock.timers.reset(); mock.restoreAll(); }
});

test('provider completion before 180 seconds permits normalization in shared headroom', async () => {
  const source = draft(), output = extraction(source);
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    const outcome = interpretDeferredActionTaskV2(request(source), {
      primary: { complete: ({ onProviderCompleted }) => {
        onProviderCompleted?.();
        return new Promise(resolve => setTimeout(() => resolve(output), 181_000));
      } },
      independent: { complete: async () => output },
    });
    now = 181_000;
    mock.timers.tick(181_000);
    expect((await outcome).kind).toBe('accepted');
  } finally { mock.timers.reset(); mock.restoreAll(); }
});

test('late provider completion cannot win an event-loop-delayed timer', async () => {
  const source = draft(), output = extraction(source);
  let now = 0, independentCalls = 0;
  mock.method(performance, 'now', () => now);
  try {
    const result = await interpretDeferredActionTaskV2(request(source), {
      primary: { complete: async ({ onProviderCompleted }) => {
        now = 180_001;
        onProviderCompleted?.();
        return output;
      } },
      independent: { complete: async () => { independentCalls++; return output; } },
    });
    expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', code: 'EXTRACTION_DEADLINE' },
      timing: { deadlineOrigin: 'per_call', providerCompletedBeforeBoundary: false } });
    expect(independentCalls).toBe(0);
  } finally { mock.restoreAll(); }
});

test('provider completed but stalled normalization still hits shared deadline', async () => {
  const source = draft();
  mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let now = 0;
  mock.method(performance, 'now', () => now);
  try {
    const outcome = interpretDeferredActionTaskV2(request(source), {
      primary: { complete: ({ onProviderCompleted }) => { onProviderCompleted?.(); return pending(); } },
      independent: { complete: pending },
    });
    now = 780_000;
    mock.timers.tick(780_000);
    expect(await outcome).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', code: 'EXTRACTION_DEADLINE' },
      timing: { deadlineOrigin: 'shared', providerCompletedBeforeBoundary: true } });
  } finally { mock.timers.reset(); mock.restoreAll(); }
});

test('promptly settled provider failure retains its phase without a second call', async () => {
  const source = draft(); let calls = 0;
  const models = createOpenAIActionSemanticExtractionModelsV2({ apiKey: () => 'mock-only',
    fetchImpl: (async () => { calls++; return new Response('', { status: 503 }); }) as typeof fetch });
  const result = await interpretDeferredActionTaskV2(request(source), models);
  expect(result).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', category: 'provider', code: 'PROVIDER_ERROR' },
    timing: { phase: 'primary', providerCompletedBeforeBoundary: true, deadlineOrigin: 'none' } });
  expect(calls).toBe(1);
});

test('admission shared deadline and cancellation precedence remain non-QA stops', async () => {
  const source = draft(), output = extraction(source);
  let now = 0, independentReturned = false, readsAfterIndependent = 0;
  mock.method(performance, 'now', () => {
    if (independentReturned && ++readsAfterIndependent >= 6) now = 780_000;
    return now;
  });
  try {
    const timed = await interpretDeferredActionTaskV2(request(source), {
      primary: { complete: async () => output }, independent: { complete: async () => { independentReturned = true; return output; } },
    });
    expect(timed).toMatchObject({ kind: 'rejected', stop: { stage: 'admission', code: 'EXTRACTION_DEADLINE' },
      timing: { phase: 'admission', deadlineOrigin: 'shared', providerCompletedBeforeBoundary: false,
        phases: [{ phase: 'primary', providerCompletedBeforeBoundary: true },
          { phase: 'independent', providerCompletedBeforeBoundary: true }, { phase: 'admission', deadlineOrigin: 'shared' }] } });
  } finally { mock.restoreAll(); }
  const abort = new AbortController(); abort.abort();
  const cancelled = await interpretDeferredActionTaskV2(request(source), {
    primary: { complete: pending }, independent: { complete: pending },
  }, { signal: abort.signal, perCallTimeoutMs: 1, totalTimeoutMs: 1 });
  expect(cancelled).toMatchObject({ kind: 'rejected', stop: { stage: 'primary', code: 'INTERPRETATION_CANCELLED' },
    timing: { deadlineOrigin: 'cancellation' } });
});

test('test-only deadline overrides stay bounded above the demo defaults', async () => {
  const source = draft(), models = { primary: { complete: pending }, independent: { complete: pending } };
  await expect(interpretDeferredActionTaskV2(request(source), models,
    { perCallTimeoutMs: 240_001 })).rejects.toThrow('Invalid extraction bounds');
  await expect(interpretDeferredActionTaskV2(request(source), models,
    { totalTimeoutMs: 900_001 })).rejects.toThrow('Invalid extraction bounds');
});
