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
import { ActionGroundingWitnessV1Schema, parseActionGroundingWitnessV1, parseActionExecutionAttemptV1, parseActionPostEffectV1 } from '../app/domain/action-grounding-execution.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';

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
async function open(html: string, g = goal(), clock: () => number = Date.now) {
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
  const session = await McpExplorationSession.open(factory, s.executionProfileRef, factory.catalog.resolve(s.executionProfileRef), 'wp2d-b-attempt');
  await session.navigate(s.startState.url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp2d-b-attempt', clock);
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

async function prepared(run: Awaited<ReturnType<typeof open>>, label = false) {
  const { outcome } = await prepare(run, correspondence(run.g, label), run.g.obligations.some((o) => o.kind === 'effect' && o.effect === 'choose') ? 'select_option' : run.g.obligations.some((o) => o.kind === 'effect' && o.effect === 'activate') ? 'click' : 'fill');
  if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome)); return outcome.strategy;
}
function activate(role: 'checkbox' | 'radio' | 'button' = 'checkbox') {
  return action([['Click', 'effect'], [' ', 'neutral'], [role, 'target'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: ['p2'] },
  ]);
}
function activationEntries(g: ActionGoalV2): GroundingCorrespondenceV1 {
  return g.obligations.map((obligation) => ({ obligation, realization: obligation.kind === 'effect' ? { kind: 'effect' } :
    { kind: 'role_exact', role: (obligation as Extract<ActionGoalV2['obligations'][number], { kind: 'constraint' }>).authoredText as 'checkbox' | 'radio' | 'button' } }));
}
async function patchAction(run: Awaited<ReturnType<typeof open>>, method: 'fill' | 'selectOption' | 'click' | 'scrollIntoViewIfNeeded' | 'inputValue' | 'dispose' | 'isChecked', replacement: (original: (...args: unknown[]) => Promise<unknown>, owner: unknown, args: unknown[]) => Promise<unknown>) {
  const handle = await run.page.locator('input,select,button').first().elementHandle();
  if (!handle) throw new Error('handle');
  const prototype = Object.getPrototypeOf(handle) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = prototype[method]!;
  prototype[method] = function (...args: unknown[]) { return replacement(original, this, args); };
  return () => { prototype[method] = original; void handle.dispose(); };
}

test('exact native choice executes runtime DOM value with fresh owned selected-state proof', async () => {
  const run = await open(select, goal(true));
  try { const result = await run.runtime.executePreparedGrounding(await prepared(run)); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(await run.page.locator('select').inputValue()).toBe('1');
    if (result.status === 'succeeded') { expect(result.witness.postEffect.effect).toMatchObject({ kind: 'native_choice', value: '1', options: { count: 2 } }); expect(parseActionGroundingWitnessV1(result.witness)).toEqual(result.witness); }
  } finally { await run.close(); }
});

test('Country association and independently endorsed context compose execution across broad two controls', async () => {
  const run = await open(country + select, goal(true, 'context', 'dropdown'));
  try { const result = await run.runtime.executePreparedGrounding(await prepared(run, true)); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(await run.page.locator('#country').inputValue()).toBe('1'); expect(await run.page.locator('select').nth(1).inputValue()).toBe('');
    if (result.status === 'succeeded') expect(result.witness).toMatchObject({ finalCheck: { labelEvidence: [{ count: 1 }], independentExtractionDigest: expect.any(String), candidateObservation: { count: 2 } } });
  } finally { await run.close(); }
});

for (const role of ['checkbox', 'radio'] as const) test(`native ${role} activation requires actual checked transition`, async () => {
  const run = await open(`<input type="${role}">`, activate(role));
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    const result = await run.runtime.executePreparedGrounding(outcome.strategy); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.witness.postEffect.effect).toEqual({ kind: 'native_activation', role, nativeInputType: role, beforeChecked: false, checked: true,
      trustedClickReceipt: { executionId: result.execution.executionId, clicks: 1, targetOwned: true, nativeInputType: role } });
  } finally { await run.close(); }
});

test('generic button activation lacks reviewed effect and stops before mutation', async () => {
  const run = await open('<button onclick="this.textContent=\'Changed\'">Save</button>', activate('button'));
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    expect(await run.runtime.executePreparedGrounding(outcome.strategy)).toMatchObject({ status: 'stop', execution: { status: 'rejected', reason: 'UNSUPPORTED_OPERATION', attempted: false } });
    expect(await run.page.locator('button').textContent()).toBe('Save');
  } finally { await run.close(); }
});

for (const mode of ['second_control', 'replacement', 'hidden', 'wrong_frame'] as const) test(`pre-action ${mode} drift rejects without authored mutation`, async () => {
  const run = await open('<input>');
  try { const p = await prepared(run);
    await run.page.evaluate((mode) => { const input = document.querySelector('input')!;
      if (mode === 'second_control') document.body.append(document.createElement('input'));
      if (mode === 'replacement') input.outerHTML = '<input>';
      if (mode === 'hidden') input.hidden = true;
      if (mode === 'wrong_frame') { const f = document.createElement('iframe'); f.title = 'Other'; f.srcdoc = '<input>'; document.body.append(f); }
    }, mode);
    const result = await run.runtime.executePreparedGrounding(p); expect(result).toMatchObject({ status: 'stop', execution: { status: 'rejected', attempted: false } });
    expect(await run.page.locator('input').first().inputValue()).toBe('');
  } finally { await run.close(); }
});

test('scroll/preparatory mutation cannot reuse previous uniqueness', async () => {
  const run = await open('<input>'); let restore = () => {};
  try { const p = await prepared(run); let fired = false;
    restore = await patchAction(run, 'scrollIntoViewIfNeeded', async (original, owner, args) => { const result = await original.apply(owner, args);
      if (!fired) { fired = true; await run.page.evaluate(() => document.body.append(document.createElement('input'))); } return result; });
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { attempted: false, status: 'rejected' } });
    expect(await run.page.locator('input').first().inputValue()).toBe('');
  } finally { restore(); await run.close(); }
});

test('option list/value or owned label change requires entirely new grounding', async () => {
  const run = await open(country, goal(true, 'name'));
  try { const p = await prepared(run, true); await run.page.locator('option').nth(1).evaluate((o) => (o as HTMLOptionElement).value = 'new');
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { attempted: false } });
    const fresh = await prepared(run, true); expect(fresh.argument?.executableValue).toBe('new');
    expect((await run.runtime.executePreparedGrounding(fresh)).status).toBe('succeeded');
  } finally { await run.close(); }
});

test('page-world value getter spoof cannot become trusted post proof', async () => {
  const run = await open('<input>');
  try { await run.page.evaluate(() => Object.defineProperty(document.querySelector('input'), 'value', { get: () => 'spoofed', set: () => {} }));
    const result = await run.runtime.executePreparedGrounding(await prepared(run)); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.witness.postEffect.effect).toEqual({ kind: 'entered_text', nativeControl: 'input', value: 'hello' });
  } finally { await run.close(); }
});

test('successful command return without intended effect yields no witness', async () => {
  const run = await open('<input>'); let restore = () => {};
  try { const p = await prepared(run); restore = await patchAction(run, 'fill', async () => undefined);
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true, invocationOutcome: 'returned' } });
  } finally { restore(); await run.close(); }
});

test('partial mutation followed by action throw is accounted and never automatically repeated', async () => {
  const run = await open('<input>'); let restore = () => {}, calls = 0;
  try { restore = await patchAction(run, 'fill', async (original, owner, args) => { calls++; await original.apply(owner, args); throw new Error('restricted transport payload'); });
    const result = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.g.id, runtime: run.runtime,
      model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: run.g.id, operation: 'fill', correspondence: correspondence(run.g) }) },
      independentModel: { extract: async () => { throw new Error('unused'); } } });
    expect(result).toMatchObject({ status: 'stop', reason: 'ACTION_FAILED_PARTIAL_OR_UNKNOWN', executionAttempts: [{ status: 'failed', attempted: true }] });
    expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain('restricted transport'); expect(await run.page.locator('input').inputValue()).toBe('hello');
  } finally { restore(); await run.close(); }
});

for (const html of ['<input oninput="this.value=\'different\'">', '<input oninput="this.outerHTML=\'<input value=hello>\'">']) test(`post-action reset/replacement cannot certify effect: ${html.length}`, async () => {
  const run = await open(html);
  try { expect(await run.runtime.executePreparedGrounding(await prepared(run))).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } }); }
  finally { await run.close(); }
});

test('same-markup replacement during post read is checked again before witness publication', async () => {
  const run = await open('<input>'); let restore = () => {};
  try { const p = await prepared(run); let replaced = false;
    restore = await patchAction(run, 'inputValue', async (original, owner, args) => { const result = await original.apply(owner, args);
      if (!replaced) { replaced = true; await run.page.locator('input').evaluate((i) => i.outerHTML = '<input value=hello>'); } return result; });
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven' } });
  } finally { restore(); await run.close(); }
});

test('post-action query failure remains attempted without successful witness', async () => {
  const run = await open('<input>'); let restore = () => {};
  try { const p = await prepared(run); restore = await patchAction(run, 'fill', async (original, owner, args) => { await original.apply(owner, args); await run.page.close(); });
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } });
  } finally { restore(); await run.close(); }
});

test('forged prepared evidence and recomputed malformed post/witness facts reject mechanically', async () => {
  const run = await open(select, goal(true));
  try { const p = await prepared(run), forged = structuredClone(p); forged.argument!.executableValue = 'different';
    const { witnessDigest: _digest, ...data } = forged; forged.witnessDigest = hash(data);
    await expect(run.runtime.executePreparedGrounding(forged)).rejects.toMatchObject({ reason: 'UNTRUSTED_EVIDENCE' });
    const result = await run.runtime.executePreparedGrounding(p); expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    for (const mode of ['count', 'owner', 'effect', 'phase', 'failed', 'source'] as const) {
      const w = structuredClone(result.witness);
      if (w.postEffect.effect.kind !== 'native_choice') throw new Error('choice');
      if (mode === 'count') w.postEffect.effect.options.count = 0;
      if (mode === 'owner') w.postEffect.effect.options.options[0]!.ownerRef = 'wrong';
      if (mode === 'effect') w.postEffect.effect.value = 'different';
      if (mode === 'phase') w.execution.invokedAt = '2099-01-01T00:00:00.000Z';
      if (mode === 'failed') w.execution.status = 'failed';
      if (mode === 'source') w.preparation.correspondence[0]!.obligation.sourceSegmentIds = ['p2'];
      const { witnessDigest: _p, ...pd } = w.postEffect; w.postEffect.witnessDigest = hash(pd); w.execution.postEffectDigest = w.postEffect.witnessDigest;
      const { witnessDigest: _e, ...ed } = w.execution; w.execution.witnessDigest = hash(ed);
      const { witnessDigest: _w, ...wd } = w; w.witnessDigest = hash(wd);
      expect(() => parseActionGroundingWitnessV1(w)).toThrow();
      if (mode === 'count' || mode === 'owner' || mode === 'effect') expect(() => parseActionPostEffectV1(w.postEffect)).toThrow();
    }
  } finally { await run.close(); }
});

test('pre-dispatch stale retry obtains new complete parent and mapping without abandoned evidence in success', async () => {
  const run = await open('<input>'); let count = 0; const parents: string[] = [];
  try { const runtime = { query: run.runtime.query.bind(run.runtime), prepareGrounding: run.runtime.prepareGrounding.bind(run.runtime),
      protectedPreparedGrounding: run.runtime.protectedPreparedGrounding.bind(run.runtime), protectedActionExecution: run.runtime.protectedActionExecution.bind(run.runtime),
      protectedActionGroundingWitness: run.runtime.protectedActionGroundingWitness.bind(run.runtime),
      executePreparedGrounding: async (p: Parameters<typeof run.runtime.executePreparedGrounding>[0], deadline?: number) => {
        const record = parsePreparedActionGroundingV1(p); parents.push(record.candidateObservation.observationId);
        if (++count === 1) await run.page.locator('input').evaluate((i) => i.setAttribute('data-retry', 'true'));
        return run.runtime.executePreparedGrounding(p, deadline);
      } };
    const result = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.g.id, runtime,
      model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: run.g.id, operation: 'fill', correspondence: correspondence(run.g) }) },
      independentModel: { extract: async () => { throw new Error('unused'); } } });
    expect(result.status, JSON.stringify(result)).toBe('succeeded'); expect(new Set(parents).size).toBe(2);
    expect(result.executionAttempts.map((e) => e.status)).toEqual(['rejected', 'succeeded']);
    if (result.status === 'succeeded') expect(result.witness.preparation.candidateObservation.observationId).toBe(parents[1]);
  } finally { await run.close(); }
});

test('exclusive MCP lease blocks competing consumer at pre-action entry', async () => {
  const run = await open('<input>');
  try { const p = await prepared(run); await run.session.withExclusiveGrounding(async () => {
    expect(await run.runtime.executePreparedGrounding(p)).toMatchObject({ status: 'stop', execution: { reason: 'BUSY', attempted: false, status: 'rejected' } });
    expect(await run.page.locator('input').inputValue()).toBe('');
  }); } finally { await run.close(); }
});

test('authored exact role/name and exact entered literal retain source authority during execution', async () => {
  const run = await open('<input aria-label="Country"><input aria-label="Other">', goal(false, 'name', 'textbox'));
  try { const result = await run.runtime.executePreparedGrounding(await prepared(run)); expect(result.status).toBe('succeeded');
    expect(await run.page.getByRole('textbox', { name: 'Country', exact: true }).inputValue()).toBe('hello');
    expect(await run.page.getByRole('textbox', { name: 'Other', exact: true }).inputValue()).toBe('');
    if (result.status === 'succeeded') expect(result.witness.finalCheck.correspondence).toEqual(correspondence(run.g));
  } finally { await run.close(); }
});

test('post-action option replacement/value mutation cannot inherit owner or selected proof', async () => {
  const run = await open(select.replace('<select>', '<select onchange="this.options[1].outerHTML=\'<option value=1 selected>Option 1</option>\'">'), goal(true));
  try { expect(await run.runtime.executePreparedGrounding(await prepared(run))).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } }); }
  finally { await run.close(); }
});

test('native checkbox with prevented default cannot turn click completion into activation truth', async () => {
  const run = await open('<input type=checkbox onclick="event.preventDefault()">', activate());
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    expect(await run.runtime.executePreparedGrounding(outcome.strategy)).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } });
  } finally { await run.close(); }
});

test('post witness validation failure cannot leave a succeeded execution journal', async () => {
  const run = await open('<input>'); const parse = ActionGroundingWitnessV1Schema.parse;
  try { const p = await prepared(run); ActionGroundingWitnessV1Schema.parse = () => { throw new Error('test validation fault'); };
    const result = await run.runtime.executePreparedGrounding(p); expect(result).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } });
    expect(run.runtime.protectedActionExecution(result.execution.executionId)).toEqual(result.execution);
  } finally { ActionGroundingWitnessV1Schema.parse = parse; await run.close(); }
});

test('post-dispatch cleanup failure cannot relabel attempted mutation as a pre-action rejection', async () => {
  const run = await open('<input>'); let restoreFill = () => {}, restoreDispose = () => {};
  try { const p = await prepared(run);
    restoreFill = await patchAction(run, 'fill', async (original, owner, args) => { await original.apply(owner, args);
      restoreDispose = await patchAction(run, 'dispose', async () => { throw new Error('test cleanup fault'); }); });
    const result = await run.runtime.executePreparedGrounding(p); expect(result).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true } });
  } finally { restoreDispose(); restoreFill(); await run.close(); }
});

test('expired shared execution deadline prevents dispatch without enlarging budget', async () => {
  const run = await open('<input>');
  try { const p = await prepared(run); expect(await run.runtime.executePreparedGrounding(p, Date.now() - 1)).toMatchObject({ status: 'stop', execution: { attempted: false, status: 'rejected' } });
    expect(await run.page.locator('input').inputValue()).toBe('');
  } finally { await run.close(); }
});

test('detached and changed successful witness cannot acquire private runtime issuance', async () => {
  const run = await open('<input>');
  try { const result = await run.runtime.executePreparedGrounding(await prepared(run)); if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    const detached = structuredClone(result.witness); detached.witnessId = 'fabricated-witness';
    const { witnessDigest: _digest, ...data } = detached; detached.witnessDigest = hash(data);
    expect(parseActionGroundingWitnessV1(detached)).toEqual(detached);
    expect(run.runtime.protectedActionGroundingWitness(detached.witnessId)).toBeUndefined();
  } finally { await run.close(); }
});

test('expiry crossed in activation readiness read stops before dispatch and cannot inherit old proof', async () => {
  let now = Date.now(); const run = await open('<input type=checkbox>', activate(), () => now); let restore = () => {};
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    restore = await patchAction(run, 'isChecked', async (original, owner, args) => { const value = await original.apply(owner, args); now += 11_000; return value; });
    expect(await run.runtime.executePreparedGrounding(outcome.strategy)).toMatchObject({ status: 'stop', execution: { status: 'rejected', attempted: false, reason: 'STALE_STATE' } });
    restore(); restore = () => {}; expect(await run.page.locator('input').isChecked()).toBe(false);
  } finally { restore(); await run.close(); }
});

test('custom editable textbox is unsupported before mutation without a reviewed post-effect primitive', async () => {
  const run = await open('<div role=textbox contenteditable=true></div>');
  try { expect(await run.runtime.executePreparedGrounding(await prepared(run))).toMatchObject({ status: 'stop', execution: { attempted: false, status: 'rejected', reason: 'UNSUPPORTED_CONTROL' } });
    expect(await run.page.getByRole('textbox').textContent()).toBe('');
  } finally { await run.close(); }
});

test('native textarea retains exact literal and native property proof', async () => {
  const run = await open('<textarea></textarea>');
  try { const result = await run.runtime.executePreparedGrounding(await prepared(run)); expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.witness.postEffect.effect).toEqual({ kind: 'entered_text', nativeControl: 'textarea', value: 'hello' });
  } finally { await run.close(); }
});

test('closed session during protected handoff yields typed environment stop preserving actual attempted accounting', async () => {
  const run = await open('<input>');
  try { const runtime = { query: run.runtime.query.bind(run.runtime), prepareGrounding: run.runtime.prepareGrounding.bind(run.runtime),
      protectedPreparedGrounding: run.runtime.protectedPreparedGrounding.bind(run.runtime), protectedActionExecution: run.runtime.protectedActionExecution.bind(run.runtime),
      protectedActionGroundingWitness: run.runtime.protectedActionGroundingWitness.bind(run.runtime),
      executePreparedGrounding: async (p: unknown, deadline?: number) => { const result = await run.runtime.executePreparedGrounding(p, deadline); await run.session.close(); return result; } };
    const result = await executeActionGoalGroundingV1({ admission: run.admission, goalId: run.g.id, runtime,
      model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: run.g.id, operation: 'fill', correspondence: correspondence(run.g) }) },
      independentModel: { extract: async () => { throw new Error('unused'); } } });
    expect(result).toMatchObject({ status: 'stop', category: 'provider_environment', reason: 'PROTECTED_READBACK_UNAVAILABLE', executionAttempts: [{ status: 'succeeded', attempted: true }] });
    expect(result).not.toHaveProperty('witness');
  } finally { await run.close(); }
});

test('mechanical witness check cannot substitute activation role or bypass inherited invocation expiry', async () => {
  const run = await open('<input type=checkbox>', activate());
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    const result = await run.runtime.executePreparedGrounding(outcome.strategy); if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    for (const mode of ['role', 'expiry'] as const) { const witness = structuredClone(result.witness);
      if (witness.postEffect.effect.kind !== 'native_activation') throw new Error('activation');
      if (mode === 'role') { witness.postEffect.effect.role = 'radio'; witness.postEffect.effect.nativeInputType = 'radio'; witness.postEffect.effect.trustedClickReceipt.nativeInputType = 'radio'; }
      else { witness.execution.invokedAt = new Date(Date.parse(witness.finalCheck.expiresAt) + 1).toISOString();
        witness.execution.returnedAt = witness.execution.invokedAt; witness.execution.finishedAt = witness.execution.invokedAt; witness.postEffect.observedAt = witness.execution.invokedAt; }
      const { witnessDigest: _p, ...pd } = witness.postEffect; witness.postEffect.witnessDigest = hash(pd); witness.execution.postEffectDigest = witness.postEffect.witnessDigest;
      const { witnessDigest: _e, ...ed } = witness.execution; witness.execution.witnessDigest = hash(ed);
      const { witnessDigest: _w, ...wd } = witness; witness.witnessDigest = hash(wd);
      expect(() => parseActionGroundingWitnessV1(witness)).toThrow();
    }
  } finally { await run.close(); }
});

for (const behavior of ['checked_assignment', 'synthetic_click'] as const) test(`overlay ${behavior} cannot substitute another target's pointer action for native activation`, async () => {
  const overlay = behavior === 'checked_assignment' ? "document.querySelector('input').checked=true" : "document.querySelector('input').click()";
  const run = await open(`<input type=checkbox style="margin:80px;width:30px;height:30px"><div onclick="${overlay}" style="position:fixed;inset:0;background:rgba(0,0,0,.1)">Overlay</div>`, activate());
  try { const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    const result = await run.runtime.executePreparedGrounding(outcome.strategy);
    expect(result).toMatchObject({ status: 'stop', execution: { status: 'executed_unproven', attempted: true, reason: 'POST_EFFECT_UNPROVEN' } });
    expect(await run.page.locator('input').isChecked()).toBe(true);
  } finally { await run.close(); }
});

test('page-world event/prototype spoof cannot fabricate or suppress trusted native delivery proof', async () => {
  const run = await open('<input type=checkbox>', activate());
  try { await run.page.evaluate(() => { Object.defineProperty(Event.prototype, 'isTrusted', { get: () => false });
      Object.defineProperty(Event.prototype, 'target', { get: () => document.body });
      document.querySelector('input')!.addEventListener = () => {}; });
    const { outcome } = await prepare(run, activationEntries(run.g), 'click'); if (outcome.status !== 'prepared') throw new Error(JSON.stringify(outcome));
    const result = await run.runtime.executePreparedGrounding(outcome.strategy); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.witness.postEffect.effect).toMatchObject({ trustedClickReceipt: { clicks: 1, executionId: result.execution.executionId, targetOwned: true } });
  } finally { await run.close(); }
});


