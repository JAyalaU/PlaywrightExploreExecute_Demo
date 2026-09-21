import { test, expect } from '@playwright/test';
import { interpretTask, type InterpretationModel, type InterpretationRequest } from '../app/interpretation/index.js';

const request: InterpretationRequest = {
  sourceInstruction: 'Go to https://example.com. Select the top-right menu. Assert that Admin, User, and Config are present.',
  testSpecId: 'test-m7a',
  executionProfileRef: { id: 'desktop', version: '1' },
  startState: { url: 'about:blank' },
};

function model(response: string | (() => Promise<string>)): InterpretationModel {
  return {
    complete: async ({ systemInstruction, userInstruction }) => {
      expect(systemInstruction).toContain('assert_visible');
      expect(userInstruction).toBe(request.sourceInstruction);
      return typeof response === 'string' ? response : response();
    },
  };
}

test('M7-A maps one whole-task response to a validated TestSpec with distinct assertions', async () => {
  const steps = [
    { id: 's1', type: 'navigate', url: 'https://example.com', sourceText: 'Go to https://example.com' },
    { id: 's2', type: 'click', target: { description: 'top-right menu' }, sourceText: 'Select the top-right menu' },
    ...['Admin', 'User', 'Config'].map((name, index) => ({
      id: `s${index + 3}`, type: 'assert_visible', target: { description: name },
      sourceText: 'Assert that Admin, User, and Config are present',
    })),
  ];
  let calls = 0;
  const outcome = await interpretTask(request, {
    complete: async (input) => { calls += 1; return model(JSON.stringify({ kind: 'test_spec', steps })).complete(input); },
  });
  expect(calls).toBe(1);
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  expect(outcome.testSpec).toEqual({
    schemaVersion: '2', testSpecId: request.testSpecId, sourceInstruction: request.sourceInstruction,
    executionProfileRef: request.executionProfileRef, startState: request.startState, steps,
  });
});

test('M7-A returns typed ambiguity and unsupported outcomes without a runnable spec', async () => {
  const ambiguous = await interpretTask(request, model('{"kind":"ambiguous","reason":"The requested menu is unclear"}'));
  expect(ambiguous.kind).toBe('rejected');
  if (ambiguous.kind === 'rejected') {
    expect(ambiguous.result).toMatchObject({ phase: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION', reason: 'MATERIAL_AMBIGUITY' });
  }
  const unsupported = await interpretTask(request, model('{"kind":"unsupported","reason":"Dragging is not supported"}'));
  expect(unsupported.kind).toBe('rejected');
  if (unsupported.kind === 'rejected') {
    expect(unsupported.result).toMatchObject({ phase: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'UNSUPPORTED_REQUEST' });
  }
});

test('M7-A rejects malformed, unauthorized, and invented model fields before browser work', async () => {
  const outputs = [
    'not JSON',
    '{"kind":"test_spec","steps":[],"executionProfileRef":{"id":"admin","version":"1"}}',
    JSON.stringify({ kind: 'test_spec', steps: [{ id: 's1', type: 'click', sourceText: 'Select the top-right menu', target: { description: 'menu', selector: '#menu' } }] }),
    JSON.stringify({ kind: 'test_spec', steps: [{ id: 's1', type: 'click', sourceText: 'Click Delete', target: { description: 'Delete' } }] }),
    JSON.stringify({ kind: 'test_spec', steps: [{ id: 's1', type: 'hover', sourceText: 'Select the top-right menu' }] }),
  ];
  for (const output of outputs) {
    const outcome = await interpretTask(request, model(output));
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.result.status).toBe('INTERPRETATION_FAILED');
  }
});

test('M7-A bounds model failure and timeout to one call', async () => {
  let calls = 0;
  const broken: InterpretationModel = { complete: async () => { calls += 1; throw new Error('provider unavailable'); } };
  const failed = await interpretTask(request, broken);
  expect(calls).toBe(1);
  expect(failed.kind).toBe('rejected');
  if (failed.kind === 'rejected') expect(failed.result.reason).toBe('MODEL_ERROR');

  const stalled: InterpretationModel = { complete: async () => new Promise<string>(() => {}) };
  const timedOut = await interpretTask(request, stalled, { timeoutMs: 5 });
  expect(timedOut.kind).toBe('rejected');
  if (timedOut.kind === 'rejected') expect(timedOut.result.reason).toBe('MODEL_TIMEOUT');
});
