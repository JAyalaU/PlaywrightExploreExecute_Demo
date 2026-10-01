import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import {
  BindingResultSchema,
  LocatorQualityError,
  LocatorSyntaxError,
  acceptGeneratedLocator,
  acceptSemanticRowLocator,
  assessGeneratedLocator,
  bindingResultFromObservation,
  parseGeneratedLocator,
  reviewAuthoredRoleNameIdentity,
  parseAuthoredRoleNameIdentity,
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

test('authored semantic row scope retains a rejected MCP exemplar without accepting its position', () => {
  const raw = "getByRole('link', { name: 'edit' }).nth(1)";
  expect(assessGeneratedLocator(raw).reasons).toContain('UNSUPPORTED_GRAMMAR');
  const accepted = acceptSemanticRowLocator(raw, 'Iuvaret1', 'edit', {
    matchCount: 1, observedTargetMatches: true, role: 'link', accessibleName: 'edit',
  });
  expect(accepted).toMatchObject({ origin: 'semanticRowScope', mcpGeneratedExpression: raw,
    validatedForm: { type: 'within', scope: { type: 'rowWithCell', cellName: 'Iuvaret1' },
      target: { type: 'role', role: 'link', name: 'edit', exact: true } } });
  expect(() => acceptSemanticRowLocator(raw, 'Iuvaret1', 'edit', {
    matchCount: 1, observedTargetMatches: false, role: 'link', accessibleName: 'edit',
  })).toThrow(LocatorQualityError);
  expect(() => acceptSemanticRowLocator('getByText(\'edit\')', 'Iuvaret1', 'edit', {
    matchCount: 1, observedTargetMatches: true, role: 'link', accessibleName: 'edit',
  })).toThrow(LocatorQualityError);
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

test('authored role and exact accessible name establish a reviewed witness without an alphabetic requirement', () => {
  const numeric = { type: 'role', role: 'link', name: '200', exact: true } as const;
  const selected = { role: 'link', accessibleName: '200', matchCount: 1, observedTargetMatches: true } as const;
  expect(reviewAuthoredRoleNameIdentity({
    description: 'link with the text "200" and that takes you to the url: https://example.com/status_codes/200',
  }, numeric, selected)).toMatchObject({ identityBasis: 'role-and-accessible-name', validatedForm: numeric });
  expect(reviewAuthoredRoleNameIdentity({ description: 'button named "Save"' },
    { type: 'role', role: 'button', name: 'Save', exact: true },
    { role: 'button', accessibleName: 'Save', matchCount: 1, observedTargetMatches: true },
  )?.identityBasis).toBe('role-and-accessible-name');
});

test('authored text, name and label accept only the optional explicit colon', () => {
  const expected = { role: 'link', name: '200' };
  const candidate = { type: 'role', role: 'link', name: '200', exact: true } as const;
  const selected = { role: 'link', accessibleName: '200', matchCount: 1, observedTargetMatches: true } as const;
  for (const phrase of ['text', 'name', 'label']) {
    for (const separator of ['', ':']) {
      const description = `link with the ${phrase}${separator} "200"`;
      expect(parseAuthoredRoleNameIdentity(description)).toEqual(expected);
      expect(reviewAuthoredRoleNameIdentity({ description }, candidate, selected)).toMatchObject({
        identityBasis: 'role-and-accessible-name', validatedForm: candidate,
      });
    }
  }
});

test('shared authored identity recognizes bounded explicit unquoted role/name phrases', () => {
  const cases = [
    ['link that says Status Codes', 'link', 'Status Codes'],
    ['link that says "Status Codes"', 'link', 'Status Codes'],
    ['link with text Status Codes', 'link', 'Status Codes'],
    ['link with the text Status Codes', 'link', 'Status Codes'],
    ['link with the text: "200"', 'link', '200'],
    ['link with the text 200', 'link', '200'],
    ['link that says here', 'link', 'here'],
    ['here link in the sentence ending with go here', 'link', 'here'],
    ['Status Codes link', 'link', 'Status Codes'],
    ['button with name Save', 'button', 'Save'],
    ['button with the label: Save', 'button', 'Save'],
  ] as const;
  for (const [description, role, name] of cases) {
    expect(parseAuthoredRoleNameIdentity(description)).toEqual({ role, name });
    const form = { type: 'role', role, name, exact: true } as const;
    expect(reviewAuthoredRoleNameIdentity({ description }, form, {
      role, accessibleName: name, matchCount: 1, observedTargetMatches: true,
    })).toMatchObject({ validatedForm: form });
  }
});

test('authored role/name witness fails closed for incidental text, ambiguity, scope and selected-node mismatch', () => {
  const exact = { type: 'role', role: 'link', name: '200', exact: true } as const;
  const selected = { role: 'link', accessibleName: '200', matchCount: 1, observedTargetMatches: true } as const;
  expect(assessGeneratedLocator("getByText('200')", selected)).toMatchObject({
    status: 'rejected', reasons: ['WEAK_IDENTITY'],
  });
  expect(assessGeneratedLocator("getByText('Save')", {
    role: 'button', accessibleName: 'Save', matchCount: 1, observedTargetMatches: true,
  }).reasons).toContain('WEAK_IDENTITY');
  for (const description of ['200', 'link 200', 'link named "200" or "301"',
    'link named "200" and button named "200"', 'link with the text: "200" or "301"',
    'link with the text:: "200"', 'link with text 200 or 301',
    'link named: "200"', 'link that says: "200"',
    'link with the text: "200" and button named "200"',
    'that says 200', '200 or 301 link', 'link that says Status Codes and button Save',
    'link that says "Status Codes" or link that says "200"',
    'here link in the sentence ending with go another',
    'link with text ', 'link with text "Status Codes" and then click']) {
    expect(parseAuthoredRoleNameIdentity(description)).toBeNull();
    expect(reviewAuthoredRoleNameIdentity({ description }, exact, selected)).toBeNull();
  }
  expect(reviewAuthoredRoleNameIdentity({ description: 'link that says Status Codes' },
    { type: 'role', role: 'link', name: 'Status Codes', exact: true }, {
      role: 'link', accessibleName: 'Status Code', matchCount: 1, observedTargetMatches: true,
    })).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"',
    scope: [{ kind: 'row', description: 'the selected row' }] }, exact, selected)).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"' },
    { type: 'role', role: 'link', name: '200' }, selected)).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"' }, exact,
    { ...selected, accessibleName: '301' })).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"' }, exact,
    { ...selected, role: 'button' })).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"' }, exact,
    { ...selected, observedTargetMatches: false })).toBeNull();
  expect(reviewAuthoredRoleNameIdentity({ description: 'link named "200"' }, exact,
    { ...selected, matchCount: 2 })).toBeNull();
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
