import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DeterministicVerificationAssertionV1Schema } from '../app/domain/index.js';
import { executeVerificationAssertionV7 } from '../app/runner/verification-v7.js';

const base = { assertionVersion: '1', sourceStrategyDigest: 'a'.repeat(64) };
const main = { kind: 'main' };
const query = (role: string, name: string) => ({ role, name, frame: main });
const evaluate = (page: Parameters<typeof executeVerificationAssertionV7>[0], input: object) =>
  executeVerificationAssertionV7(page, DeterministicVerificationAssertionV1Schema.parse({ ...base, ...input }));

test('v7 complete semantic count evaluates zero, presence and exact cardinality without binding', async ({ page }) => {
  await page.setContent('<button>Add Element</button><button hidden>Delete</button><button>Delete</button>');
  const deleteQuery = query('button', 'Delete');
  expect(await evaluate(page, { kind: 'semantic_count', query: deleteQuery,
    operator: 'equal', expected: 2 })).toMatchObject({ status: 'QA_ASSERTION_PASSED' });
  expect(await evaluate(page, { kind: 'semantic_count', query: deleteQuery,
    operator: 'at_least', expected: 1 })).toMatchObject({ status: 'QA_ASSERTION_PASSED' });
  expect(await evaluate(page, { kind: 'semantic_count', query: deleteQuery,
    operator: 'equal', expected: 0 })).toMatchObject({ status: 'QA_ASSERTION_FAILED' });
  expect(await evaluate(page, { kind: 'semantic_count', query: query('button', 'Remove'),
    operator: 'equal', expected: 0 })).toMatchObject({ status: 'QA_ASSERTION_PASSED' });
  expect(await evaluate(page, { kind: 'semantic_count', query: query('button', 'Remove'),
    operator: 'greater_than', expected: 0 })).toMatchObject({ status: 'QA_ASSERTION_FAILED' });
});

test('v7 rejects unknown operators, arbitrary selectors, and unsupported properties before execution', async ({ page }) => {
  await page.setContent('<button>Save</button>');
  expect(DeterministicVerificationAssertionV1Schema.safeParse({ ...base,
    kind: 'semantic_count', query: { ...query('button', 'Save'), selector: '#save' },
    operator: 'equal', expected: 1 }).success).toBe(false);
  expect(DeterministicVerificationAssertionV1Schema.safeParse({ ...base,
    kind: 'semantic_count', query: query('button', 'Save'),
    operator: 'approximately', expected: 1 }).success).toBe(false);
  expect(await evaluate(page, { kind: 'unique_boolean_property', query: query('button', 'Save'),
    property: 'checked', expected: true })).toMatchObject({
      status: 'LOCATOR_BINDING_FAILED', reason: 'UNSUPPORTED_PROPERTY',
    });
});

test('v7 treats a detached unique target as unevaluable after a property read', async () => {
  let reads = 0;
  const locator = { count: async () => ++reads === 1 ? 1 : 0,
    isVisible: async () => false };
  const frame = { getByRole: () => locator };
  const page = { frames: () => [frame], mainFrame: () => frame,
    isClosed: () => false } as unknown as Page;
  expect(await evaluate(page, { kind: 'unique_boolean_property', query: query('button', 'Delete'),
    property: 'visible', expected: true })).toMatchObject({
      status: 'LOCATOR_BINDING_FAILED', reason: 'QUERY_UNEVALUABLE',
    });
});

test('v7 cannot prove absence when a required scope disappears during the count', async () => {
  let scopeReads = 0;
  const target = { count: async () => 0 };
  const scope = { count: async () => ++scopeReads === 1 ? 1 : 0,
    getByRole: () => target };
  const frame = { getByRole: () => scope };
  const page = { frames: () => [frame], mainFrame: () => frame,
    isClosed: () => false } as unknown as Page;
  expect(await evaluate(page, { kind: 'semantic_count', query: {
    ...query('button', 'Delete'), within: [{ kind: 'dialog', name: 'Actions' }] },
    operator: 'equal', expected: 0 })).toMatchObject({
      status: 'LOCATOR_BINDING_FAILED', reason: 'INVALID_SCOPE',
    });
});
