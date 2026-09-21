import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import {
  BindingResultSchema,
  LocatorQualityError,
  LocatorSyntaxError,
  acceptGeneratedLocator,
  assessGeneratedLocator,
  bindingResultFromObservation,
  parseGeneratedLocator,
} from '../app/locator/index.js';

const manifest = z.object({
  scenarios: z.array(z.object({ id: z.number().int(), locator: z.string() })),
}).parse(JSON.parse(readFileSync('spikes/playwright-mcp/replay-manifest.json', 'utf8')));

const expression = (id: number): string => {
  const found = manifest.scenarios.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Recorded scenario ${id} is missing`);
  return found.locator;
};

const observed = { matchCount: 1, observedTargetMatches: true } as const;

test('recorded locators parse without executing expressions and preserve exact/scoped/frame semantics', () => {
  expect(manifest.scenarios).toHaveLength(12);
  for (const scenario of manifest.scenarios) expect(parseGeneratedLocator(scenario.locator)).toBeTruthy();
  expect(parseGeneratedLocator(expression(4))).toEqual({ type: 'label', value: 'Role', exact: true });
  expect(parseGeneratedLocator(expression(5))).toEqual({
    type: 'within',
    scope: { type: 'role', role: 'dialog', name: 'Edit profile dialog' },
    target: { type: 'role', role: 'button', name: 'Save' },
  });
  expect(parseGeneratedLocator(expression(10))).toEqual({
    type: 'frame', frame: { type: 'title', value: 'payment frame' },
    target: { type: 'role', role: 'button', name: 'Submit' },
  });
});

test('restricted parser rejects code, arbitrary CSS/XPath, positional and unsupported forms', () => {
  for (const value of [
    "locator('button.save')",
    "locator('//button[text()=\"Save\"]')",
    "getByRole('button', { name: 'Save' }).nth(0)",
    "getByRole('button', { name: 'Save' }); process.exit(1)",
    "getByRole('button', { name: /Save/ })",
    "getByRole('button', { name: 'Save', exact: false })",
    "locator('iframe:nth-child(1)').contentFrame().getByRole('button', { name: 'Submit' })",
    "getByRole('button', { name: 'Save' }).filter({ hasText: 'Ready' })",
    "getByLabel('Role', { exact: true, timeout: 0 })",
  ]) expect(() => parseGeneratedLocator(value)).toThrow(LocatorSyntaxError);
});

test('quality keeps grammar, identity, uniqueness and target checks separate', () => {
  const pending = assessGeneratedLocator(expression(1));
  expect(pending.status).toBe('pending_live_checks');
  expect(pending.checks).toMatchObject({ grammar: 'passed', durableIdentity: 'passed', uniqueness: 'not_checked', observedTarget: 'not_checked' });

  const accepted = acceptGeneratedLocator(expression(1), { ...observed, role: 'button', accessibleName: 'Save' });
  expect(accepted).toMatchObject({
    validatedForm: { type: 'role', role: 'button', name: 'Save' },
    observed: { matchCount: 1, role: 'button', accessibleName: 'Save' },
    quality: { status: 'accepted', identityBasis: 'role-and-accessible-name' },
  });
  expect(acceptGeneratedLocator(expression(5), observed).validatedForm.type).toBe('within');
  expect(acceptGeneratedLocator(expression(10), observed).validatedForm.type).toBe('frame');

  expect(assessGeneratedLocator(expression(1), { matchCount: 2 })).toMatchObject({
    status: 'rejected', checks: { grammar: 'passed', durableIdentity: 'passed', uniqueness: 'failed', observedTarget: 'not_checked' },
  });
  expect(assessGeneratedLocator(expression(1), { matchCount: 1, observedTargetMatches: false }).checks.observedTarget).toBe('failed');
  expect(() => assessGeneratedLocator(expression(1), { matchCount: 1 })).toThrow();
});

test('recorded glyph locator replays in the spike but fails durable identity quality', () => {
  const glyph = assessGeneratedLocator(expression(8), observed);
  expect(glyph.status).toBe('rejected');
  expect(glyph.checks).toMatchObject({ grammar: 'passed', durableIdentity: 'failed', uniqueness: 'passed', observedTarget: 'passed' });
  expect(glyph.reasons).toContain('WEAK_IDENTITY');
  expect(() => acceptGeneratedLocator(expression(8), observed)).toThrow(LocatorQualityError);
});

test('scoped meaningful text can pass, while app test ID requires MCP discovery provenance', () => {
  const scoped = "getByRole('region', { name: 'Account' }).getByText('Settings')";
  expect(assessGeneratedLocator(scoped, observed).status).toBe('accepted');
  const testId = "getByTestId('save-action')";
  expect(assessGeneratedLocator(testId, observed).status).toBe('rejected');
  expect(assessGeneratedLocator(testId, { ...observed, testIdProvenance: 'mcp-discovered-stable' }).status).toBe('accepted');
  const frameTestId = "getByTestId('payment-frame').contentFrame().getByRole('button', { name: 'Submit' })";
  expect(parseGeneratedLocator(frameTestId).type).toBe('frame');
  expect(assessGeneratedLocator(frameTestId, observed).status).toBe('rejected');
});

test('binding contract models measured zero, one, many and identity mismatch independently of operations', () => {
  expect(bindingResultFromObservation(0)).toEqual({ reason: 'NO_MATCH', matchCount: 0 });
  expect(bindingResultFromObservation(1, true)).toEqual({ reason: 'BOUND', matchCount: 1, observedTargetMatches: true });
  expect(bindingResultFromObservation(1, false)).toEqual({ reason: 'IDENTITY_MISMATCH', matchCount: 1, observedTargetMatches: false });
  expect(bindingResultFromObservation(2)).toEqual({ reason: 'AMBIGUOUS_MATCH', matchCount: 2 });
  expect(BindingResultSchema.parse({ reason: 'FRAME_RESOLUTION_FAILED' }).reason).toBe('FRAME_RESOLUTION_FAILED');
  expect(BindingResultSchema.parse({ reason: 'UNSUPPORTED_FORM' }).reason).toBe('UNSUPPORTED_FORM');
  expect(BindingResultSchema.safeParse({ reason: 'BOUND', matchCount: 2, observedTargetMatches: true }).success).toBe(false);
  expect(() => bindingResultFromObservation(1)).toThrow();
  expect(() => bindingResultFromObservation(0, true)).toThrow();
  expect(() => bindingResultFromObservation(Number.NaN)).toThrow();
});
