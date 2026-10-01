import http from 'node:http';
import { once } from 'node:events';
import { expect, test, type Frame } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, McpExplorationSession } from '../app/exploration/index.js';
import { admitActionSemanticsV2, buildActionObligationHandoffV2, ActionObligationHandoffV2Schema,
  candidateGroundingDigest, parseActionLabelAssociationObservationV1, parseActionLabelAssociationCheckV1,
  type ActionCandidateRequestV1, type ActionGoalV2, type ActionLabelAssociationObservationV1 } from '../app/domain/index.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { action, relation, spec } from './helpers/action-v2-fixtures.js';

function namedGoal(kind: 'name' | 'context' = 'name', choice = false): ActionGoalV2 {
  return action([[choice ? 'Choose' : 'Fill', 'effect'], [' ', 'neutral'], [choice ? 'Option 1' : 'value', 'argument'],
    [' in ', 'neutral'], ['Country', 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: choice ? 'choose' : 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: choice ? 'choice' : 'entered_text', authoredText: choice ? 'Option 1' : 'value', sourceSegmentIds: ['p2'] },
    { id: 'n', kind: 'constraint', constraint: kind, subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: ['p4'] },
  ]);
}
async function open(html: string, goal = namedGoal(), clock = Date.now) {
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
    factory.catalog.resolve(source.executionProfileRef), 'wp2c-attempt');
  await session.navigate(source.startState.url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp2c-attempt', clock);
  const request: ActionCandidateRequestV1 = { groundingVersion: '1', goalId: goal.id,
    handoff: ActionObligationHandoffV2Schema.parse(buildActionObligationHandoffV2(admission)), mapping: goal.obligations.map((o) => {
      if (o.kind === 'effect' || o.kind === 'operation') return { obligationId: o.id, kind: o.kind };
      if (o.kind === 'argument') return { obligationId: o.id, kind: 'literal' };
      return { obligationId: o.id, kind: 'pending' };
    }) };
  return { runtime, request, session, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
function complete(record: ActionLabelAssociationObservationV1) {
  if (record.status !== 'complete') throw new Error(record.reason); return record;
}
async function observed(run: Awaited<ReturnType<typeof open>>) {
  const candidates = await run.runtime.query(run.request);
  const association = complete(await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' }));
  return { candidates, association };
}
async function bound(run: Awaited<ReturnType<typeof open>>) {
  const record = await observed(run), selected = record.association.associations[0]!;
  return { ...record, binding: await run.runtime.bindLabelAssociation(record.association, selected.selectedRef, selected.frameId) };
}
const labeled = '<label for="country">Country</label><input id="country">';

test('explicit native label uniquely narrows complete WP2A domain with protected readback', async () => {
  const run = await open(labeled + '<label for="other">Other</label><input id="other">');
  try {
    const { candidates, association, binding } = await bound(run);
    expect(candidates).toMatchObject({ count: 2, pendingObligationIds: ['n'] });
    expect(association).toMatchObject({ count: 1, authoredLabel: 'Country', realizedObligationIds: ['e', 'a', 'n'], pendingObligationIds: [],
      associations: [{ accessibleName: 'Country', accessibleNameEqualsAuthoredLabel: true, sources: [{ kind: 'native_label' }] }] });
    expect(parseActionLabelAssociationObservationV1(association)).toEqual(association);
    expect(run.runtime.protectedLabelAssociationRecord(association.observationId)).toEqual(association);
    await run.runtime.withLabelAssociationBinding(binding, async (check) => {
      expect(parseActionLabelAssociationCheckV1(check)).toEqual(check);
      expect(run.runtime.protectedLabelAssociationCheck(check.checkId)).toEqual(check);
      await expect(run.session.snapshot()).rejects.toMatchObject({ reason: 'SESSION_GROUNDING_LOCKED' });
    });
    await expect(run.runtime.withLabelAssociationBinding(binding, async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await run.close(); }
});

test('wrapped native label and aria-labelledby prove semantic ownership', async () => {
  for (const html of ['<label>Country<input></label>', '<span id="label">Country</span><input aria-labelledby="label">']) {
    const run = await open(html);
    try {
      const { association, binding } = await bound(run);
      expect(association.count).toBe(1);
      expect(association.associations[0]!.sources[0]!.kind).toBe(html.includes('aria-labelledby') ? 'aria_labelledby' : 'native_label');
      await run.runtime.withLabelAssociationBinding(binding, async () => {});
    } finally { await run.close(); }
  }
});

test('multiple distinct labels map exact Country without inventing full accessible-name equality', async () => {
  for (const html of ['<label for="country">Country</label><label for="country">Region</label><input id="country">',
    '<span id="a">Country</span><span id="b">Region</span><input aria-labelledby="a b">']) {
    const run = await open(html);
    try {
      const { association, binding } = await bound(run);
      expect(association.associations[0]).toMatchObject({ accessibleName: 'Country Region', accessibleNameEqualsAuthoredLabel: false });
      expect(association.realizedObligationIds).toContain('n');
      await run.runtime.withLabelAssociationBinding(binding, async () => {});
    } finally { await run.close(); }
  }
});

test('duplicate text across controls and one aria label shared by controls preserve ambiguity', async () => {
  for (const html of [labeled + '<label for="other">Country</label><input id="other">',
    '<span id="label">Country</span><input aria-labelledby="label"><input aria-labelledby="label">']) {
    const run = await open(html);
    try {
      const { association } = await observed(run); expect(association.count).toBe(2);
      expect(association.pendingObligationIds).toContain('n');
      const c = association.associations[0]!;
      await expect(run.runtime.bindLabelAssociation(association, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
    } finally { await run.close(); }
  }
});

test('multiple equivalent labels retain the entire unambiguous owner source group', async () => {
  const run = await open(labeled + '<label for="country">Country</label>');
  try {
    const candidates = await run.runtime.query(run.request);
    const association = await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' });
    expect(association).toMatchObject({ status: 'complete', complete: true, count: 1, pendingObligationIds: [] });
    if (association.status === 'complete') expect(association.associations[0]!.sources).toHaveLength(2);
  } finally { await run.close(); }
});

test('unassociated text, orphan label and superseded label cannot supply association', async () => {
  for (const html of ['<label for="missing">Country</label><input>', '<span>Country</span><input>',
    labeled.replace('<input id="country">', '<input id="country" aria-label="Different">')]) {
    const run = await open(html);
    try { const { association } = await observed(run); expect(association).toMatchObject({ count: 0, pendingObligationIds: ['n'] }); }
    finally { await run.close(); }
  }
});

test('context gets exact association facts but remains pending independent semantic endorsement', async () => {
  const run = await open(labeled, namedGoal('context'));
  try {
    const { association, binding } = await bound(run);
    expect(association).toMatchObject({ count: 1, realizedObligationIds: ['e', 'a'], pendingObligationIds: ['n'] });
    await run.runtime.withLabelAssociationBinding(binding, async (check) => { expect(check.completeAssociationObservation.pendingObligationIds).toEqual(['n']); });
  } finally { await run.close(); }
});

test('authored context bytes are never shortened into a label and relationship Email never maps to target', async () => {
  const goal = namedGoal('context'); goal.sourceText = goal.sourceText.replace('Country', 'Country dropdown');
  goal.sourceInstructionSpan.end = goal.sourceText.length;
  goal.sourceAccounting[4]!.authoredText = 'Country dropdown'; goal.sourceAccounting[4]!.sourceSpan.end += 9;
  goal.sourceAccounting[5]!.sourceSpan.start += 9; goal.sourceAccounting[5]!.sourceSpan.end += 9;
  const n = goal.obligations[2]!; if (n.kind === 'constraint') n.authoredText = 'Country dropdown';
  const run = await open(labeled, goal), anchor = await open('<button aria-label="Email">Email</button>', relation());
  try {
    expect((await observed(run)).association.count).toBe(0);
    const candidates = await anchor.runtime.query(anchor.request);
    await expect(anchor.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'l' })).rejects.toMatchObject({ reason: 'UNSUPPORTED_MAPPING' });
    await expect(anchor.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'email' })).rejects.toMatchObject({ reason: 'UNSUPPORTED_MAPPING' });
  } finally { await run.close(); await anchor.close(); }
});

test('hidden single matching control is not actionable; hidden duplicate still prevents uniqueness', async () => {
  for (const duplicate of [false, true]) {
    const run = await open(labeled.replace('<input', '<input style="display:none"') + (duplicate ? '<label for="visible">Country</label><input id="visible">' : ''));
    try {
      const candidates = await run.runtime.query(run.request);
      // WP2A may be unable to issue an aria-ref for a hidden candidate; that remains incomplete.
      if (candidates.status === 'error') { expect(candidates).toMatchObject({ complete: false, reason: 'QUERY_UNEVALUABLE' }); continue; }
      const association = complete(await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' }));
      expect(association.count).toBe(duplicate ? 2 : 1);
      const c = association.associations[0]!;
      await expect(run.runtime.bindLabelAssociation(association, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: duplicate ? 'NON_UNIQUE' : 'NOT_ACTIONABLE' });
    } finally { await run.close(); }
  }
});

test('stale age, MCP revision, hidden, control/source replacement and changed association cannot reuse proof', async () => {
  for (const mode of ['age', 'mcp', 'hidden', 'control', 'label', 'owner', 'text'] as const) {
    let now = Date.now(); const run = await open(labeled, namedGoal(), () => now);
    try {
      const { binding } = await bound(run); let called = false;
      if (mode === 'age') now += 10_001;
      if (mode === 'mcp') await run.session.snapshot();
      if (mode === 'hidden') await run.page.locator('input').evaluate((node) => { node.style.display = 'none'; });
      if (mode === 'control') await run.page.locator('input').evaluate((node) => node.replaceWith(node.cloneNode(true)));
      if (mode === 'label') await run.page.locator('label').evaluate((node) => node.replaceWith(node.cloneNode(true)));
      if (mode === 'owner') await run.page.locator('label').evaluate((node) => node.setAttribute('for', 'missing'));
      if (mode === 'text') await run.page.locator('label').evaluate((node) => { node.textContent = 'Different'; });
      await expect(run.runtime.withLabelAssociationBinding(binding, async () => { called = true; })).rejects.toBeTruthy(); expect(called).toBe(false);
    } finally { await run.close(); }
  }
});

test('all-frame complete associations preserve ambiguity and frame-owned unique proof', async () => {
  for (const duplicate of [false, true]) {
    const run = await open((duplicate ? labeled : '<input>') + `<iframe title="Nested" srcdoc='${labeled}'></iframe>`);
    try {
      const { association } = await observed(run); expect(association.count).toBe(duplicate ? 2 : 1);
      const c = association.associations[0]!;
      if (duplicate) await expect(run.runtime.bindLabelAssociation(association, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
      else {
        const binding = await run.runtime.bindLabelAssociation(association, c.selectedRef, c.frameId);
        expect(c.sources[0]!.ownerFrameId).toBe(binding.frameId);
        await run.page.locator('iframe').evaluate((node) => node.setAttribute('title', 'Changed'));
        await expect(run.runtime.withLabelAssociationBinding(binding, async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
      }
    } finally { await run.close(); }
  }
});

test('forged/substituted association evidence, wrong session/ref/frame and old-route handoff reject', async () => {
  const run = await open(labeled), other = await open(labeled);
  try {
    const first = await observed(run), second = await observed(other), c = first.association.associations[0]!;
    await expect(run.runtime.bindLabelAssociation(second.association, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    for (const field of ['ref', 'source', 'name', 'obligation'] as const) {
      const fake = structuredClone(first.association);
      if (field === 'ref') fake.associations[0]!.selectedRef = 'fabricated';
      if (field === 'source') fake.associations[0]!.sources[0]!.sourceId = 'fabricated';
      if (field === 'name') fake.associations[0]!.accessibleName = 'fabricated';
      if (field === 'obligation') fake.sourceObligation = { ...fake.sourceObligation, id: 'a' };
      const { witnessDigest: _digest, ...data } = fake; fake.witnessDigest = candidateGroundingDigest(data);
      await expect(run.runtime.bindLabelAssociation(fake, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    }
    await expect(run.runtime.bindLabelAssociation(first.association, 'foreign-ref', c.frameId)).rejects.toMatchObject({ reason: 'SELECTED_REF_NOT_MEMBER' });
    await expect(run.runtime.bindLabelAssociation(first.association, c.selectedRef, 'foreign-frame')).rejects.toMatchObject({ reason: 'SELECTED_REF_NOT_MEMBER' });
    const binding = await run.runtime.bindLabelAssociation(first.association, c.selectedRef, c.frameId);
    await expect(run.runtime.enumerateNativeOptions(binding)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await run.close(); await other.close(); }
});

test('isolated native label/IDREF proof resists page-world getter and method spoofing', async () => {
  for (const aria of [false, true]) {
    const run = await open(aria ? '<span id="label">Other</span><input aria-labelledby="label"><span id="fake">Country</span>' : '<label for="country">Other</label><input id="country"><label id="fake">Country</label>');
    try {
      await run.page.evaluate(() => {
        const fake = document.querySelector<HTMLElement>('#fake')!;
        Object.defineProperty(HTMLInputElement.prototype, 'labels', { get() { return [fake]; } });
        Object.defineProperty(HTMLLabelElement.prototype, 'control', { get() { return document.querySelector('input'); } });
        Document.prototype.getElementById = (() => fake) as typeof Document.prototype.getElementById;
      });
      expect((await observed(run)).association.count).toBe(0);
    } finally { await run.close(); }
  }
});

test('complete association bounds and query errors yield no partial cardinality or uniqueness', async () => {
  for (const mode of ['limit', 'query'] as const) {
    const run = await open(mode === 'limit' ? '<label for="country">Country</label>'.repeat(17) + '<input id="country">' : labeled);
    const frame = run.page.mainFrame(), original = frame.locator;
    try {
      const candidates = await run.runtime.query(run.request);
      if (mode === 'query') frame.locator = ((selector, options) => {
        const locator = original.call(frame, selector, options), nested = locator.locator.bind(locator);
        if (selector.startsWith('aria-ref=')) locator.locator = ((s, o) => {
          if (s === 'wp2c_label_facts=') throw new Error('fixture unavailable'); return nested(s, o);
        }) as typeof locator.locator; return locator;
      }) as Frame['locator'];
      const record = await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' });
      expect(record).toMatchObject({ status: 'error', complete: false, reason: mode === 'limit' ? 'RESULT_LIMIT' : 'QUERY_UNEVALUABLE' });
      expect('count' in record).toBe(false); expect('associations' in record).toBe(false);
      await expect(run.runtime.bindLabelAssociation(record, 'ref', 'frame')).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    } finally { frame.locator = original; await run.close(); }
  }
});

test('omitted accepted obligation and caller-authored label/selector code never enter association query', async () => {
  const run = await open(labeled);
  try {
    const request = structuredClone(run.request); request.mapping.pop();
    await expect(run.runtime.query(request)).rejects.toMatchObject({ reason: 'OBLIGATION_MAPPING_MISMATCH' });
    const candidates = await run.runtime.query(run.request);
    for (const extra of [{ label: 'Country' }, { approved: true }, { css: 'input' }, { xpath: '//input' }, { script: 'document.body' }])
      await expect(run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n', ...extra })).rejects.toMatchObject({ reason: 'INVALID_REQUEST' });
  } finally { await run.close(); }
});

test('Country association narrows native choice control but choice remains pending WP2D composition', async () => {
  const run = await open('<label for="country">Country</label><select id="country"><option value="1">Option 1</option></select>' +
    '<select><option value="2">Option 1</option></select>', namedGoal('name', true));
  try {
    const { association, binding } = await bound(run);
    expect(association).toMatchObject({ count: 1, authoredLabel: 'Country', pendingObligationIds: ['a'] });
    await expect(run.runtime.enumerateNativeOptions(binding)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    const next = await bound(run);
    await run.runtime.withLabelAssociationBinding(next.binding, async (check) => {
      expect(check.completeAssociationObservation.pendingObligationIds).toEqual(['a']);
    });
  } finally { await run.close(); }
});

test('association mutation during renewed domain check and inherited expiry crossing reject before consumer', async () => {
  for (const age of [false, true]) {
    let now = Date.now(); const run = await open(labeled, namedGoal(), () => now), frame = run.page.mainFrame(), original = frame.getByRole;
    try {
      const { binding } = await bound(run); let inject = true, called = false;
      frame.getByRole = ((...args: Parameters<Frame['getByRole']>) => {
        const locator = original.apply(frame, args), count = locator.count.bind(locator);
        locator.count = async () => { if (inject) {
          inject = false; if (age) now += 10_001;
          else await run.page.locator('body').evaluate((node) => { node.insertAdjacentHTML('beforeend', '<label for="new">Country</label><input id="new">'); });
        } return count(); }; return locator;
      }) as Frame['getByRole'];
      await expect(run.runtime.withLabelAssociationBinding(binding, async () => { called = true; })).rejects.toMatchObject({ reason: 'STALE_STATE' }); expect(called).toBe(false);
    } finally { frame.getByRole = original; await run.close(); }
  }
});

test('matching aria-label-only control cannot disappear to establish false association uniqueness', async () => {
  for (const html of ['<input aria-label="Country">', labeled + '<input aria-label="Country">']) {
    const run = await open(html);
    try {
      const candidates = await run.runtime.query(run.request);
      const record = await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' });
      expect(record).toMatchObject({ status: 'error', complete: false, reason: 'UNSUPPORTED_CONTROL', pendingObligationIds: ['n'] });
      expect('count' in record).toBe(false);
    } finally { await run.close(); }
  }
});

test('unreviewed combined IDREF, image-alt and hidden-descendant text alternatives stop unsupported', async () => {
  const combined = namedGoal();
  combined.sourceText = combined.sourceText.replace('Country', 'Country Region'); combined.sourceInstructionSpan.end += 7;
  combined.sourceAccounting[4]!.authoredText = 'Country Region'; combined.sourceAccounting[4]!.sourceSpan.end += 7;
  combined.sourceAccounting[5]!.sourceSpan.start += 7; combined.sourceAccounting[5]!.sourceSpan.end += 7;
  const n = combined.obligations[2]!; if (n.kind === 'constraint') n.authoredText = 'Country Region';
  for (const [html, goal] of [
    ['<span id="a">Country</span><span id="b">Region</span><input aria-labelledby="a b">', combined],
    ['<label for="country"><img alt="Country"></label><input id="country">', namedGoal()],
    ['<label for="country">Country<span aria-hidden="true">hidden</span></label><input id="country">', namedGoal()],
  ] as const) {
    const run = await open(html, goal);
    try {
      const candidates = await run.runtime.query(run.request);
      const record = await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' });
      expect(record, html).toMatchObject({ status: 'error', complete: false, reason: 'UNSUPPORTED_CONTROL' });
      expect('count' in record).toBe(false);
    } finally { await run.close(); }
  }
});

test('title/value accessible name cannot fabricate authored label association', async () => {
  for (const html of ['<label for="country"></label><input id="country" title="Country">', '<input title="Country">']) {
    const run = await open(html);
    try {
      const candidates = await run.runtime.query(run.request);
      const record = await run.runtime.queryLabelAssociations(candidates, { labelGroundingVersion: '1', obligationId: 'n' });
      if (record.status === 'complete') expect(record.count).toBe(0);
      else expect(record).toMatchObject({ reason: 'UNSUPPORTED_CONTROL', complete: false });
    } finally { await run.close(); }
  }
});

test('empty eligible domain is complete zero; protected consumer errors propagate and consume binding', async () => {
  const zero = await open('<p>Country</p>'), run = await open(labeled), failure = new Error('trusted-consumer-environment-stop');
  try {
    expect((await observed(zero)).association).toMatchObject({ count: 0, pendingObligationIds: ['n'] });
    const { binding } = await bound(run);
    await expect(run.runtime.withLabelAssociationBinding(binding, async () => { throw failure; })).rejects.toBe(failure);
    await expect(run.runtime.withLabelAssociationBinding(binding, async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await zero.close(); await run.close(); }
});

test('duplicate IDREF names use the actual document-resolved source node and replacement is stale', async () => {
  const run = await open('<span id="label">Country</span><span id="label">Other</span><input aria-labelledby="label">');
  try {
    const { association, binding } = await bound(run);
    expect(association.associations[0]!.sources).toHaveLength(1);
    expect(association.associations[0]).toMatchObject({ accessibleName: 'Country', sources: [{ kind: 'aria_labelledby' }] });
    await run.page.locator('span').first().evaluate((node) => node.remove());
    await expect(run.runtime.withLabelAssociationBinding(binding, async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
  } finally { await run.close(); }
});
