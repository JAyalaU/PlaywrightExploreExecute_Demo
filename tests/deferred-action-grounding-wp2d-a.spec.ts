import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } from '../app/exploration/action-candidate-grounding.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { admitActionSemanticsV2, type ActionGoalV2, candidateGroundingDigest as hash } from '../app/domain/index.js';
import { admitGroundingMappingV1, parsePreparedActionGroundingV1, type GroundingCorrespondenceV1 } from '../app/domain/action-grounding-strategy.js';
import { prepareActionGoalGroundingV1 } from '../app/interpretation/action-grounding-controller.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { action, relation, spec } from './helpers/action-v2-fixtures.js';

function goal(choice = false, designation?: 'name' | 'context', role?: string): ActionGoalV2 {
  const pieces: Array<Parameters<typeof action>[0][number]> = [[choice ? 'Select' : 'Fill', 'effect'], [' ', 'neutral'],
    [choice ? 'Option 1' : 'hello', 'argument']];
  const obligations: ActionGoalV2['obligations'] = [
    { id: 'e', kind: 'effect', effect: choice ? 'choose' : 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: choice ? 'choice' : 'entered_text', authoredText: choice ? 'Option 1' : 'hello', sourceSegmentIds: ['p2'] },
  ];
  if (designation) { const i = pieces.length + 1; pieces.push([' in ', 'neutral'], ['Country', 'target']); obligations.push({ id: 'n', kind: 'constraint',
    constraint: designation, subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: [`p${i}`] }); }
  if (role) { const i = pieces.length + 1; pieces.push([' ', 'neutral'], [role, 'target']); obligations.push({ id: 'r', kind: 'constraint',
    constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: [`p${i}`] }); }
  pieces.push(['.', 'neutral']); return action(pieces, obligations);
}
function correspondence(g: ActionGoalV2, label = false): GroundingCorrespondenceV1 {
  return structuredClone(g.obligations).map((obligation) => {
    if (obligation.kind === 'effect' || obligation.kind === 'operation') return { obligation, realization: { kind: obligation.kind } };
    if (obligation.kind === 'argument') return { obligation, realization: { kind: 'literal' } };
    if (obligation.kind === 'constraint' && obligation.subject.kind === 'anchor') return { obligation, realization: { kind: 'pending' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role' && obligation.authoredText === 'button') return { obligation, realization: { kind: 'role_exact', role: 'button' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role') return { obligation,
      realization: obligation.authoredText === 'dropdown' ? { kind: 'role_semantic', role: 'combobox' } : { kind: 'role_exact', role: 'textbox' } };
    if (obligation.kind === 'constraint' && ['name', 'context'].includes(obligation.constraint)) return { obligation,
      realization: label || obligation.constraint === 'context' ? { kind: 'label', text: obligation.authoredText, sourceSegmentIds: obligation.sourceSegmentIds }
        : { kind: 'name_exact', name: obligation.authoredText } };
    return { obligation, realization: { kind: 'pending' } };
  });
}
async function open(html: string, g = goal()) {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('port');
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [addr.port], addresses: ['127.0.0.1'] }] }]));
  const s = spec(g); s.startState.url = `http://127.0.0.1:${addr.port}/`;
  const admission = admitActionSemanticsV2({ testSpecId: s.testSpecId, sourceInstruction: s.sourceInstruction,
    executionProfileRef: s.executionProfileRef, startState: s.startState }, s, structuredClone(s), {
    goalContractVersion: '2', primaryExtractionVersion: 'primary', independentExtractionVersion: 'independent',
    primaryPromptVersion: 'primary', independentPromptVersion: 'independent' });
  const session = await McpExplorationSession.open(factory, s.executionProfileRef, factory.catalog.resolve(s.executionProfileRef), 'wp2d-a-attempt');
  await session.navigate(s.startState.url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp2d-a-attempt');
  return { admission, runtime, session, g, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
async function prepare(run: Awaited<ReturnType<typeof open>>, entries = correspondence(run.g), operation: 'fill' | 'select_option' | 'click' = 'fill', independent = entries) {
  const contexts: unknown[] = [], independentContexts: unknown[] = [];
  const outcome = await prepareActionGoalGroundingV1({ admission: run.admission, goalId: run.g.id, runtime: run.runtime,
    model: { complete: async ({ context }) => { contexts.push(context); return JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: run.g.id, operation, correspondence: entries }); } },
    independentModel: { extract: async ({ context }) => { independentContexts.push(context); return JSON.stringify({ mappingExtractionVersion: '1', goalId: run.g.id, correspondence: independent }); } } });
  return { outcome, contexts, independentContexts };
}
const select = '<select><option value="">Pick</option><option value="1">Option 1</option></select>';
const country = '<label for="country">Country</label>' + select.replace('<select>', '<select id="country">');

test('unnamed unique textbox prepares fill without executing authored action', async () => {
  const run = await open('<input>');
  try { const { outcome, independentContexts } = await prepare(run); expect(outcome.status, JSON.stringify(outcome)).toBe('prepared');
    if (outcome.status === 'prepared') { expect(outcome.strategy).toMatchObject({ executed: false, operation: 'fill', argument: { executableValue: 'hello' } });
      expect(parsePreparedActionGroundingV1(outcome.strategy)).toEqual(outcome.strategy); }
    expect(independentContexts).toHaveLength(0); expect(await run.page.locator('input').inputValue()).toBe('');
  } finally { await run.close(); }
});
test('Select Option 1 on unique unnamed native dropdown preserves argument and derives value', async () => {
  const run = await open(select, goal(true));
  try { const { outcome } = await prepare(run, correspondence(run.g), 'select_option'); expect(outcome.status).toBe('prepared');
    if (outcome.status === 'prepared') { expect(outcome.strategy).toMatchObject({ argument: { authoredText: 'Option 1', executableValue: '1', kind: 'native_choice' }, nativeOptionEvidence: { count: 2 } });
      expect(outcome.strategy.candidateObservation.predicate.names).toEqual([]); }
    expect(await run.page.locator('select').inputValue()).toBe('');
  } finally { await run.close(); }
});
test('Country association composes broad two-dropdown domain with owned choice', async () => {
  const run = await open(country + select, goal(true, 'name'));
  try { const { outcome } = await prepare(run, correspondence(run.g, true), 'select_option'); expect(outcome.status).toBe('prepared');
    if (outcome.status === 'prepared') { expect(outcome.strategy.candidateObservation).toMatchObject({ count: 2, pendingObligationIds: ['a', 'n'] });
      expect(outcome.strategy).toMatchObject({ labelEvidence: [{ obligationId: 'n', count: 1 }], pendingObligationIds: [], nativeOptionEvidence: { ownerRef: outcome.strategy.selectedRef } });
      await expect(run.runtime.bind(outcome.strategy.candidateObservation, outcome.strategy.selectedRef, outcome.strategy.frameId)).rejects.toMatchObject({ reason: 'NON_UNIQUE' });
      expect(run.runtime.protectedPreparedGrounding(outcome.strategy.strategyId)).toEqual(outcome.strategy); }
  } finally { await run.close(); }
});
test('explicit name and role narrow only authored target constraints', async () => {
  const run = await open('<input aria-label="Country"><input aria-label="Other">', goal(false, 'name', 'textbox'));
  try { const { outcome } = await prepare(run); expect(outcome.status).toBe('prepared');
    if (outcome.status === 'prepared') expect(outcome.strategy.candidateObservation).toMatchObject({ count: 1, predicate: { roles: ['textbox'], names: ['Country'] } });
  } finally { await run.close(); }
});
test('multiple eligible controls cannot be narrowed by convenient owned option', async () => {
  const run = await open(select + select.replace('Option 1', 'Different'), goal(true));
  try { expect((await prepare(run, correspondence(run.g), 'select_option')).outcome).toMatchObject({ status: 'stop', category: 'unresolved', reason: 'NON_UNIQUE' }); }
  finally { await run.close(); }
});
test('missing choice stops without selecting another option', async () => {
  const run = await open(select.replace('Option 1', 'Different'), goal(true));
  try { expect((await prepare(run, correspondence(run.g), 'select_option')).outcome).toMatchObject({ status: 'stop', category: 'unresolved', reason: 'OPTION_ABSENT' }); }
  finally { await run.close(); }
});
test('disabled owned option is a distinct unresolved automation stop', async () => {
  const run = await open(select.replace('<option value="1">', '<option value="1" disabled>'), goal(true));
  try { expect((await prepare(run, correspondence(run.g), 'select_option')).outcome).toMatchObject({ status: 'stop', category: 'unresolved', reason: 'OPTION_DISABLED' }); }
  finally { await run.close(); }
});
test('source-first context and authored dropdown role require independent semantic endorsement', async () => {
  const run = await open(country + select, goal(true, 'context', 'dropdown'));
  try { const entries = correspondence(run.g, true), { outcome, independentContexts } = await prepare(run, entries, 'select_option');
    expect(outcome.status).toBe('prepared'); expect(independentContexts).toHaveLength(1);
    const ctx = independentContexts[0] as Record<string, unknown>;
    expect(ctx).toHaveProperty('sourceInstruction', run.admission.spec.sourceInstruction); expect(ctx).toHaveProperty('goal');
    for (const key of ['correspondence', 'decision', 'priorCandidate', 'lastReason', 'snapshot', 'selectedRef', 'browserState']) expect(ctx).not.toHaveProperty(key);
    if (outcome.status === 'prepared') expect(outcome.strategy).toHaveProperty('independentExtractionDigest');
    expect(() => admitGroundingMappingV1(run.admission, run.g.id, entries)).toThrow('ENDORSEMENT_REQUIRED');
  } finally { await run.close(); }
});
test('semantic disagreement and pending context fail without browser-based reinterpretation', async () => {
  const run = await open(country, goal(true, 'context'));
  try { const entries = correspondence(run.g), changed = structuredClone(entries); changed[2]!.realization = { kind: 'pending' };
    expect((await prepare(run, entries, 'select_option', changed)).outcome).toMatchObject({ status: 'stop', category: 'semantic_disagreement' });
    expect((await prepare(run, changed, 'select_option')).outcome).toMatchObject({ status: 'stop', category: 'unsupported', reason: 'PENDING_OBLIGATIONS' });
  } finally { await run.close(); }
});
test('whole authored context maps an exact owned substring only through independent endorsement', async () => {
  const g = action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [' ', 'neutral'],
    ['using the Country dropdown', 'context'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'using the Country dropdown', sourceSegmentIds: ['p4'] },
  ]);
  const run = await open(country + select, g);
  try { const entries = correspondence(g), start = g.sourceText.indexOf('Country');
    entries[2]!.realization = { kind: 'label', text: 'Country', sourceSegmentIds: ['p4'], sourceSpan: { start, end: start + 7 } };
    const { outcome } = await prepare(run, entries, 'select_option'); expect(outcome.status).toBe('prepared');
    if (outcome.status === 'prepared') expect(outcome.strategy.correspondence[2]!.obligation).toMatchObject({ authoredText: 'using the Country dropdown' });
    const fabricated = structuredClone(entries); fabricated[2]!.realization = { kind: 'label', text: 'Country', sourceSegmentIds: ['p2'], sourceSpan: { start, end: start + 7 } };
    expect((await prepare(run, fabricated, 'select_option')).outcome).toMatchObject({ status: 'stop', category: 'unsupported' });
  } finally { await run.close(); }
});
test('malformed context fails preflight before calling independent semantic mapper', async () => {
  const run = await open(country, goal(true, 'context'));
  try { const entries = correspondence(run.g); entries.pop(); const result = await prepare(run, entries, 'select_option');
    expect(result.outcome).toMatchObject({ status: 'stop', category: 'structural' }); expect(result.independentContexts).toHaveLength(0);
  } finally { await run.close(); }
});
test('gapped label assembly and malformed owned spans reject without lexical repairs', async () => {
  const g = action([['Fill', 'effect'], [' ', 'neutral'], ['hello', 'argument'], [' ', 'neutral'],
    ['Coun', 'context'], [' and ', 'neutral'], ['try', 'context'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'hello', sourceSegmentIds: ['p2'] },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive', authoredText: 'Country', sourceSegmentIds: ['p4', 'p6'] },
  ]);
  const run = await open('<label>Country<input></label>', g);
  try { const entries = correspondence(g); entries[2]!.realization = { kind: 'label', text: 'Country', sourceSegmentIds: ['p4', 'p6'] };
    expect((await prepare(run, entries)).outcome).toMatchObject({ status: 'stop', category: 'unsupported' });
    entries[2]!.realization = { kind: 'label', text: 'Country', sourceSegmentIds: ['p4', 'p6'], sourceSpan: { start: 11, end: 18 } };
    expect((await prepare(run, entries)).outcome.status).toBe('stop');
  } finally { await run.close(); }
});
test('omitted changed and target/argument substituted obligations reject mechanically', async () => {
  const run = await open(country, goal(true, 'name'));
  try { for (const mode of ['omit', 'change', 'argument_owner', 'target_owner']) {
    const entries = correspondence(run.g);
    if (mode === 'omit') entries.pop();
    if (mode === 'change') { const o = entries[2]!.obligation; if (o.kind === 'constraint') o.authoredText = 'Other'; }
    if (mode === 'argument_owner') entries[1]!.realization = { kind: 'name_exact', name: 'Option 1' };
    if (mode === 'target_owner') entries[2]!.realization = { kind: 'literal' };
    expect((await prepare(run, entries, 'select_option')).outcome.status).toBe('stop');
  } } finally { await run.close(); }
});
test('operation outside effect family stops before any authored execution', async () => {
  const run = await open('<input>');
  try { expect((await prepare(run, correspondence(run.g), 'click')).outcome).toMatchObject({ status: 'stop', category: 'unsupported', reason: 'UNSUPPORTED_OPERATION' }); }
  finally { await run.close(); }
});
test('stale retries require new complete grounding and bounded exhaustion', async () => {
  for (const exhaust of [false, true]) {
    const run = await open('<input>'); const query = run.runtime.query.bind(run.runtime); let queries = 0;
    run.runtime.query = async (request) => { const result = await query(request); queries++; if (exhaust || queries === 1) run.runtime.invalidate(); return result; };
    try { const { outcome } = await prepare(run); expect(queries).toBe(exhaust ? 3 : 2);
      expect(outcome).toMatchObject(exhaust ? { status: 'stop', category: 'provider_environment', reason: 'STALE_STATE', attempts: 3 } : { status: 'prepared', attempts: 2 });
    } finally { await run.close(); }
  }
});
test('actual DOM drift requires a different fresh observation on retry', async () => {
  const run = await open('<input>'), query = run.runtime.query.bind(run.runtime); const ids: string[] = [];
  run.runtime.query = async (request) => { const observation = await query(request); ids.push(observation.observationId);
    if (ids.length === 1) await run.page.locator('input').evaluate((node) => { node.setAttribute('placeholder', 'changed'); }); return observation; };
  try { const { outcome } = await prepare(run); expect(outcome).toMatchObject({ status: 'prepared', attempts: 2 });
    expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
  } finally { await run.close(); }
});
test('unsupported relationship Email anchor cannot become target label/name', async () => {
  const run = await open('<button>Email</button>', relation());
  try { expect((await prepare(run, correspondence(run.g), 'click')).outcome).toMatchObject({ status: 'stop', category: 'unsupported', reason: 'PENDING_OBLIGATIONS' });
    const entries = correspondence(run.g); const anchor = entries.find((e) => e.obligation.kind === 'constraint')!;
    anchor.realization = { kind: 'name_exact', name: 'Email' };
    expect((await prepare(run, entries, 'click')).outcome.status).toBe('stop');
  } finally { await run.close(); }
});
test('forged correspondence authority and prepared evidence cannot enter trusted runtime journal', async () => {
  const run = await open(select, goal(true));
  try { const { outcome } = await prepare(run, correspondence(run.g), 'select_option'); expect(outcome.status).toBe('prepared'); if (outcome.status !== 'prepared') return;
    const fake = structuredClone(outcome.strategy); fake.argument!.executableValue = 'wrong'; const { witnessDigest: _, ...data } = fake; fake.witnessDigest = hash(data);
    expect(() => parsePreparedActionGroundingV1(fake)).toThrow();
    expect(run.runtime.protectedPreparedGrounding(fake.strategyId)).not.toEqual(fake);
    for (const mode of ['owner', 'omit_obligation'] as const) {
      const bad = structuredClone(outcome.strategy);
      if (mode === 'owner') bad.nativeOptionEvidence!.options[0]!.ownerRef = 'substituted'; else bad.correspondence.pop();
      const { witnessDigest: _bad, ...data } = bad; bad.witnessDigest = hash(data); expect(() => parsePreparedActionGroundingV1(bad)).toThrow();
    }
    await expect(run.runtime.prepareGrounding(outcome.strategy.candidateObservation,
      { admission: run.admission, goalId: run.g.id, correspondence: correspondence(run.g), mappingDigest: outcome.strategy.mappingDigest,
        vocabularyVersion: '1', primaryPromptVersion: 'wp2d_a_primary_v1', independentPromptVersion: 'wp2d_a_independent_v1' }, 'select_option')).rejects.toThrow();
  } finally { await run.close(); }
});
test('provider failure remains environment stop with no old-route fallback', async () => {
  const run = await open('<input>'); let queries = 0;
  try { const outcome = await prepareActionGoalGroundingV1({ admission: run.admission, goalId: run.g.id,
    runtime: { query: async () => { queries++; throw new ActionCandidateGroundingError('BROWSER_FAILURE'); }, prepareGrounding: run.runtime.prepareGrounding.bind(run.runtime), protectedPreparedGrounding: run.runtime.protectedPreparedGrounding.bind(run.runtime) },
    model: { complete: async () => { throw new Error('provider offline'); } }, independentModel: { extract: async () => { throw new Error('unused'); } } });
    expect(outcome).toMatchObject({ status: 'stop', category: 'provider_environment' }); expect(queries).toBe(0);
  } finally { await run.close(); }
});
