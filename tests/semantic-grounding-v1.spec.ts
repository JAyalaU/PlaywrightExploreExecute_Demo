import http from 'node:http';
import { once } from 'node:events';
import { expect, test, type ElementHandle, type Page } from '@playwright/test';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { admitSemanticIntentV3, type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { parseSemanticGroundingWitnessV1,
  parseSemanticActionExecutionReceiptV1 } from '../app/domain/semantic-grounding-v1.js';
import { SemanticGroundingSessionV1, SemanticGroundingStopV1,
  type SemanticGroundingDiagnosticV1 } from '../app/exploration/semantic-grounding-v1.js';

type Target = Extract<SemanticIntentStepV3, { type: 'action_intent' }>['target'];
const target = (category: string, exactName: string | null = null, ordinal: number | null = null,
  relation: Target['relation'] = 'unspecified', relatedStepId: string | null = null,
  context: string | null = null): Target => ({ category, exactName, context, ordinal, relation, relatedStepId });
const action = (id: string, t: Target, desiredEffect: 'activate' | 'choose' | 'set_value' | 'set_checked',
  value: string | null = null, checkedState: boolean | null = null,
  authoredMechanic: 'click' | 'type' | 'press' | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'action_intent', authoredText: id, target: t, desiredEffect, value, checkedState,
    authoredMechanic, dependsOnStepId: null });
const verify = (id: string, subject: Target | null, observable: 'exists' | 'visible' | 'enabled' |
  'checked' | 'selected' | 'value' | 'url' | 'cardinality', expected: boolean | number | string,
  dependsOnStepId: string | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'verification_intent', authoredText: id, subject, observable,
    comparator: 'equals', expected, dependsOnStepId });
const nav = (url: string): SemanticIntentStepV3 => ({ id: 'nav', type: 'navigate',
  authoredText: 'Navigate', url, dependsOnStepId: null });

async function fixture(html: string, makeSteps: (root: string) => SemanticIntentStepV3[],
  diagnostic?: SemanticGroundingDiagnosticV1) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/' ? `<a href="/case">Case</a>${html}` : html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const root = `http://127.0.0.1:${address.port}/`;
  const steps = makeSteps(root);
  const source = { testSpecId: 'semantic-grounding-fixture', sourceInstruction: 'Offline authored fixture',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
  const spec = { ...source, schemaVersion: '7', sourceContractVersion: '3', semanticMode: 'intent_v2',
    normalizationVersion: 'semantic_intent_normalization_v2', steps };
  const admission = admitSemanticIntentV3(source, spec, { verdict: 'faithful', issues: [] });
  const factory = new ProtectedContextFactory(new NativeProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 1500, navigationMs: 3000, waits: { default: 1500 } },
    profileSchemaVersion: '5', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows', presentationMode: 'headless',
  }]));
  let session: McpExplorationSession | undefined;
  try {
    session = await McpExplorationSession.open(factory, source.executionProfileRef,
      factory.catalog.resolve(source.executionProfileRef), 'semantic-grounding-attempt');
    await session.navigate(root);
    const grounding = new SemanticGroundingSessionV1(session, admission, 'semantic-grounding-attempt', diagnostic);
    return { root, steps, session, grounding, close: async () => {
      await session!.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    } };
  } catch (error) {
    await session?.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}

async function mutateDuringCandidateRead(page: Page, mutate: () => Promise<void>, repeat = false): Promise<() => void> {
  const handle = await page.locator('a,button,input,select,textarea,[role]').first().elementHandle();
  if (!handle) throw new Error('Missing candidate handle');
  const prototype = Object.getPrototypeOf(handle) as { isEnabled: ElementHandle['isEnabled'] };
  const original = prototype.isEnabled;
  let armed = true;
  prototype.isEnabled = async function(this: ElementHandle, ...args: Parameters<ElementHandle['isEnabled']>) {
    if (armed) { if (!repeat) armed = false; await mutate(); }
    return original.apply(this, args);
  };
  return () => { prototype.isEnabled = original; };
}

async function perform(g: SemanticGroundingSessionV1, id: string, mechanic: string) {
  const witness = await g.groundAction(id);
  expect(witness.mechanic).toBe(mechanic);
  expect(parseSemanticGroundingWitnessV1(witness)).toEqual(witness);
  const receipt = await g.executeGroundedAction(witness);
  expect(parseSemanticActionExecutionReceiptV1(receipt)).toEqual(receipt);
  expect(receipt.actionWitnessDigest).toBe(witness.witnessDigest);
  expect(receipt.effectStatus).toBe(mechanic === 'click' ? 'delivery_only' : 'state_proven');
  return witness;
}
async function assertState(g: SemanticGroundingSessionV1, id: string, expected: boolean | number | string,
  observation: string) {
  const witness = await g.groundVerification(id);
  expect(witness.observation).toBe(observation);
  expect(witness.observed).toBe(expected);
  expect(witness.expectedSatisfied).toBe(true);
  expect(parseSemanticGroundingWitnessV1(witness)).toEqual(witness);
  return witness;
}

test('Dropdown: browser evidence chooses link click, native select and owned selected observation', async () => {
  const f = await fixture('<a href="/case">Dropdown</a><select><option>Please select</option><option value="1">Option 1</option></select>',
    (root) => [nav(root), action('link', target('link', 'Dropdown'), 'activate', null, null, 'click'),
      verify('url', null, 'url', `${root}case`, 'link'),
      action('choose', target('dropdown', null, null, 'unspecified', null, 'From the dropdown'),
        'choose', 'Option 1'),
      verify('selected', target('option', 'Option 1', null, 'same_as_step', 'choose'),
        'selected', true, 'choose')]);
  try {
    await perform(f.grounding, 'link', 'click');
    await assertState(f.grounding, 'url', `${f.root}case`, 'url');
    const choice = await perform(f.grounding, 'choose', 'select_option');
    expect(choice.optionProof).toMatchObject({ label: 'Option 1', value: '1', matchCount: 1 });
    const selected = await assertState(f.grounding, 'selected', true, 'native_selected_option');
    expect(selected.evidence.dependentActionReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await f.close(); }
});

test('Add/Remove simple: complete-domain presence and zero-count absence', async () => {
  const html = '<button id="add" onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';b.onclick=()=>b.remove();document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add', target('button', 'Add Element'), 'activate'),
    verify('exists', target('button', 'Delete'), 'exists', true, 'add'),
    action('delete', target('button', 'Delete'), 'activate'),
    verify('absent', target('button', 'Delete'), 'exists', false, 'delete')]);
  try {
    await perform(f.grounding, 'add', 'click');
    await assertState(f.grounding, 'exists', true, 'complete_count');
    await perform(f.grounding, 'delete', 'click');
    const absent = await assertState(f.grounding, 'absent', false, 'complete_count');
    expect(absent.evidence.candidates).toHaveLength(0);
    expect(absent.evidence.selectedDomainIndex).toBeNull();
  } finally { await f.close(); }
});

test('two identical Delete buttons retain complete count and unresolved action ambiguity', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2'),
    action('delete', target('button', 'Delete', null, 'any_matching'), 'activate')]);
  try {
    await perform(f.grounding, 'add1', 'click'); await perform(f.grounding, 'add2', 'click');
    await assertState(f.grounding, 'two', 2, 'complete_count');
    await expect(f.grounding.groundAction('delete')).rejects.toMatchObject({ reason: 'AMBIGUOUS_TARGET' });
  } finally { await f.close(); }
});

test('Checkboxes: authored ordinals prove complete domain and select idempotent state setting', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', (root) => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true),
    verify('checked1', target('checkbox', null, 1), 'checked', true, 'check1'),
    action('uncheck2', target('checkbox', null, 2), 'set_checked', null, false),
    verify('unchecked2', target('checkbox', null, 2), 'checked', false, 'uncheck2')]);
  try {
    const first = await perform(f.grounding, 'check1', 'check');
    expect(first.evidence.ordinalProof).toEqual({ authoredOrdinal: 1, completeDomainCount: 2,
      selectedDomainIndex: 0 });
    await assertState(f.grounding, 'checked1', true, 'boolean_property');
    const second = await perform(f.grounding, 'uncheck2', 'uncheck');
    expect(second.evidence.ordinalProof?.selectedDomainIndex).toBe(1);
    await assertState(f.grounding, 'unchecked2', false, 'boolean_property');
  } finally { await f.close(); }
});

test('idempotent unchecked=false state is proven even when already false', async () => {
  const f = await fixture('<input type="checkbox">', (root) => [nav(root),
    action('uncheck', target('checkbox'), 'set_checked', null, false)]);
  try {
    const witness = await f.grounding.groundAction('uncheck');
    expect(witness.currentChecked).toBe(false);
    const receipt = await f.grounding.executeGroundedAction(witness);
    expect(receipt).toMatchObject({ effectStatus: 'state_proven', observedFinalState: false,
      beforeStateDigest: receipt.afterStateDigest });
  } finally { await f.close(); }
});

test('Dynamic Controls: same-document asynchronous count and enabled states settle at trusted wait ceiling', async () => {
  const html = `<div id="box"><input type="checkbox"></div><input id="text" type="text" disabled>
    <button onclick="setTimeout(()=>document.querySelector('#box input')?.remove(),80)">Remove</button>
    <button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='<input type=checkbox>',80)">Add</button>
    <button onclick="setTimeout(()=>document.querySelector('#text').disabled=false,80)">Enable</button>
    <button onclick="setTimeout(()=>document.querySelector('#text').disabled=true,80)">Disable</button>`;
  const f = await fixture(html, (root) => [nav(root),
    action('remove', target('button', 'Remove'), 'activate'),
    verify('absent', target('checkbox'), 'exists', false, 'remove'),
    action('add', target('button', 'Add'), 'activate'),
    verify('present', target('checkbox'), 'exists', true, 'add'),
    action('enable', target('button', 'Enable'), 'activate'),
    verify('enabled', target('text input'), 'enabled', true, 'enable'),
    action('disable', target('button', 'Disable'), 'activate'),
    verify('disabled', target('text input'), 'enabled', false, 'disable')]);
  try {
    await perform(f.grounding, 'remove', 'click'); await assertState(f.grounding, 'absent', false, 'complete_count');
    await perform(f.grounding, 'add', 'click'); await assertState(f.grounding, 'present', true, 'complete_count');
    await perform(f.grounding, 'enable', 'click'); await assertState(f.grounding, 'enabled', true, 'boolean_property');
    await perform(f.grounding, 'disable', 'click'); await assertState(f.grounding, 'disabled', false, 'boolean_property');
  } finally { await f.close(); }
});

for (const variation of ['removed candidate', 'earlier sibling removed', 'candidate inserted before',
  'candidates reordered'] as const) {
  test(`candidate capture discards an invalid generation when ${variation}`, async () => {
    const html = variation === 'removed candidate' ?
      '<button id="go">Go</button><input id="transient" type="checkbox">' :
      variation === 'candidates reordered' ? '<button id="other">Other</button><button id="go">Go</button>' :
      '<input id="sibling" type="checkbox"><button id="go">Go</button>';
    let starts = 0;
    const f = await fixture(html, (root) => [nav(root), action('go', target('button', 'Go'), 'activate')],
      (event) => { if (event.boundary === 'candidate_read_started') starts++; });
    const page = f.session.browserSession.context.pages()[0]!;
    const restore = await mutateDuringCandidateRead(page, () => page.evaluate((mode) => {
      if (mode === 'removed candidate') document.querySelector('#transient')?.remove();
      else if (mode === 'earlier sibling removed') document.querySelector('#sibling')?.remove();
      else if (mode === 'candidate inserted before') {
        const input = document.createElement('input'); input.id = 'inserted';
        document.body.insertBefore(input, document.querySelector('#go'));
      } else document.body.insertBefore(document.querySelector('#go')!, document.querySelector('#other'));
    }, variation));
    try {
      const witness = await f.grounding.groundAction('go');
      expect(witness.evidence.candidates).toHaveLength(1);
      expect(witness.evidence.candidates[0]?.name).toBe('Go');
      expect(starts).toBeGreaterThanOrEqual(3);
      await f.grounding.executeGroundedAction(witness);
    } finally { restore(); await f.close(); }
  });
}

test('an unrelated control shifting into an old index is never rebound as the authored target', async () => {
  const f = await fixture('<button id="original">Original</button><button id="other">Other</button>',
    (root) => [nav(root), action('original', target('button', 'Original'), 'activate')]);
  const page = f.session.browserSession.context.pages()[0]!;
  const restore = await mutateDuringCandidateRead(page,
    () => page.evaluate(() => document.querySelector('#original')?.remove()));
  try {
    await expect(f.grounding.groundAction('original')).rejects.toMatchObject({ reason: 'UNRESOLVED_TARGET' });
    expect(await page.locator('#other').count()).toBe(1);
  } finally { restore(); await f.close(); }
});

test('a replaced action target cannot dispatch to the new occupant of its old index', async () => {
  const f = await fixture('<button id="go" onclick="this.dataset.clicked=\'yes\'">Go</button>',
    (root) => [nav(root), action('go', target('button', 'Go'), 'activate')]);
  const page = f.session.browserSession.context.pages()[0]!;
  const witness = await f.grounding.groundAction('go');
  const handle = await page.locator('#go').elementHandle();
  if (!handle) throw new Error('Missing action handle');
  const prototype = Object.getPrototypeOf(handle) as { click: ElementHandle['click'] };
  const original = prototype.click;
  prototype.click = async function(this: ElementHandle, ...args: Parameters<ElementHandle['click']>) {
    await page.evaluate(() => {
      const replacement = document.createElement('button'); replacement.id = 'replacement';
      replacement.textContent = 'Go'; replacement.onclick = () => { replacement.dataset.clicked = 'yes'; };
      document.querySelector('#go')?.replaceWith(replacement);
    });
    return original.apply(this, args);
  };
  try {
    await expect(f.grounding.executeGroundedAction(witness)).rejects.toMatchObject({ reason: 'STALE_EVIDENCE' });
    expect(await page.locator('#replacement').getAttribute('data-clicked')).toBeNull();
  } finally { prototype.click = original; await f.close(); }
});

test('ordinal order drifting during action preparation stops before state setting', async () => {
  const f = await fixture('<label id="a">A<input type="checkbox"></label><label id="b">B<input type="checkbox"></label>',
    (root) => [nav(root), action('check', target('checkbox', null, 1), 'set_checked', null, true)]);
  const page = f.session.browserSession.context.pages()[0]!;
  const witness = await f.grounding.groundAction('check');
  const handle = await page.getByRole('checkbox').first().elementHandle();
  if (!handle) throw new Error('Missing checkbox handle');
  const prototype = Object.getPrototypeOf(handle) as { isEnabled: ElementHandle['isEnabled'] };
  const original = prototype.isEnabled;
  let reads = 0;
  prototype.isEnabled = async function(this: ElementHandle, ...args: Parameters<ElementHandle['isEnabled']>) {
    if (++reads === 2) await page.evaluate(() =>
      document.body.insertBefore(document.querySelector('#b')!, document.querySelector('#a')));
    return original.apply(this, args);
  };
  try {
    await expect(f.grounding.executeGroundedAction(witness)).rejects.toMatchObject({ reason: 'STALE_EVIDENCE' });
    expect(await page.getByRole('checkbox').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement).checked))).toEqual([false, false]);
  } finally { prototype.isEnabled = original; await f.close(); }
});

test('continuously changing candidate generation exhausts the trusted capture window as non-QA', async () => {
  const f = await fixture('<button id="go">Go</button>',
    (root) => [nav(root), action('go', target('button', 'Go'), 'activate')]);
  const page = f.session.browserSession.context.pages()[0]!;
  let mutations = 0;
  const restore = await mutateDuringCandidateRead(page, () => page.evaluate(() => {
    const button = document.querySelector('#go')!;
    button.setAttribute('data-revision', String(Number(button.getAttribute('data-revision') ?? '0') + 1));
  }).then(() => { mutations++; }), true);
  try {
    await expect(f.grounding.groundAction('go')).rejects.toMatchObject({ reason: 'STALE_EVIDENCE' });
    expect(mutations).toBeGreaterThan(1);
  } finally { restore(); await f.close(); }
});

test('stable candidate capture completes without recapture', async () => {
  let starts = 0;
  const f = await fixture('<button>Go</button>',
    (root) => [nav(root), action('go', target('button', 'Go'), 'activate')],
    (event) => { if (event.boundary === 'candidate_read_started') starts++; });
  try {
    await f.grounding.groundAction('go');
    expect(starts).toBe(2);
  } finally { await f.close(); }
});

test('negative grounding: out-of-bounds, invented ordinal and explicit mechanic mismatch remain non-QA', async () => {
  const f = await fixture('<input type="checkbox"><button>Go</button>', (root) => [nav(root),
    action('second', target('checkbox', null, 2), 'set_checked', null, true),
    action('click', target('checkbox', null, 1), 'set_checked', null, true, 'click'),
    action('unsupported', target('button', 'Go'), 'set_checked', null, true)]);
  try {
    await expect(f.grounding.groundAction('second')).rejects.toMatchObject({ reason: 'ORDINAL_OUT_OF_BOUNDS' });
    await expect(f.grounding.groundAction('click')).rejects.toMatchObject({ reason: 'EXPLICIT_MECHANIC_MISMATCH' });
    await expect(f.grounding.groundAction('unsupported')).rejects.toMatchObject({ reason: 'UNSUPPORTED_CAPABILITY' });
    expect(() => new SemanticGroundingSessionV1(f.session, {} as never, 'attempt')).toThrow(SemanticGroundingStopV1);
  } finally { await f.close(); }
});

test('created-by relationship identifies one new control without inventing an ordinal', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add', target('button', 'Add Element'), 'activate'),
    action('created', target('button', 'Delete', null, 'created_by_step', 'add'), 'activate')]);
  try {
    await perform(f.grounding, 'add', 'click');
    const created = await f.grounding.groundAction('created');
    expect(created.evidence.relationProof).toMatchObject({ kind: 'created_by_step', relatedStepId: 'add' });
    expect(created.evidence.ordinalProof).toBeNull();
  } finally { await f.close(); }
});

test('value setting is capability-derived; an observed false assertion remains a fact, not QA failure', async () => {
  const f = await fixture('<input type="text" value="old">', (root) => [nav(root),
    action('value', target('text input'), 'set_value', 'new'),
    verify('equal', target('text input'), 'value', 'new', 'value'),
    verify('wrong', target('text input'), 'value', 'missing')]);
  try {
    await perform(f.grounding, 'value', 'fill');
    await assertState(f.grounding, 'equal', 'new', 'value_property');
    const wrong = await f.grounding.groundVerification('wrong', false);
    expect(wrong).toMatchObject({ observed: 'new', expectedSatisfied: false, settled: false });
  } finally { await f.close(); }
});

test('changed target and replayed witness stop before exploration action', async () => {
  const f = await fixture('<button id="go">Go</button>', (root) => [nav(root),
    action('go', target('button', 'Go'), 'activate')]);
  try {
    const witness = await f.grounding.groundAction('go');
    await f.session.browserSession.context.pages()[0]!.evaluate(() => {
      document.querySelector('#go')?.remove();
      const replacement = document.createElement('button'); replacement.textContent = 'Go';
      document.body.insertBefore(replacement, document.body.firstChild);
    });
    await expect(f.grounding.executeGroundedAction(witness)).rejects.toMatchObject({ reason: 'STALE_EVIDENCE' });
    const fresh = await f.grounding.groundAction('go');
    await f.grounding.executeGroundedAction(fresh);
    await expect(f.grounding.executeGroundedAction(fresh)).rejects.toMatchObject({ reason: 'STALE_EVIDENCE' });
  } finally { await f.close(); }
});

test('authored accessible name and literal context require browser proof', async () => {
  const f = await fixture('<button aria-label="Real name">Displayed text</button><select><option>Option 1</option></select>',
    (root) => [nav(root),
      action('inventedName', target('button', 'Displayed text'), 'activate'),
      action('realName', target('button', 'Real name'), 'activate'),
      action('wrongContext', target('dropdown', null, null, 'unspecified', null, 'Settings panel'),
        'choose', 'Option 1')]);
  try {
    await expect(f.grounding.groundAction('inventedName')).rejects.toMatchObject({ reason: 'UNRESOLVED_TARGET' });
    const real = await f.grounding.groundAction('realName');
    expect(real.evidence.candidates[0]).toMatchObject({ role: 'button', name: 'Real name',
      exactNameProven: true });
    await expect(f.grounding.groundAction('wrongContext')).rejects.toMatchObject({ reason: 'UNRESOLVED_TARGET' });
  } finally { await f.close(); }
});

test('returned fill command with wrong final value stops without a successful effect receipt', async () => {
  const f = await fixture('<input type="text" oninput="this.value=\'reset\'">', (root) => [nav(root),
    action('fill', target('text input'), 'set_value', 'wanted')]);
  try {
    const witness = await f.grounding.groundAction('fill');
    await expect(f.grounding.executeGroundedAction(witness)).rejects.toMatchObject({ reason: 'EFFECT_UNPROVEN' });
  } finally { await f.close(); }
});
