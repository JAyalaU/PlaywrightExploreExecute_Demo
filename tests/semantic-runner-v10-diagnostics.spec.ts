import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { classifyClickFailureV10, SemanticRunnerDiagnosticV10Schema,
  SemanticRunnerDiagnosticsV10Store, type DiagnosticStateV10 } from
  '../app/runner/semantic-v10-diagnostics.js';

const state = (generation = 1, documentTimeOrigin: number | null = 1000): DiagnosticStateV10 => ({
  monotonicMs: 1, browserConnected: true, contextOpen: true, pageOpen: true,
  sanitizedUrl: 'http://127.0.0.1/#path-deadbeef', pageId: 'page-a', mainFrameId: 'frame-a',
  navigationGeneration: generation, navigationRequestGeneration: generation,
  documentTimeOrigin, readyState: 'complete' });

test('v10 click failures use closed categories without persisting exception text', () => {
  expect(classifyClickFailureV10(new Error('Timeout 1500ms exceeded'), state())).toBe('PLAYWRIGHT_CLICK_TIMEOUT');
  expect(classifyClickFailureV10(new Error('Element is detached from DOM'), state())).toBe(
    'TARGET_DETACHED_DURING_CLICK');
  expect(classifyClickFailureV10(new Error('Execution context was destroyed'), state())).toBe(
    'EXECUTION_CONTEXT_CHANGED');
  expect(classifyClickFailureV10(new Error('Protocol error'), state())).toBe('PROTOCOL_ERROR');
  expect(classifyClickFailureV10(new Error('anything'), { ...state(), pageOpen: false })).toBe(
    'PAGE_CLOSED_DURING_CLICK');
  expect(classifyClickFailureV10(new Error('anything'), { ...state(), contextOpen: false })).toBe(
    'CONTEXT_CLOSED_DURING_CLICK');
  expect(classifyClickFailureV10(new Error('anything'), { ...state(), browserConnected: false })).toBe(
    'BROWSER_DISCONNECTED');
  expect(classifyClickFailureV10(new Error('anything'), state())).toBe('CLICK_API_FAILURE');
  expect(classifyClickFailureV10('not an Error', state())).toBe('UNKNOWN_CLICK_FAILURE');
});

test('v10 bounded count diagnostics represent transitions, stable zero, reset, and Delete two to one', () => {
  const base = { recordVersion: 'semantic_runner_diagnostic_v10', executionRunId: 'semantic-run-test',
    resolvedSpecId: 'semantic-resolved-test', compilerAttemptId: 'semantic-compiler-test',
    traceDigest: 'a'.repeat(64), clicks: [], effects: [], boundaries: [], countFailures: [] };
  const count = (stepId: string, initialCount: number, values: number[], finalCount: number,
    changed = false) => ({ stepId, comparator: 'equals', expected: 2, started: state(), initialCount,
    transitions: values.map(value => ({ count: value, state: state(changed ? 2 : 1,
      changed ? 2000 : 1000) })), finalCount, ended: state(changed ? 2 : 1, changed ? 2000 : 1000),
    elapsedMs: 80, exhausted: finalCount !== 2, interrupted: false,
    navigationRequestedDuringSettling: changed, documentChanged: changed });
  const record = SemanticRunnerDiagnosticV10Schema.parse({ ...base, counts: [
    count('zero_one_two', 0, [1, 2], 2),
    count('always_zero', 0, [], 0),
    count('reset', 0, [2, 0], 0, true),
    { ...count('delete', 2, [1], 1), expected: 1, exhausted: false },
  ] });
  expect(record.counts.map(item => item.transitions.map(transition => transition.count))).toEqual(
    [[1, 2], [], [2, 0], [1]]);
  expect(record.counts[2]?.documentChanged).toBe(true);
  expect(record.counts[1]?.exhausted).toBe(true);
  expect(() => SemanticRunnerDiagnosticV10Schema.parse({ ...base, counts: [
    count('too_many', 0, Array.from({ length: 33 }, (_, index) => index), 0),
  ] })).toThrow();
});

test('v10 private diagnostic readback authenticates and detects alteration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'v10-diagnostic-'));
  try {
    const store = new SemanticRunnerDiagnosticsV10Store(root);
    const record = SemanticRunnerDiagnosticV10Schema.parse({
      recordVersion: 'semantic_runner_diagnostic_v10', executionRunId: 'semantic-run-test',
      resolvedSpecId: 'semantic-resolved-test', compilerAttemptId: 'semantic-compiler-test',
      traceDigest: 'b'.repeat(64), clicks: [], effects: [], counts: [], boundaries: [], countFailures: [],
    });
    await store.write(record);
    expect(await new SemanticRunnerDiagnosticsV10Store(root).readByRunId(record.executionRunId)).toEqual(record);
    const file = path.join(root, 'semantic-runner-diagnostics-v10', `${record.executionRunId}.json`);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { data: { traceDigest: string } };
    envelope.data.traceDigest = 'c'.repeat(64);
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.readByRunId(record.executionRunId)).rejects.toThrow(
      'INVALID_SEMANTIC_RUNNER_DIAGNOSTIC_AUTHENTICATION');
  } finally { await rm(root, { recursive: true, force: true }); }
});
