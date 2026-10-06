import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { ActionCandidateGroundingSessionV1 } from '../app/exploration/action-candidate-grounding.js';
import { TrustedObservationSessionV1 } from '../app/exploration/trusted-observation.js';
import { normalizePocSemanticExtraction } from '../app/interpretation/deferred-action-poc-normalize.js';
import { admitPocSemanticFidelityV2, buildActionObligationHandoffV2 } from '../app/domain/action-semantic-admission.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';
import type { PocPrimaryResponse } from '../app/interpretation/deferred-action-poc-wire.js';
import { DeferredBrowserDiagnosticCollector } from '../app/domain/deferred-browser-diagnostics.js';
import { DeferredWorkflowStopStoreV1 } from '../app/evidence/deferred-workflow-store.js';

type Extracted = Extract<PocPrimaryResponse, { kind: 'extraction' }>;
type Step = Extracted['steps'][number];
const link = (dependsOnStepId: string | null = null): Step => ({ id: 'click', type: 'action_goal', effect: 'activate',
  explicitOperation: 'click', targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
    { kind: 'name', value: 'Dropdown', polarity: 'positive' }], argument: null, dependsOnStepId });
const select = (): Extract<Step, { type: 'action_goal' }> => ({ id: 'choose', type: 'action_goal', effect: 'choose', explicitOperation: 'select_option',
  targetConstraints: [{ kind: 'role', value: 'dropdown', polarity: 'positive' }],
  argument: { purpose: 'choice', value: 'Option 1' }, dependsOnStepId: null });

async function fixture(html: string, step: Step, destination?: string) {
  const server = http.createServer((request, response) => { response.setHeader('content-type', 'text/html');
    response.end(request.url === '/next' ? '<h1>Arrived</h1>' : html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `http://127.0.0.1:${address.port}/`;
  const source = { testSpecId: 'poc-grounding-fixture', sourceInstruction: destination ?? 'Perform the authored UI action.',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
  const steps: Extracted['steps'] = step.type === 'action_goal' && step.dependsOnStepId ?
    [{ id: step.dependsOnStepId, type: 'navigate', url }, step] : [step];
  const spec = normalizePocSemanticExtraction(source, { kind: 'extraction', steps });
  const admission = admitPocSemanticFidelityV2(source, spec, { verdict: 'faithful', issues: [] });
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  let session: McpExplorationSession | undefined;
  try {
    session = await McpExplorationSession.open(factory, spec.executionProfileRef,
      factory.catalog.resolve(spec.executionProfileRef), 'poc-grounding-attempt');
    await session.navigate(url);
    const diagnostics = new DeferredBrowserDiagnosticCollector();
    const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'poc-grounding-attempt',
      Date.now, undefined, diagnostics.record);
    return { session, server, url, runtime, admission, diagnostics, close: async () => {
      await session!.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    } };
  } catch (error) {
    await session?.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}

test('candidate diagnostics separate initial state, enumeration, fresh state and final result', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  try {
    const result = await run(f, 'choose');
    expect(result.status).toBe('succeeded');
    const events = f.diagnostics.snapshot().filter(event => event.stepId === 'choose');
    expect(events.map(event => event.operation)).toEqual(expect.arrayContaining([
      'initial_state', 'candidate_enumeration', 'candidate_filtering', 'fresh_state',
      'freshness_comparison', 'final_result']));
    expect(events.every(event => event.startedAtMs <= event.endedAtMs && event.elapsedMs >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Option 1');
    expect(JSON.stringify(events)).not.toContain('<select>');
  } finally { await f.close(); }
});

test('private enumeration records role-only predicate, independent role counts and native select inventory', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  const root = await mkdtemp(path.join(tmpdir(), 'enumeration-diagnostics-'));
  try {
    const outcome = await run(f, 'choose');
    expect(outcome.status).toBe('succeeded');
    const events = f.diagnostics.snapshot().filter(event => event.stepId === 'choose');
    const predicate = events.find(event => event.operation === 'enumeration_predicate');
    expect(predicate).toMatchObject({ authoredOperation: 'select_option', semanticTargetRole: 'dropdown',
      attemptedRoles: ['combobox', 'listbox'], exactNameConstraintPresent: false,
      labelConstraintPresent: false, contextConstraintPresent: false, choiceConstraintPresent: true,
      sourceConstraintDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(events.find(event => event.operation === 'role_pre_name' && event.concreteRole === 'combobox'))
      .toMatchObject({ preNameCount: 1, exactNameConstraintPresent: false,
        frameId: expect.stringMatching(/^frame-/), currentUrl: f.url, elapsedMs: expect.any(Number) });
    expect(events.find(event => event.operation === 'role_pre_name' && event.concreteRole === 'listbox'))
      .toMatchObject({ preNameCount: 0 });
    expect(events.some(event => event.operation === 'role_post_name')).toBe(false);
    expect(events.find(event => event.operation === 'native_select_inventory'))
      .toMatchObject({ nativeSelectCount: 1, visibleNativeSelectCount: 1, enabledNativeSelectCount: 1 });
    expect(JSON.stringify(events)).not.toContain('Option 1');
    expect(JSON.stringify(outcome)).not.toContain('nativeSelectCount');
    const store = new DeferredWorkflowStopStoreV1(root);
    await store.writeBrowserDiagnostics('enumeration-spec', events);
    expect(await store.readBrowserDiagnostics('enumeration-spec')).toEqual(events);
    const stored = await readFile(path.join(root, 'deferred-browser-diagnostics-v1', 'enumeration-spec', 'browser.json'), 'utf8');
    expect(stored).toContain('preNameCount');
    expect(stored).not.toContain('Option 1');
    expect(stored).not.toContain('<select>');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [name, label, expected] of [
  ['Wrong control', 'Preferred control', 0], ['Preferred control', 'Preferred control', 1],
] as const) {
  test(`private pre/post exact-name counts retain the ${expected ? 'matching' : 'mismatching'} production outcome`, async () => {
    const step = select();
    step.targetConstraints.push({ kind: 'name', value: name, polarity: 'positive' });
    const f = await fixture(`<select aria-label="${label}"><option>Option 1</option></select>`, step);
    try {
      const outcome = await run(f, 'choose');
      expect(outcome.status).toBe(expected ? 'succeeded' : 'stop');
      const events = f.diagnostics.snapshot().filter(event => event.stepId === 'choose');
      expect(events.find(event => event.operation === 'enumeration_predicate'))
        .toMatchObject({ exactNameConstraintPresent: true, attemptedRoles: ['combobox', 'listbox'] });
      expect(events.find(event => event.operation === 'role_pre_name' && event.concreteRole === 'combobox'))
        .toMatchObject({ preNameCount: 1, exactNameConstraintPresent: true });
      expect(events.find(event => event.operation === 'role_post_name' && event.concreteRole === 'combobox'))
        .toMatchObject({ postNameCount: expected, exactNameConstraintPresent: true });
      expect(events.find(event => event.operation === 'native_select_inventory'))
        .toMatchObject({ nativeSelectCount: 1 });
      expect(JSON.stringify(events)).not.toContain(name);
      expect(JSON.stringify(events)).not.toContain(label);
      expect(JSON.stringify(events)).not.toContain('Option 1');
    } finally { await f.close(); }
  });
}

test('private inventory distinguishes absent control from semantic-role miss without fallback', async () => {
  const absent = await fixture('<button>Unrelated</button>', select());
  try {
    expect((await run(absent, 'choose')).status).toBe('stop');
    const events = absent.diagnostics.snapshot();
    expect(events.filter(event => event.operation === 'role_pre_name').map(event => event.preNameCount)).toEqual([0, 0]);
    expect(events.find(event => event.operation === 'native_select_inventory')).toMatchObject({ nativeSelectCount: 0 });
  } finally { await absent.close(); }

  const missed = await fixture('<select><option>Option 1</option></select>', select());
  const frame = missed.session.browserSession.context.pages()[0]!.mainFrame();
  const originalGetByRole = frame.getByRole;
  try {
    frame.getByRole = ((role, options) => originalGetByRole.call(frame,
      role === 'combobox' ? 'listbox' : role, options)) as typeof frame.getByRole;
    expect((await run(missed, 'choose')).status).toBe('stop');
    const events = missed.diagnostics.snapshot();
    expect(events.filter(event => event.operation === 'role_pre_name').map(event => event.preNameCount)).toEqual([0, 0]);
    expect(events.find(event => event.operation === 'native_select_inventory')).toMatchObject({ nativeSelectCount: 1 });
    expect(events.find(event => event.operation === 'candidate_enumeration')).toMatchObject({ candidateCount: 0 });
  } finally { frame.getByRole = originalGetByRole; await missed.close(); }
});

test('private native select visibility and enabled counts do not grant actionability', async () => {
  const f = await fixture('<select hidden disabled><option>Option 1</option></select>', select());
  try {
    expect((await run(f, 'choose')).status).toBe('stop');
    expect(f.diagnostics.snapshot().find(event => event.operation === 'native_select_inventory'))
      .toMatchObject({ nativeSelectCount: 1, visibleNativeSelectCount: 0, enabledNativeSelectCount: 0 });
  } finally { await f.close(); }
});

for (const failure of ['initial_state', 'candidate_enumeration', 'fresh_state',
  'freshness_comparison', 'closed_page', 'disconnected_browser'] as const) {
  test(`candidate diagnostics isolate ${failure} failure`, async () => {
    const f = await fixture('<select><option>Option 1</option></select>', select());
    const page = f.session.browserSession.context.pages()[0]!, frame = page.mainFrame();
    const originalContent = frame.content;
    const locator = frame.getByRole('combobox');
    const proto = Object.getPrototypeOf(locator) as typeof locator;
    const originalCount = proto.count;
    let reads = 0;
    try {
      if (failure === 'initial_state') frame.content = async () => { throw new Error('secret DOM failure'); };
      if (failure === 'fresh_state') frame.content = async () => {
        if (++reads === 2) throw new Error('secret fresh DOM failure');
        return originalContent.call(frame);
      };
      if (failure === 'freshness_comparison') frame.content = async () => {
        const content = await originalContent.call(frame);
        return ++reads === 2 ? `${content}\n<!-- harmless drift -->` : content;
      };
      if (failure === 'candidate_enumeration') proto.count = async () => { throw new Error('secret query failure'); };
      if (failure === 'closed_page') await page.close();
      if (failure === 'disconnected_browser') await f.session.browserSession.context.browser()?.close();
      const outcome = await run(f, 'choose');
      expect(outcome.status).toBe('stop');
      const events = f.diagnostics.snapshot().filter(event => event.stepId === 'choose');
      const expected = failure === 'closed_page' || failure === 'disconnected_browser' ? 'initial_state' : failure;
      expect(events.some(event => event.operation === expected && event.outcome === 'failure')).toBe(true);
      if (failure === 'candidate_enumeration')
        expect(events.find(event => event.operation === expected)).toMatchObject({ browserOperation: 'locator_count' });
      if (failure === 'fresh_state' || failure === 'initial_state')
        expect(events.find(event => event.operation === expected)).toMatchObject({ browserOperation: 'frame_content' });
      if (failure === 'closed_page') expect(events.find(event => event.operation === expected)?.page).toBe('absent');
      if (failure === 'disconnected_browser') expect(events.find(event => event.operation === expected)?.browser).toBe('disconnected');
      expect(JSON.stringify(events)).not.toContain('secret');
      expect(JSON.stringify(events)).not.toContain('<select>');
    } finally { frame.content = originalContent; proto.count = originalCount; await f.close(); }
  });
}
test('PoC candidate grounding does not invoke whole-body ARIA even when that API fails', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  const root = await mkdtemp(path.join(tmpdir(), 'protected-aria-diagnostic-'));
  const frame = f.session.browserSession.context.pages()[0]!.mainFrame();
  const locator = frame.locator('body');
  const proto = Object.getPrototypeOf(locator) as typeof locator;
  const original = proto.ariaSnapshot;
  let calls = 0;
  try {
    proto.ariaSnapshot = async () => { calls++; throw new Error('Execution context was destroyed; secret=token'); };
    const outcome = await run(f, 'choose');
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    expect(calls).toBe(0);
    const events = f.diagnostics.snapshot();
    const initial = events.find(event => event.stepId === 'choose' && event.operation === 'initial_state');
    expect(initial).toMatchObject({ outcome: 'success', page: 'open', browser: 'connected' });
    expect(events.some(event => event.browserOperation === 'aria_snapshot')).toBe(false);
    expect(events.some(event => event.operation === 'candidate_enumeration' && event.outcome === 'success')).toBe(true);
    const store = new DeferredWorkflowStopStoreV1(root);
    await store.writeBrowserDiagnostics('protected-aria-spec', events);
    expect(await store.readBrowserDiagnostics('protected-aria-spec')).toEqual(events);
    const stored = await readFile(path.join(root, 'deferred-browser-diagnostics-v1', 'protected-aria-spec', 'browser.json'), 'utf8');
    expect(stored).not.toContain('secret=token');
    expect(JSON.stringify(outcome)).not.toContain('secret=token');
  } finally { proto.ariaSnapshot = original; await f.close(); await rm(root, { recursive: true, force: true }); }
});
async function run(f: Awaited<ReturnType<typeof fixture>>, goalId: string) {
  const unavailable = { complete: async () => { throw new Error('PoC grounding must not request another model'); } };
  const independentUnavailable = { extract: async () => { throw new Error('PoC grounding must not request independent extraction'); } };
  return executeActionGoalGroundingV1({ admission: f.admission, runtime: f.runtime, goalId,
    model: unavailable, independentModel: independentUnavailable });
}

test('PoC unique link click navigates and retains a generic delivery witness after target disappearance', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link('go'), 'Click the Dropdown link.');
  try {
    const result = await run(f, 'click');
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.witness.postEffect.effect).toMatchObject({ kind: 'generic_activation', role: 'link',
      accessibleName: 'Dropdown', delivery: { stepId: 'click', clicks: 1, targetOwned: true,
        dispatched: true, returned: true, elapsedMs: expect.any(Number) } });
    expect(f.session.browserSession.context.pages()[0]!.url()).toBe(`${f.url}next`);
    expect(f.runtime.protectedGenericClickDelivery(result.witness.execution.executionId)).toMatchObject({
      stepId: 'click', role: 'link', accessibleName: 'Dropdown', dispatched: true, returned: true,
      elapsedMs: expect.any(Number) });
    expect(result.witness.execution.genericClickDelivery).toMatchObject({ stepId: 'click', role: 'link', accessibleName: 'Dropdown',
      dispatched: true, returned: true, elapsedMs: expect.any(Number) });
    expect(result.witness.postEffect.sameTargetNode).toBe(false);
    expect(result.witness.postEffect.after).toBeUndefined();
    expect(f.runtime.protectedActionGroundingRetirement(result.witness.witnessId)).toBeUndefined();
  } finally { await f.close(); }
});

test('PoC current URL observation and evidence check do not read frame content or ARIA', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link('go'), 'Click the Dropdown link.');
  const page = f.session.browserSession.context.pages()[0]!, frame = page.mainFrame();
  const originalContent = frame.content;
  const body = frame.locator('body');
  const locatorPrototype = Object.getPrototypeOf(body) as typeof body;
  const originalAria = locatorPrototype.ariaSnapshot;
  try {
    frame.content = async () => { throw new Error('Frame content unavailable'); };
    locatorPrototype.ariaSnapshot = async () => { throw new Error('ARIA unavailable'); };
    const observer = new TrustedObservationSessionV1(f.session, f.runtime);
    const fact = await observer.observe({ kind: 'current_url' });
    expect(fact).toMatchObject({ status: 'complete', request: { kind: 'current_url' },
      result: { kind: 'url', value: f.url, complete: true }, frame: { kind: 'main' } });
    expect(await observer.currentEvidence(fact)).toEqual(fact);
    await f.session.navigate(`${f.url}next`);
    expect(await observer.currentEvidence(fact)).toBeUndefined();
  } finally { frame.content = originalContent; locatorPrototype.ariaSnapshot = originalAria; await f.close(); }
});

for (const mode of ['no_page', 'closed_page', 'multiple_pages'] as const) {
  test(`PoC current URL observation rejects ${mode} without QA evidence`, async () => {
    const f = await fixture('<a href="/next">Dropdown</a>', link('go'), 'Click the Dropdown link.');
    const page = f.session.browserSession.context.pages()[0]!;
    const originalIsClosed = page.isClosed;
    try {
      if (mode === 'no_page') await page.close();
      else if (mode === 'closed_page') page.isClosed = () => true;
      else await f.session.browserSession.context.newPage();
      const observer = new TrustedObservationSessionV1(f.session, f.runtime);
      await expect(observer.observe({ kind: 'current_url' })).rejects.toMatchObject({ reason: 'BROWSER_FAILURE' });
    } finally { page.isClosed = originalIsClosed; await f.close(); }
  });
}

test('PoC two matching links stop as non-unique before click', async () => {
  const f = await fixture('<a href="/next">Dropdown</a><a href="/other">Dropdown</a>', link());
  try { const result = await run(f, 'click'); expect(result).toMatchObject({ status: 'stop', reason: 'NON_UNIQUE' });
    expect(f.session.browserSession.context.pages()[0]!.url()).toBe(f.url); }
  finally { await f.close(); }
});

test('PoC unnamed native dropdown resolves its option without another source model', async () => {
  const f = await fixture('<select><option value="">Choose</option><option value="runtime-1">Option 1</option></select>', select());
  try { const result = await run(f, 'choose'); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.witness.postEffect.effect).toMatchObject({ kind: 'native_choice', value: 'runtime-1' });
      expect(result.witness.postEffect.after).toBeDefined();
      expect(f.runtime.protectedActionGroundingRetirement(result.witness.witnessId)).toBeDefined();
    } }
  finally { await f.close(); }
});

test('PoC protected digest is stable, content-sensitive, and preserves evidence fields', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  try {
    const first = await f.runtime.protectedTraceState();
    const same = await f.runtime.protectedTraceState();
    expect(same.stateDigest).toBe(first.stateDigest);
    expect(same.materialDigest).toBe(first.materialDigest);
    expect(same.stateEpoch).toBe(first.stateEpoch);
    expect(first.frameDigests.get(first.frames[0]!)).toMatch(/^[a-f0-9]{64}$/);
    f.runtime.invalidate();
    const invalidated = await f.runtime.protectedTraceState();
    expect(invalidated.stateDigest).not.toBe(first.stateDigest);
    expect(invalidated.materialDigest).toBe(first.materialDigest);
    const page = f.session.browserSession.context.pages()[0]!;
    await page.locator('body').evaluate(node => node.append(document.createElement('aside')));
    const changed = await f.runtime.protectedTraceState();
    expect(changed.stateDigest).not.toBe(first.stateDigest);
    expect(changed.materialDigest).not.toBe(first.materialDigest);
    expect(changed.stateEpoch).toBeGreaterThan(first.stateEpoch);
    const outcome = await run(f, 'choose');
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    if (outcome.status === 'succeeded') expect(outcome.witness.postEffect.before).toMatchObject({
      stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/), stateEpoch: expect.any(Number),
      mutationEpoch: expect.any(Number) });
  } finally { await f.close(); }
});

test('PoC digest rejects material change between initial and fresh candidate state', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  const page = f.session.browserSession.context.pages()[0]!;
  const frame = page.mainFrame();
  const original = frame.content;
  let reads = 0;
  try {
    frame.content = async () => {
      if (++reads === 2) await page.locator('body').evaluate(node => node.append(document.createElement('aside')));
      return original.call(frame);
    };
    expect(await run(f, 'choose')).toMatchObject({ status: 'stop' });
    expect(f.diagnostics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'choose', operation: 'freshness_comparison', outcome: 'failure', internalReason: 'STALE_STATE' })]));
  } finally { frame.content = original; await f.close(); }
});

test('PoC frame and navigation changes revise protected digest and invalidate old ownership', async () => {
  const f = await fixture('<select><option>Option 1</option></select><iframe title="Child" srcdoc="<p>Ready</p>"></iframe>', select());
  try {
    const page = f.session.browserSession.context.pages()[0]!;
    const before = await f.runtime.protectedTraceState();
    const goal = f.admission.spec.steps.find(step => step.id === 'choose');
    if (!goal || goal.type !== 'action_goal') throw new Error('Missing choice goal');
    const request = { groundingVersion: '1', goalId: goal.id,
      handoff: buildActionObligationHandoffV2(f.admission),
      mapping: goal.obligations.map(obligation => ({ obligationId: obligation.id,
        kind: obligation.kind === 'effect' || obligation.kind === 'operation' ? obligation.kind : 'pending' })) };
    const observed = await f.runtime.query(request);
    if (observed.status !== 'complete' || observed.count !== 1) throw new Error('Missing unique candidate');
    const candidate = observed.candidates[0]!;
    await page.locator('iframe').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await page.frameLocator('iframe').getByText('Ready').waitFor();
    const replaced = await f.runtime.protectedTraceState();
    expect(replaced.stateDigest).not.toBe(before.stateDigest);
    expect(replaced.frameDigests.has(before.frames[1]!)).toBe(false);
    await expect(f.runtime.bind(observed, candidate.selectedRef, candidate.frameId)).rejects.toMatchObject({ reason: 'STALE_STATE' });
    const fresh = await f.runtime.query(request);
    if (fresh.status !== 'complete' || fresh.count !== 1) throw new Error('Missing replacement candidate');
    await page.goto(`${f.url}next`);
    const navigated = await f.runtime.protectedTraceState();
    expect(navigated.stateDigest).not.toBe(replaced.stateDigest);
    expect(navigated.pageId).toBe(before.pageId);
    expect(navigated.frames[0]!.url()).toBe(`${f.url}next`);
    await expect(f.runtime.bind(fresh, fresh.candidates[0]!.selectedRef, fresh.candidates[0]!.frameId))
      .rejects.toMatchObject({ reason: 'STALE_STATE' });
  } finally { await f.close(); }
});

for (const [title, html, reason] of [
  ['two dropdowns', '<select><option>Option 1</option></select><select><option>Option 1</option></select>', 'NON_UNIQUE'],
  ['missing Option 1', '<select><option>Choose</option></select>', 'OPTION_ABSENT'],
] as const) test(`PoC ${title} stops before action`, async () => {
  const f = await fixture(html, select());
  try { expect(await run(f, 'choose')).toMatchObject({ status: 'stop', reason }); }
  finally { await f.close(); }
});

test('PoC same-page click remains witnessable after the clicked target removes itself', async () => {
  const button: Step = { id: 'click', type: 'action_goal', effect: 'activate', explicitOperation: 'click',
    targetConstraints: [{ kind: 'role', value: 'button', polarity: 'positive' },
      { kind: 'name', value: 'Remove', polarity: 'positive' }], argument: null, dependsOnStepId: null };
  const f = await fixture('<button onclick="this.remove()">Remove</button>', button);
  try { const result = await run(f, 'click'); expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status === 'succeeded') { expect(result.witness.postEffect.effect).toMatchObject({kind:'generic_activation',
      role:'button',accessibleName:'Remove',delivery:{dispatched:true,returned:true}});
      expect(result.witness.postEffect.sameTargetNode).toBe(false);
      expect(result.witness.postEffect.after).toBeUndefined();
      expect(f.runtime.protectedActionGroundingRetirement(result.witness.witnessId)).toBeUndefined(); } }
  finally { await f.close(); }
});

test('PoC generic click dispatch failure remains an automation stop', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link());
  const handle = await f.session.browserSession.context.pages()[0]!.$('a');
  if (!handle) throw new Error('Missing fixture link');
  const proto = Object.getPrototypeOf(handle) as { click: typeof handle.click };
  const original = proto.click;
  try {
    proto.click = async () => { throw new Error('Injected click failure'); };
    const result = await run(f, 'click');
    expect(result).toMatchObject({ status: 'stop', reason: 'ACTION_FAILED_PARTIAL_OR_UNKNOWN' });
    expect(result.executionAttempts[0]?.genericClickDelivery).toBeUndefined();
    expect(f.session.browserSession.context.pages()[0]!.url()).toBe(f.url);
  } finally { proto.click = original; await handle.dispose(); await f.close(); }
});

test('PoC returned click succeeds when immediate ARIA continuity capture is unavailable', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link());
  const page = f.session.browserSession.context.pages()[0]!;
  const handle = await page.$('a');
  if (!handle) throw new Error('Missing fixture link');
  const handleProto = Object.getPrototypeOf(handle) as { click: typeof handle.click };
  const locator = page.locator('body');
  const locatorProto = Object.getPrototypeOf(locator) as { ariaSnapshot: typeof locator.ariaSnapshot };
  const originalClick = handleProto.click, originalSnapshot = locatorProto.ariaSnapshot;
  try {
    handleProto.click = async function (...args) {
      await originalClick.apply(this, args);
      locatorProto.ariaSnapshot = async () => { throw new Error('Injected continuity capture failure'); };
    };
    const result = await run(f, 'click');
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.witness.execution).toMatchObject({ invocationOutcome: 'returned', reason: 'DELIVERY_PROVEN',
      genericClickDelivery: { stepId: 'click', role: 'link', accessibleName: 'Dropdown', dispatched: true, returned: true,
        elapsedMs: expect.any(Number) } });
    expect(result.witness.postEffect.after).toBeUndefined();
    expect(page.url()).toBe(`${f.url}next`);
  } finally { handleProto.click = originalClick; locatorProto.ariaSnapshot = originalSnapshot;
    await handle.dispose(); await f.close(); }
});

test('PoC target disappearance before dispatch stops without clicking', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link());
  const page = f.session.browserSession.context.pages()[0]!;
  const handle = await page.$('a');
  if (!handle) throw new Error('Missing fixture link');
  const proto = Object.getPrototypeOf(handle) as { scrollIntoViewIfNeeded: typeof handle.scrollIntoViewIfNeeded };
  const original = proto.scrollIntoViewIfNeeded;
  let replaced = false;
  try {
    proto.scrollIntoViewIfNeeded = async function (...args) {
      await original.apply(this, args);
      if (!replaced) { replaced = true; await page.evaluate(() => { document.querySelector('a')!.remove(); }); }
    };
    const result = await run(f, 'click');
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ status: 'stop' });
    expect(page.url()).toBe(f.url);
  } finally { proto.scrollIntoViewIfNeeded = original; await handle.dispose(); await f.close(); }
});

test('PoC same-markup target rebinding still stops before dispatch', async () => {
  const f = await fixture('<a href="/next">Dropdown</a>', link());
  const page = f.session.browserSession.context.pages()[0]!;
  const frame = page.mainFrame(), original = frame.content;
  let reads = 0;
  try {
    frame.content = async () => {
      if (++reads === 2) await page.evaluate(() => {
        const target = document.querySelector('a')!; target.replaceWith(target.cloneNode(true));
      });
      return original.call(frame);
    };
    expect(await run(f, 'click')).toMatchObject({ status: 'stop' });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(page.url()).toBe(f.url);
  } finally { frame.content = original; await f.close(); }
});

test('PoC targeted candidate ARIA identity remains required without whole-body ARIA', async () => {
  const f = await fixture('<select><option>Option 1</option></select>', select());
  const locator = f.session.browserSession.context.pages()[0]!.getByRole('combobox');
  const prototype = Object.getPrototypeOf(locator) as typeof locator;
  const original = prototype.ariaSnapshotJSON;
  let calls = 0;
  try {
    prototype.ariaSnapshotJSON = async () => { calls++; throw new Error('Target ref unavailable'); };
    expect(await run(f, 'choose')).toMatchObject({ status: 'stop' });
    expect(calls).toBeGreaterThan(0);
    expect(f.diagnostics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'choose', operation: 'candidate_enumeration', outcome: 'failure', browserOperation: 'candidate_snapshot' })]));
  } finally { prototype.ariaSnapshotJSON = original; await f.close(); }
});
