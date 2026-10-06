import http from 'node:http';
import { once } from 'node:events';
import { expect, test, type Frame } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, McpExplorationSession } from '../app/exploration/index.js';
import { admitActionSemanticsV2, buildActionObligationHandoffV2, candidateGroundingDigest,
  parseActionCandidateObservationV1, type ActionCandidateObservationV1,
  ActionObligationHandoffV2Schema, type ActionCandidateRequestV1, type ActionGoalV2,
  parseActionCandidateActionCheckV1 } from '../app/domain/index.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { action, activate, choose, relation, spec } from './helpers/action-v2-fixtures.js';

function entered(role?: 'textbox' | 'searchbox', named?: string, unique = false): ActionGoalV2 {
  const pieces: [string, 'effect' | 'neutral' | 'target' | 'argument'][] = [['Fill', 'effect'], [' ', 'neutral']];
  const obligations: ActionGoalV2['obligations'] = [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'fill', sourceSegmentIds: ['p0'] },
  ];
  if (unique) { const i = pieces.length; pieces.push(['only', 'target'], [' ', 'neutral']); obligations.push({
    id: 'u', kind: 'constraint', constraint: 'uniqueness', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'only', sourceSegmentIds: [`p${i}`] }); }
  if (role) { const i = pieces.length; pieces.push([role, 'target'], [' ', 'neutral']); obligations.push({
    id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: [`p${i}`] }); }
  if (named) { const i = pieces.length; pieces.push([named, 'target'], [' ', 'neutral']); obligations.push({
    id: 'n', kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', authoredText: named, sourceSegmentIds: [`p${i}`] }); }
  const i = pieces.length; pieces.push(['hello', 'argument'], ['.', 'neutral']); obligations.push({
    id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'hello', sourceSegmentIds: [`p${i}`] });
  return action(pieces, obligations);
}
async function open(html: string, goal: ActionGoalV2 = entered(), clock = Date.now) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const source = spec(goal); source.startState.url = `http://127.0.0.1:${address.port}/`;
  const trusted = { testSpecId: source.testSpecId, sourceInstruction: source.sourceInstruction,
    executionProfileRef: source.executionProfileRef, startState: source.startState };
  const admission = admitActionSemanticsV2(trusted, source, structuredClone(source), {
    goalContractVersion: '2', primaryExtractionVersion: 'primary', independentExtractionVersion: 'independent',
    primaryPromptVersion: 'primary', independentPromptVersion: 'independent',
  });
  const session = await McpExplorationSession.open(factory, source.executionProfileRef,
    factory.catalog.resolve(source.executionProfileRef), 'wp2a-attempt');
  await session.navigate(source.startState.url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp2a-attempt', clock);
  const request: ActionCandidateRequestV1 = { groundingVersion: '1', goalId: goal.id,
    handoff: ActionObligationHandoffV2Schema.parse(buildActionObligationHandoffV2(admission)), mapping: goal.obligations.map((o) => {
      if (o.kind === 'effect' || o.kind === 'operation') return { obligationId: o.id, kind: o.kind };
      if (o.kind === 'argument') return { obligationId: o.id, kind: 'literal' };
      if (o.kind === 'constraint' && o.constraint === 'role' && o.authoredText === 'textbox')
        return { obligationId: o.id, kind: 'role_exact', role: 'textbox' };
      if (o.kind === 'constraint' && o.constraint === 'name') return { obligationId: o.id, kind: 'name_exact', name: o.authoredText };
      if (o.kind === 'constraint' && o.constraint === 'uniqueness') return { obligationId: o.id, kind: 'unique' };
      return { obligationId: o.id, kind: 'pending' };
    }) };
  return { session, runtime, request, admission, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
function complete(record: ActionCandidateObservationV1) {
  expect(record.status).toBe('complete'); if (record.status !== 'complete') throw new Error(record.reason); return record;
}
async function bound(run: Awaited<ReturnType<typeof open>>) {
  const observation = complete(await run.runtime.query(run.request));
  const c = observation.candidates[0]!;
  const binding = await run.runtime.bind(observation, c.selectedRef, c.frameId);
  return { observation, binding };
}

test('unique unnamed textbox: complete role-domain, protected ref membership and action-time journal', async () => {
  let now = Date.now(); const run = await open('<input>', entered(), () => now);
  try {
    const { observation, binding } = await bound(run);
    expect(observation).toMatchObject({ count: 1, complete: true, pendingObligationIds: [],
      predicate: { roles: ['textbox', 'searchbox'], domain: 'all_current_page_frames' }, candidates: [{ accessibleName: '', role: 'textbox' }] });
    now += 1;
    await run.runtime.withActionTimeBinding(binding, 'fill', async (target, check) => {
      expect(check).toMatchObject({ parentObservationId: observation.observationId, eligibleMatchCount: 1,
        authoredArgument: { purpose: 'entered_text', text: 'hello' }, selectedReferenceMatches: true });
      expect(check.completeCandidateObservation.observedAt).not.toBe(observation.observedAt);
      expect(run.runtime.protectedActionCheck(check.checkId)).toEqual(check);
      const invalid = structuredClone(check);
      if (invalid.completeCandidateObservation.status === 'complete') invalid.completeCandidateObservation.count = 0;
      expect(() => parseActionCandidateActionCheckV1(invalid)).toThrow();
      await expect(run.session.snapshot()).rejects.toMatchObject({ reason: 'SESSION_GROUNDING_LOCKED' });
      await target.fill(check.authoredArgument!.text);
    });
    expect(await run.page.getByRole('textbox').inputValue()).toBe('hello');
    await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => {})).rejects.toBeTruthy();
  } finally { await run.close(); }
});

test('historical candidate state still requires whole-body ARIA', async () => {
  const run = await open('<input>');
  const locator = run.page.mainFrame().locator('body');
  const prototype = Object.getPrototypeOf(locator) as typeof locator;
  const original = prototype.ariaSnapshot;
  let calls = 0;
  try {
    prototype.ariaSnapshot = async () => { calls++; throw new Error('Historical ARIA unavailable'); };
    await expect(run.runtime.query(run.request)).rejects.toMatchObject({ reason: 'BROWSER_FAILURE' });
    expect(calls).toBe(1);
  } finally { prototype.ariaSnapshot = original; await run.close(); }
});

test('unique unnamed combobox binds as candidate; choice membership remains pending', async () => {
  const run = await open('<select><option>Option 1</option></select>', choose());
  try {
    const { observation, binding } = await bound(run);
    expect(observation).toMatchObject({ count: 1, candidates: [{ role: 'combobox', accessibleName: '', nativeSelect: true }], pendingObligationIds: ['a'] });
    let called = false;
    await expect(run.runtime.withActionTimeBinding(binding, 'select_option', async () => { called = true; })).rejects.toMatchObject({ reason: 'PENDING_OBLIGATIONS' });
    expect(called).toBe(false);
  } finally { await run.close(); }
});

test('zero and two candidates cannot authorize a chosen ref', async () => {
  for (const html of ['<button>Other</button>', '<input><input>']) {
    const run = await open(html);
    try {
      const observation = complete(await run.runtime.query(run.request));
      expect(observation.count).toBe(html.includes('input') ? 2 : 0);
      const c = observation.candidates[0];
      await expect(run.runtime.bind(observation, c?.selectedRef ?? 'notpresent', c?.frameId ?? 'frame')).rejects.toMatchObject({
        reason: c ? 'NON_UNIQUE' : 'NO_CANDIDATES' });
    } finally { await run.close(); }
  }
});

test('selected ref outside the complete set, forged evidence, copied admission and changed handoff reject', async () => {
  const run = await open('<input><button>Other</button>');
  try {
    const observation = complete(await run.runtime.query(run.request)), c = observation.candidates[0]!;
    await expect(run.runtime.bind(observation, 'invented', c.frameId)).rejects.toMatchObject({ reason: 'SELECTED_REF_NOT_MEMBER' });
    const fake = structuredClone(observation); fake.candidates[0]!.selectedRef = 'invented';
    const { witnessDigest: _hash, ...data } = fake; fake.witnessDigest = candidateGroundingDigest(data);
    await expect(run.runtime.bind(fake, 'invented', c.frameId)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    expect(() => new ActionCandidateGroundingSessionV1(run.session, structuredClone(run.admission), 'other')).toThrow();
    const request = structuredClone(run.request); request.handoff.goals[0]!.obligationIds.pop();
    await expect(run.runtime.query(request)).rejects.toMatchObject({ reason: 'OBLIGATION_MAPPING_MISMATCH' });
  } finally { await run.close(); }
});

test('stale age and no-effect MCP call invalidate candidate/ref linkage', async () => {
  let now = Date.now(); const run = await open('<input>', entered(), () => now);
  try {
    const first = await bound(run); now += 10_001;
    await expect(run.runtime.bind(first.observation, first.binding.selectedRef, first.binding.frameId)).rejects.toMatchObject({ reason: 'STALE_STATE' });
    const second = await bound(run); await run.session.snapshot();
    await expect(run.runtime.withActionTimeBinding(second.binding, 'fill', async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
  } finally { await run.close(); }
});

test('state drift and same-markup replacement reject before action', async () => {
  for (const replace of [false, true]) {
    const run = await open('<input>');
    try {
      const { binding } = await bound(run);
      if (replace) await run.page.locator('input').evaluate((node) => node.replaceWith(node.cloneNode(true)));
      else await run.page.locator('body').evaluate((node) => { node.appendChild(document.createElement('input')); });
      let called = false;
      await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => { called = true; })).rejects.toMatchObject({ reason: 'STALE_STATE' });
      expect(called).toBe(false);
    } finally { await run.close(); }
  }
});

test('all frames count: second target in nested frame prevents uniqueness', async () => {
  const run = await open('<input><iframe title="Embedded" srcdoc="<input>"></iframe>');
  try {
    const observation = complete(await run.runtime.query(run.request)); expect(observation.count).toBe(2);
    expect(observation.candidates.some((c) => c.frame.kind === 'nested')).toBe(true);
    const c = observation.candidates[0]!;
    await expect(run.runtime.bind(observation, c.selectedRef, c.frameId)).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
  } finally { await run.close(); }
});

test('unique nested ref has frame ownership; frame/page drift and cross-session replay stop', async () => {
  const run = await open('<iframe title="Embedded" srcdoc="<input>"></iframe>');
  const other = await open('<input>');
  try {
    const { binding, observation } = await bound(run);
    expect(observation.candidates[0]!.frame).toMatchObject({ kind: 'nested', anchors: [{ kind: 'title', value: 'Embedded', matchCount: 1 }] });
    await expect(other.runtime.bind(observation, binding.selectedRef, binding.frameId)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    await run.page.locator('iframe').evaluate((node) => node.setAttribute('title', 'Changed'));
    await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
    const fresh = await bound(run); await run.page.goto(run.page.url());
    await expect(run.runtime.withActionTimeBinding(fresh.binding, 'fill', async () => {})).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
  } finally { await run.close(); await other.close(); }
});

test('omitted obligations, unaccepted role/name/frame narrowing and locator language reject', async () => {
  const run = await open('<input aria-label="Name"><input type="search">');
  try {
    const missing = structuredClone(run.request); missing.mapping.pop();
    await expect(run.runtime.query(missing)).rejects.toMatchObject({ reason: 'OBLIGATION_MAPPING_MISMATCH' });
    for (const extra of [{ role: 'textbox' }, { name: 'Name' }, { frame: { kind: 'main' } }, { selector: 'input' }, { css: 'input' }, { xpath: '//input' }, { javascript: 'document.body' }])
      await expect(run.runtime.query({ ...run.request, ...extra })).rejects.toMatchObject({ reason: 'INVALID_REQUEST' });
    const changed = structuredClone(run.request); changed.mapping[0] = { obligationId: 'e', kind: 'role_exact', role: 'textbox' };
    await expect(run.runtime.query(changed)).rejects.toMatchObject({ reason: 'UNSUPPORTED_MAPPING' });
    expect(complete(await run.runtime.query(run.request)).count).toBe(2);
  } finally { await run.close(); }
});

test('explicit authored exact role/name narrowing and role-only uniqueness work', async () => {
  for (const goal of [entered('textbox', 'Name'), entered('textbox', undefined, true)]) {
    const run = await open('<input aria-label="Name"><input type="search" aria-label="Name">', goal);
    try {
      const { observation, binding } = await bound(run);
      expect(observation.count).toBe(1); expect(observation.predicate.roles).toEqual(['textbox']);
      await run.runtime.withActionTimeBinding(binding, 'fill', async (locator) => { await locator.fill('hello'); });
      const bad = structuredClone(run.request);
      const role = bad.mapping.find((m) => m.kind === 'role_exact')!;
      if (role.kind === 'role_exact') role.role = 'searchbox';
      await expect(run.runtime.query(bad)).rejects.toMatchObject({ reason: 'UNSUPPORTED_MAPPING' });
    } finally { await run.close(); }
  }
});

test('truncated, unavailable and unproven-frame query cannot establish uniqueness', async () => {
  for (const html of ['<input>'.repeat(81), '<iframe srcdoc="<input>"></iframe>']) {
    const run = await open(html);
    try {
      const observation = await run.runtime.query(run.request);
      expect(observation).toMatchObject({ status: 'error', complete: false, reason: html.includes('iframe') ? 'UNPROVEN_FRAME' : 'RESULT_LIMIT' });
      expect('count' in observation).toBe(false);
      await expect(run.runtime.bind(observation, 'ref', 'frame')).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    } finally { await run.close(); }
  }
});

test('context/relationship source obligations remain pending; role synonyms cannot gain exact authority', async () => {
  for (const goal of [choose('using'), relation()]) {
    const run = await open(goal.obligations.some((o) => o.kind === 'relationship') ? '<button>Email</button>' :
      '<select aria-label="Country"><option>Option 1</option></select>', goal);
    try {
      const observation = complete(await run.runtime.query(run.request));
      expect(observation.pendingObligationIds.length).toBeGreaterThan(0);
      if (goal.obligations.some((o) => o.kind === 'constraint' && o.constraint === 'role' && o.authoredText === 'dropdown')) {
        const bad = structuredClone(run.request); const m = bad.mapping.find((m) => m.obligationId === 'r')!;
        Object.assign(m, { kind: 'role_exact', role: 'combobox' });
        await expect(run.runtime.query(bad)).rejects.toMatchObject({ reason: 'UNSUPPORTED_MAPPING' });
      }
    } finally { await run.close(); }
  }
});

test('closed, replaced runtime and wrong profile owner cannot use old bindings', async () => {
  const run = await open('<input>');
  try {
    const { binding } = await bound(run);
    new ActionCandidateGroundingSessionV1(run.session, run.admission, 'replacement');
    await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => {})).rejects.toMatchObject({ reason: 'STALE_STATE' });
    const source = spec(entered()); source.executionProfileRef = { id: 'wrong', version: '1' };
    const wrongAdmission = admitActionSemanticsV2({ testSpecId: source.testSpecId, sourceInstruction: source.sourceInstruction,
      executionProfileRef: source.executionProfileRef, startState: source.startState }, source, source, {
      goalContractVersion: '2', primaryExtractionVersion: 'primary', independentExtractionVersion: 'independent',
      primaryPromptVersion: 'primary', independentPromptVersion: 'independent' });
    expect(() => new ActionCandidateGroundingSessionV1(run.session, wrongAdmission, 'wrong')).toThrow('INVALID_REQUEST');
    await run.session.close();
    await expect(run.runtime.query(run.request)).rejects.toMatchObject({ reason: 'STALE_STATE' });
  } finally { await run.close(); }
});

test('renewed complete count detects a second target appearing after initial freshness check', async () => {
  const run = await open('<input>');
  const frame = run.page.mainFrame(), getByRole = frame.getByRole;
  try {
    const { binding } = await bound(run); let inject = true, called = false;
    frame.getByRole = ((...args: Parameters<Frame['getByRole']>) => {
      const locator = getByRole.apply(frame, args);
      if (inject) {
        inject = false; const count = locator.count.bind(locator);
        locator.count = async () => { await run.page.locator('body').evaluate((node) => node.appendChild(document.createElement('input'))); return count(); };
      }
      return locator;
    }) as Frame['getByRole'];
    await expect(run.runtime.withActionTimeBinding(binding, 'fill', async () => { called = true; })).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
    expect(called).toBe(false);
  } finally { frame.getByRole = getByRole; await run.close(); }
});

test('browser query error stays incomplete without a usable count', async () => {
  const run = await open('<input>'); const frame = run.page.mainFrame(), original = frame.getByRole;
  try {
    frame.getByRole = (() => { throw new Error('fixture query unavailable'); }) as Frame['getByRole'];
    const record = await run.runtime.query(run.request);
    expect(record).toMatchObject({ status: 'error', complete: false, reason: 'QUERY_UNEVALUABLE' });
    expect('count' in record).toBe(false);
  } finally { frame.getByRole = original; await run.close(); }
});

test('candidate readback rejects inconsistent count even with recomputed digest', async () => {
  const run = await open('<input>');
  try {
    const record = complete(await run.runtime.query(run.request)); record.count = 0;
    const { witnessDigest: _digest, ...data } = record; record.witnessDigest = candidateGroundingDigest(data);
    expect(() => parseActionCandidateObservationV1(record)).toThrow('INVALID_CANDIDATE_EVIDENCE');
  } finally { await run.close(); }
});
