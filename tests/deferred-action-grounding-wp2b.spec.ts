import http from 'node:http';
import { once } from 'node:events';
import { expect, test, type Frame } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, McpExplorationSession } from '../app/exploration/index.js';
import { admitActionSemanticsV2, buildActionObligationHandoffV2, ActionObligationHandoffV2Schema,
  candidateGroundingDigest, parseActionChoiceActionCheckV1, parseActionOptionObservationV1,
  type ActionCandidateRequestV1, type ActionOptionObservationV1, type ActionGoalV2 } from '../app/domain/index.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { choose, spec, action } from './helpers/action-v2-fixtures.js';

async function open(html: string, goal = choose(), clock = Date.now) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const source = spec(goal); source.startState.url = `http://127.0.0.1:${address.port}/`;
  const admission = admitActionSemanticsV2({ testSpecId: source.testSpecId, sourceInstruction: source.sourceInstruction,
    executionProfileRef: source.executionProfileRef, startState: source.startState }, source, structuredClone(source), {
    goalContractVersion: '2', primaryExtractionVersion: 'primary', independentExtractionVersion: 'independent',
    primaryPromptVersion: 'primary', independentPromptVersion: 'independent',
  });
  const session = await McpExplorationSession.open(factory, source.executionProfileRef,
    factory.catalog.resolve(source.executionProfileRef), 'wp2b-attempt');
  await session.navigate(source.startState.url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp2b-attempt', clock);
  const request: ActionCandidateRequestV1 = { groundingVersion: '1', goalId: goal.id,
    handoff: ActionObligationHandoffV2Schema.parse(buildActionObligationHandoffV2(admission)),
    mapping: goal.obligations.map((o) => {
      if (o.kind === 'effect' || o.kind === 'operation') return { obligationId: o.id, kind: o.kind };
      if (o.kind === 'argument') return { obligationId: o.id, kind: 'literal' };
      if (o.kind === 'constraint' && o.constraint === 'name') return { obligationId: o.id, kind: 'name_exact', name: o.authoredText };
      return { obligationId: o.id, kind: 'pending' };
    }) };
  return { runtime, request, session, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
function complete(record: ActionOptionObservationV1) {
  expect(record.status).toBe('complete'); if (record.status !== 'complete') throw new Error(record.reason); return record;
}
async function bound(run: Awaited<ReturnType<typeof open>>) {
  const candidates = await run.runtime.query(run.request);
  if (candidates.status !== 'complete') throw new Error(candidates.reason);
  const c = candidates.candidates[0]!;
  const binding = await run.runtime.bind(candidates, c.selectedRef, c.frameId);
  return { candidates, binding };
}
async function observed(run: Awaited<ReturnType<typeof open>>) {
  const { candidates, binding } = await bound(run);
  return { candidates, binding, observation: complete(await run.runtime.enumerateNativeOptions(binding)) };
}
const html = '<select><option value="">Choose</option><option value="runtime-1">Option 1</option></select>';
function namedChoice(): ActionGoalV2 {
  return action([['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' on ', 'neutral'], ['Country', 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
    { id: 'n', kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: ['p4'] },
  ]);
}

test('unique unnamed native combobox: exact choice maps to runtime value with protected membership/readback', async () => {
  const run = await open(html);
  try {
    const { candidates, binding, observation } = await observed(run);
    expect(candidates.candidates[0]).toMatchObject({ accessibleName: '', role: 'combobox' });
    expect(observation).toMatchObject({ count: 2, complete: true, authoredChoice: 'Option 1', choiceObligationId: 'a',
      options: [{ displayedLabel: 'Choose', value: '', selected: true }, { displayedLabel: 'Option 1', value: 'runtime-1', selected: false,
        ownerRef: binding.selectedRef, ownerFrameId: binding.frameId, ownerBindingId: binding.bindingId, nativeMembership: true }] });
    expect(run.runtime.protectedOptionRecord(observation.observationId)).toEqual(observation);
    await run.runtime.withNativeChoiceBinding(binding, observation, async (target, check) => {
      expect(check).toMatchObject({ operation: 'select_option', executableValue: 'runtime-1', eligibleControlCount: 1,
        realizedObligationIds: ['e', 'a'], pendingObligationIds: [] });
      expect(parseActionChoiceActionCheckV1(check)).toEqual(check);
      expect(run.runtime.protectedChoiceActionCheck(check.checkId)).toEqual(check);
      const forged = structuredClone(check); forged.executableValue = 'fabricated';
      const { witnessDigest: _digest, ...data } = forged; forged.witnessDigest = candidateGroundingDigest(data);
      expect(() => parseActionChoiceActionCheckV1(forged)).toThrow('INVALID_CHOICE_CHECK');
      await expect(run.session.snapshot()).rejects.toMatchObject({ reason: 'SESSION_GROUNDING_LOCKED' });
      await target.selectOption(check.executableValue);
    });
    expect(await run.page.getByRole('combobox').inputValue()).toBe('runtime-1');
    const fresh = await observed(run);
    expect(fresh.observation.options[1]!.selected).toBe(true);
    await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toBeTruthy();
  } finally { await run.close(); }
});

test('native getters preserve script-descendant, ASCII whitespace and empty label semantics exactly', async () => {
  for (const option of ['<option label="">\tOption 1\n</option>', '<option>Option <script>ignored</script>1</option>']) {
    const run = await open(`<select>${option}</select>`);
    try {
      const expected = await run.page.locator('option').evaluate((o) => ({ displayedLabel: (o as HTMLOptionElement).label,
        text: (o as HTMLOptionElement).text, value: (o as HTMLOptionElement).value }));
      const { binding, observation } = await observed(run);
      expect(observation.options[0]).toMatchObject(expected);
      if (expected.displayedLabel === 'Option 1') await run.runtime.withNativeChoiceBinding(binding, observation, async (target, check) => { await target.selectOption(check.executableValue); });
      else await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'OPTION_ABSENT' });
    } finally { await run.close(); }
  }
});

test('native displayed label attribute is authority; raw text/value do not substitute for it', async () => {
  for (const label of ['Option 1', 'Different']) {
    const run = await open(`<select><option label="${label}" value="Option 1">raw text</option></select>`);
    try {
      const { binding, observation } = await observed(run);
      expect(observation.options[0]).toMatchObject({ displayedLabel: label, text: 'raw text', value: 'Option 1' });
      if (label === 'Option 1') await run.runtime.withNativeChoiceBinding(binding, observation, async () => {});
      else await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'OPTION_ABSENT' });
    } finally { await run.close(); }
  }
});

test('absent/duplicate label/duplicate DOM value/disabled option stop before callback', async () => {
  const cases = [
    ['', 'OPTION_ABSENT'],
    ['<option>Other</option>', 'OPTION_ABSENT'],
    ['<option value="a">Option 1</option><option value="b">Option 1</option>', 'OPTION_NON_UNIQUE'],
    ['<option value="same">Other</option><option value="same">Option 1</option>', 'VALUE_NON_UNIQUE'],
    ['<option disabled value="same">Other</option><option value="same">Option 1</option>', 'VALUE_NON_UNIQUE'],
    ['<option disabled>Option 1</option>', 'OPTION_DISABLED'],
    ['<optgroup label="Group" disabled><option>Option 1</option></optgroup>', 'OPTION_DISABLED'],
  ];
  for (const [options, reason] of cases) {
    const run = await open(`<select>${options}</select>`);
    try {
      const { binding, observation } = await observed(run); let called = false;
      await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => { called = true; })).rejects.toMatchObject({ reason });
      expect(called).toBe(false);
    } finally { await run.close(); }
  }
});

test('empty executable DOM value is allowed when exact label/value mapping is unique', async () => {
  const run = await open('<select><option value="x">Other</option><option value="">Option 1</option></select>');
  try {
    const { binding, observation } = await observed(run);
    await run.runtime.withNativeChoiceBinding(binding, observation, async (target, check) => {
      expect(check.executableValue).toBe(''); await target.selectOption(check.executableValue);
    });
    expect(await run.page.getByRole('combobox').inputValue()).toBe('');
  } finally { await run.close(); }
});

test('two matching controls remain ambiguous; options cannot authorize a smaller domain', async () => {
  const run = await open(html + html);
  try {
    const candidates = await run.runtime.query(run.request);
    expect(candidates).toMatchObject({ status: 'complete', count: 2 });
    if (candidates.status !== 'complete') throw new Error('incomplete');
    const c = candidates.candidates[0]!;
    await expect(run.runtime.bind(candidates, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
    await expect(run.runtime.enumerateNativeOptions({ selectedRef: c.selectedRef })).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await run.close(); }
});

test('accepted exact control name disambiguates controls without using option argument as name', async () => {
  const run = await open(html.replace('<select>', '<select aria-label="Country">') + html, namedChoice());
  try {
    const { candidates, binding, observation } = await observed(run);
    expect(candidates).toMatchObject({ count: 1, predicate: { names: ['Country'] } });
    await run.runtime.withNativeChoiceBinding(binding, observation, async () => {});
  } finally { await run.close(); }
});

test('page-owned options/getters cannot fabricate choice facts or membership in another control', async () => {
  const run = await open('<select aria-label="Country" id="target"><option value="real">Other</option></select>' +
    '<select id="foreign"><option value="foreign-value">Option 1</option></select>', namedChoice());
  try {
    await run.page.evaluate(() => {
      const foreign = document.querySelector('#foreign option')!;
      Object.defineProperty(HTMLSelectElement.prototype, 'options', { get() { return [foreign]; } });
      for (const [property, value] of [['value', 'fabricated'], ['label', 'Option 1'], ['text', 'Option 1'], ['selected', false], ['disabled', false]] as const)
        Object.defineProperty(HTMLOptionElement.prototype, property, { get() { return value; } });
      Element.prototype.closest = (() => document.querySelector('#target')) as typeof Element.prototype.closest;
    });
    const { binding, observation } = await observed(run);
    expect(observation).toMatchObject({ count: 1, options: [{ displayedLabel: 'Other', value: 'real', selected: true }] });
    let called = false;
    await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => { called = true; })).rejects.toMatchObject({ reason: 'OPTION_ABSENT' });
    expect(called).toBe(false);
  } finally { await run.close(); }
});

test('query failure is incomplete; candidate query failure is a typed runtime stop', async () => {
  for (const failNative of [false, true]) {
    const run = await open(html), frame = run.page.mainFrame(), original = frame.locator, originalRole = frame.getByRole;
    try {
      const { binding } = await bound(run);
      if (failNative) frame.locator = ((selector, options) => {
        const locator = original.call(frame, selector, options);
        if (selector.startsWith('aria-ref=')) {
          const nested = locator.locator.bind(locator);
          locator.locator = ((s, o) => { if (s === 'wp2b_native_options=') throw new Error('fixture unavailable'); return nested(s, o); }) as typeof locator.locator;
        }
        return locator;
      }) as Frame['locator'];
      else frame.getByRole = (() => { throw new Error('fixture unavailable'); }) as Frame['getByRole'];
      if (failNative) {
        const observation = await run.runtime.enumerateNativeOptions(binding);
        expect(observation).toMatchObject({ status: 'error', complete: false, reason: 'QUERY_UNEVALUABLE' });
        expect('count' in observation).toBe(false);
      } else await expect(run.runtime.enumerateNativeOptions(binding)).rejects.toMatchObject({ reason: 'QUERY_UNEVALUABLE' });
    } finally { frame.locator = original; frame.getByRole = originalRole; await run.close(); }
  }
});

test('enumeration and action reads crossing inherited binding expiry stop stale', async () => {
  for (const actionCheck of [false, true]) {
    let now = Date.now(); const run = await open(html, choose(), () => now);
    const frame = run.page.mainFrame(), original = frame.getByRole;
    try {
      const { binding } = await bound(run);
      const observation = actionCheck ? await run.runtime.enumerateNativeOptions(binding) : undefined;
      let advance = true;
      frame.getByRole = ((...args: Parameters<Frame['getByRole']>) => {
        const locator = original.apply(frame, args), count = locator.count.bind(locator);
        locator.count = async () => { if (advance) { advance = false; now += 10_001; } return count(); }; return locator;
      }) as Frame['getByRole'];
      if (actionCheck) await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
      else await expect(run.runtime.enumerateNativeOptions(binding)).rejects.toMatchObject({ reason: 'STALE_STATE' });
    } finally { frame.getByRole = original; await run.close(); }
  }
});

test('wrong owner/session and forged substituted option/value evidence fail protected readback', async () => {
  const run = await open(html), other = await open(html.replace('runtime-1', 'different-value'));
  try {
    const first = await observed(run), second = await observed(other);
    await expect(run.runtime.withNativeChoiceBinding(first.binding, second.observation, async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    for (const alter of ['value', 'owner', 'choice', 'count'] as const) {
      const forged = structuredClone(first.observation);
      if (alter === 'value') forged.options[1]!.value = 'fabricated';
      if (alter === 'owner') forged.options[1]!.ownerRef = 'wrong-ref';
      if (alter === 'choice') forged.authoredChoice = 'Other';
      if (alter === 'count') forged.count = 1;
      const { witnessDigest: _digest, ...data } = forged; forged.witnessDigest = candidateGroundingDigest(data);
      await expect(run.runtime.withNativeChoiceBinding(first.binding, forged, async () => {})).rejects.toBeTruthy();
      // Failed checks consume bindings; obtain fresh authority for each case.
      Object.assign(first, await observed(run));
    }
    const fake = structuredClone(first.observation); fake.options[0]!.ownerBindingId = 'other-binding';
    const { witnessDigest: _digest, ...data } = fake; fake.witnessDigest = candidateGroundingDigest(data);
    expect(() => parseActionOptionObservationV1(fake)).toThrow('INVALID_OPTION_EVIDENCE');
  } finally { await run.close(); await other.close(); }
});

test('stale age, no-effect MCP revision and same-markup option replacement reject', async () => {
  for (const mode of ['age', 'mcp', 'replace', 'value', 'selection', 'optgroup'] as const) {
    let now = Date.now(); const run = await open('<select><option>Other</option><optgroup><option value="x">Option 1</option></optgroup></select>', choose(), () => now);
    try {
      const { binding, observation } = await observed(run);
      if (mode === 'age') now += 10_001;
      if (mode === 'mcp') await run.session.snapshot();
      if (mode === 'replace') await run.page.locator('option').nth(1).evaluate((o) => o.replaceWith(o.cloneNode(true)));
      if (mode === 'value') await run.page.locator('option').nth(1).evaluate((o) => { (o as HTMLOptionElement).value = 'changed'; });
      if (mode === 'selection') await run.page.locator('option').nth(1).evaluate((o) => { (o as HTMLOptionElement).selected = true; });
      if (mode === 'optgroup') await run.page.locator('optgroup').evaluate((o) => { (o as HTMLOptGroupElement).disabled = true; });
      let called = false;
      await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => { called = true; })).rejects.toBeTruthy();
      expect(called).toBe(false);
    } finally { await run.close(); }
  }
});

test('option list mutation during renewed candidate check and second control appearance stop', async () => {
  for (const addControl of [false, true]) {
    const run = await open(html); const frame = run.page.mainFrame(), original = frame.getByRole;
    try {
      const { binding, observation } = await observed(run); let inject = true, called = false;
      frame.getByRole = ((...args: Parameters<Frame['getByRole']>) => {
        const locator = original.apply(frame, args);
        if (inject) { inject = false; const count = locator.count.bind(locator); locator.count = async () => {
          if (addControl) await run.page.locator('body').evaluate((node) => { const select = document.createElement('select'); select.innerHTML = '<option>Option 1</option>'; node.appendChild(select); });
          else await run.page.locator('select').evaluate((node) => node.appendChild(document.createElement('option')));
          return count();
        }; }
        return locator;
      }) as Frame['getByRole'];
      await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => { called = true; })).rejects.toMatchObject({ reason: addControl ? 'NON_UNIQUE' : 'STALE_STATE' });
      expect(called).toBe(false);
    } finally { frame.getByRole = original; await run.close(); }
  }
});

test('truncation, oversized option and native query failure cannot establish option uniqueness', async () => {
  for (const options of ['<option>Option 1</option>'.repeat(81), `<option>${'x'.repeat(1025)}</option>`]) {
    const run = await open(`<select>${options}</select>`);
    try {
      const { binding } = await bound(run); const observation = await run.runtime.enumerateNativeOptions(binding);
      expect(observation).toMatchObject({ status: 'error', complete: false, reason: 'RESULT_LIMIT' });
      expect('count' in observation).toBe(false); expect('options' in observation).toBe(false);
      await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    } finally { await run.close(); }
  }
});

test('custom combobox stops unsupported instead of approximating ownership', async () => {
  const single = await open('<div role="combobox" tabindex="0" aria-expanded="false">Option 1</div>');
  try {
    const { binding } = await bound(single);
    expect(await single.runtime.enumerateNativeOptions(binding)).toMatchObject({ status: 'error', complete: false, reason: 'UNSUPPORTED_CONTROL' });
  } finally { await single.close(); }
});

test('nested frame ownership, frame drift and pending material obligations remain protected', async () => {
  const run = await open(`<iframe title="Nested" srcdoc='${html}'></iframe>`);
  try {
    const { binding, observation } = await observed(run);
    expect(observation.options[1]!.ownerFrameId).toBe(binding.frameId);
    await run.runtime.withNativeChoiceBinding(binding, observation, async (target, check) => { await target.selectOption(check.executableValue); });
    const fresh = await observed(run); await run.page.locator('iframe').evaluate((node) => node.setAttribute('title', 'Changed'));
    await expect(run.runtime.withNativeChoiceBinding(fresh.binding, fresh.observation, async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
  } finally { await run.close(); }
  const pending = await open(html.replace('<select>', '<select aria-label="Country">'), choose('using'));
  try {
    const { binding, observation } = await observed(pending);
    await expect(pending.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'PENDING_OBLIGATIONS' });
  } finally { await pending.close(); }
});

test('omitted choice obligation and caller supplied value/locator cannot enter enumeration', async () => {
  const run = await open(html);
  try {
    const missing = structuredClone(run.request); missing.mapping.pop();
    await expect(run.runtime.query(missing)).rejects.toMatchObject({ reason: 'OBLIGATION_MAPPING_MISMATCH' });
    const { binding } = await bound(run);
    for (const extra of [{ value: 'runtime-1' }, { css: 'select' }, { xpath: '//select' }, { script: 'document.body' }])
      await expect(run.runtime.enumerateNativeOptions({ ...binding, ...extra })).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    await expect(run.runtime.withActionTimeBinding(binding, 'select_option', async () => {})).rejects.toMatchObject({ reason: 'PENDING_OBLIGATIONS' });
  } finally { await run.close(); }
});

test('trusted consumer failure propagates unchanged and consumes the binding even after a partial action', async () => {
  const run = await open(html), failure = new Error('trusted-consumer-environment-stop');
  try {
    const { binding, observation } = await observed(run);
    await expect(run.runtime.withNativeChoiceBinding(binding, observation, async (target, check) => {
      await target.selectOption(check.executableValue); throw failure;
    })).rejects.toBe(failure);
    expect(await run.page.getByRole('combobox').inputValue()).toBe('runtime-1');
    await expect(run.runtime.withNativeChoiceBinding(binding, observation, async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await run.close(); }
});
