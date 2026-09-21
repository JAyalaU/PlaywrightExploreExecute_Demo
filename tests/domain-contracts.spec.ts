import { expect, test } from '@playwright/test';
import {
  ContractValidationError,
  LocatorFormSchema,
  ResultRecordSchema,
  TestSpecSchema,
  assertImmutableResolvedTestSpec,
  assertImmutableTestSpec,
  parseResolvedTestSpec,
  parseTestSpec,
} from '../app/domain/index.js';
import { authoredSteps, makeResolvedSpec, makeTestSpec } from './fixtures/domain.js';

test('all approved authored operations and four wait variants validate and serialize', () => {
  const spec = makeTestSpec();
  expect(spec.steps.map((step) => step.type)).toEqual([
    'navigate', 'click', 'fill', 'select_option', 'assert_visible', 'assert_text',
    'assert_value', 'assert_url', 'wait_for', 'wait_for', 'wait_for', 'wait_for',
  ]);
  expect(spec.steps.filter((step) => step.type === 'wait_for').map((step) => step.condition.type))
    .toEqual(['target_visible', 'url_exact', 'url_pattern', 'target_value']);
  expect(parseTestSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  expect(authoredSteps).toHaveLength(12);
});

test('ordered resolved operations preserve the authored sequence and serialize', () => {
  const source = makeTestSpec();
  const resolved = makeResolvedSpec();
  const parsed = parseResolvedTestSpec(resolved, source);
  expect(parsed.executionSteps.map((step) => step.originStepId)).toEqual(source.steps.map((step) => step.id));
  expect(parseResolvedTestSpec(JSON.parse(JSON.stringify(parsed)), source)).toEqual(parsed);
});

test('a discovered menu prerequisite is linked and ordered before its authored click', () => {
  const source = makeTestSpec();
  const resolved = makeResolvedSpec();
  resolved.executionSteps.splice(1, 0, {
    id: 'x0', originStepId: 's2', source: 'discoveredPrerequisite',
    reason: 'Expose the Admin menu item', type: 'click', locatorId: 'loc-0',
    targetDescription: 'top-right menu',
    locator: {
      mcpGeneratedExpression: "getByRole('button', { name: 'Menu' })",
      validatedForm: { type: 'role', role: 'button', name: 'Menu' },
      observed: { role: 'button', accessibleName: 'Menu', matchCount: 1 },
      quality: { status: 'accepted', identityBasis: 'role-and-accessible-name' },
    },
    derivationEvidenceRef: 'evidence/explore-789/x0.json',
  });
  expect(parseResolvedTestSpec(resolved, source).executionSteps[1]?.source).toBe('discoveredPrerequisite');
  Object.assign(resolved.executionSteps[1]!, { originStepId: 's3' });
  expect(() => parseResolvedTestSpec(resolved, source)).toThrow(ContractValidationError);
});

test('unknown operations, extra fields, and executable semantic content fail', () => {
  const spec = makeTestSpec();
  expect(parseTestSpec({ ...spec, sourceInstruction: 'Go to the page. Select Admin.' }).sourceInstruction).toBe('Go to the page. Select Admin.');
  expect(parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'fill', sourceText: 'Enter account name', target: { description: 'Name' }, value: { kind: 'dataRef', ref: 'accountName' } }] }).steps).toHaveLength(1);
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'fill', sourceText: 'Enter account name', target: { description: 'Name' }, value: { kind: 'script', code: 'alert(1)' } }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'hover', sourceText: 'Hover' }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ ...spec.steps[1], expectedText: 'Admin' }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'click', sourceText: 'Run page.evaluate()', target: { description: 'Admin' } }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'click', sourceText: 'Click Admin', target: { description: "locator('#admin')" } }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'click', sourceText: 'Click Admin', target: { description: '#admin' } }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'click', sourceText: 'Click Admin', target: { description: 'Admin', selector: '#admin' } }] })).toThrow();
});

test('wait variants reject cross-variant fields, missing fields, and extra timeout behavior', () => {
  const spec = makeTestSpec();
  const base = { id: 's1', type: 'wait_for', sourceText: 'Wait', timeoutPolicyRef: 'default' };
  const badConditions = [
    { type: 'target_visible' },
    { type: 'target_visible', target: { description: 'Save' }, url: 'https://example.com' },
    { type: 'url_exact', url: 'https://example.com', target: { description: 'Save' } },
    { type: 'url_pattern', pattern: 'https://example.com/*', expectedValue: 'x' },
    { type: 'target_value', target: { description: 'Role' } },
    { type: 'after_ms', milliseconds: 500 },
  ];
  for (const condition of badConditions) {
    expect(() => parseTestSpec({ ...spec, steps: [{ ...base, condition }] })).toThrow();
  }
  expect(() => parseTestSpec({ ...spec, steps: [{ ...base, condition: { type: 'url_exact', url: 'https://example.com' }, sleepMs: 100 }] })).toThrow();
});

test('versions, URLs, patterns, IDs, and references are checked', () => {
  const spec = makeTestSpec();
  expect(() => parseTestSpec({ ...spec, schemaVersion: '3' })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [spec.steps[0], spec.steps[0]] })).toThrow('Duplicate authored step ID');
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'navigate', sourceText: 'Go', url: 'javascript:alert(1)' }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'assert_url', sourceText: 'Check URL', expectedUrl: 'https://example.com/*/x', match: 'pattern' }] })).toThrow();
  expect(() => parseTestSpec({ ...spec, steps: [{ id: 's1', type: 'assert_url', sourceText: 'Check URL', expectedUrl: 'https://example.com/orders/*', match: 'exact' }] })).toThrow();
  const resolved = makeResolvedSpec();
  expect(() => parseResolvedTestSpec({ ...resolved, schemaVersion: '3' }, spec)).toThrow();
  expect(() => parseResolvedTestSpec({ ...resolved, testSpecId: 'test-other' }, spec)).toThrow('different TestSpec');
  expect(() => parseResolvedTestSpec({ ...resolved, executionProfileRef: { id: 'desktop', version: '2' } }, spec)).toThrow('profile reference');
});

test('resolved IDs, origins, order, and authored literal semantics cannot drift', () => {
  const spec = makeTestSpec();
  const cases = [
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[1]!, { id: 'x1' }),
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[2]!, { locatorId: 'loc-2' }),
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[1]!, { originStepId: 's404' }),
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[1]!, { originStepId: 's3' }),
    (resolved: ReturnType<typeof makeResolvedSpec>) => resolved.executionSteps.splice(1, 1),
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[2]!, { value: 'Mallory' }),
    (resolved: ReturnType<typeof makeResolvedSpec>) => Object.assign(resolved.executionSteps[8]!, { expectedUrl: 'https://example.com/other/*' }),
  ];
  for (const change of cases) {
    const resolved = makeResolvedSpec();
    change(resolved);
    expect(() => parseResolvedTestSpec(resolved, spec)).toThrow();
  }
});

test('revisions cannot silently reuse immutable TestSpec or attempt identities', () => {
  const spec = makeTestSpec();
  assertImmutableTestSpec(spec, structuredClone(spec));
  expect(() => assertImmutableTestSpec(spec, { ...spec, sourceInstruction: 'Changed request' })).toThrow('new testSpecId');
  assertImmutableTestSpec(spec, { ...spec, testSpecId: 'test-124', sourceInstruction: 'Changed request' });

  const first = parseResolvedTestSpec(makeResolvedSpec(), spec);
  const edited = structuredClone(first);
  edited.runtimeVersions.runner = '2';
  expect(() => assertImmutableResolvedTestSpec(first, edited)).toThrow('new resolvedSpecId');
  const reusedAttempt = { ...edited, resolvedSpecId: 'resolved-457' };
  expect(() => assertImmutableResolvedTestSpec(first, reusedAttempt)).toThrow('new explorationAttemptId');
  assertImmutableResolvedTestSpec(first, { ...reusedAttempt, explorationAttemptId: 'explore-790' });
});

test('locator forms accept semantic, scoped, and frame forms but reject ambiguous shapes', () => {
  const semantic = { type: 'role', role: 'button', name: 'Save' };
  const scoped = { type: 'within', scope: { type: 'role', role: 'dialog', name: 'Edit profile dialog' }, target: semantic };
  const frame = { type: 'frame', frame: { type: 'title', value: 'payment frame' }, target: semantic };
  for (const form of [semantic, scoped, frame]) expect(LocatorFormSchema.parse(form)).toEqual(form);
  for (const form of [
    { ...semantic, css: '.save' },
    { type: 'nth', index: 2 },
    { type: 'within', scope: semantic },
    { type: 'frame', frame: { type: 'title', value: 'payment frame', index: 0 }, target: semantic },
    { type: 'frame', frame: { type: 'title', value: 'payment frame' }, target: { type: 'css', value: '.save' } },
  ]) expect(LocatorFormSchema.safeParse(form).success).toBe(false);
});

test('accepted resolved locators require one observed match and accepted quality', () => {
  const spec = makeTestSpec();
  const resolved = makeResolvedSpec();
  const click = resolved.executionSteps[1]!;
  const parsedClick = parseResolvedTestSpec(resolved, spec).executionSteps[1]!;
  if (parsedClick.type !== 'click') throw new Error('Fixture step must be a click');
  const locator = parsedClick.locator;
  Object.assign(click, { locator: { ...locator, mcpGeneratedExpression: "  getByRole('button', { name: 'Admin' })  " } });
  const roundTrip = parseResolvedTestSpec(resolved, spec).executionSteps[1]!;
  if (roundTrip.type !== 'click') throw new Error('Fixture step must be a click');
  expect(roundTrip.locator.mcpGeneratedExpression).toBe("  getByRole('button', { name: 'Admin' })  ");
  Object.assign(click, { locator: { ...locator, observed: { matchCount: 2 }, quality: { status: 'accepted', identityBasis: 'role' } } });
  expect(() => parseResolvedTestSpec(resolved, spec)).toThrow();
  Object.assign(click, { locator: { ...locator, quality: { status: 'rejected', identityBasis: 'glyph text' } } });
  expect(() => parseResolvedTestSpec(resolved, spec)).toThrow();
});

test('typed result records require immutable run or attempt correlation and JSON values', () => {
  const result = {
    phase: 'execution', status: 'QA_ASSERTION_FAILED', testSpecId: 'test-123',
    resolvedSpecId: 'resolved-456', executionRunId: 'run-101', originStepId: 's5',
    executionProfileRef: { id: 'desktop', version: '1' },
    executionStepId: 'x5', locatorId: 'loc-5', reason: 'NO_MATCH',
    expected: true, actual: false, retryable: false,
    startedAt: '2026-09-20T12:00:00.000Z', finishedAt: '2026-09-20T12:00:01.000Z',
    evidenceRefs: ['evidence/run-101/x5.json'],
  };
  expect(ResultRecordSchema.parse(result)).toEqual(result);
  expect(ResultRecordSchema.safeParse({ ...result, executionRunId: undefined }).success).toBe(false);
  expect(ResultRecordSchema.safeParse({ ...result, actual: () => 1 }).success).toBe(false);
  expect(ResultRecordSchema.safeParse({ ...result, evidenceRefs: ['../secret'] }).success).toBe(false);
  expect(TestSpecSchema.safeParse({ ...makeTestSpec(), locator: {} }).success).toBe(false);
});
