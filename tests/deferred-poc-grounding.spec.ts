import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { ActionCandidateGroundingSessionV1 } from '../app/exploration/action-candidate-grounding.js';
import { normalizePocSemanticExtraction } from '../app/interpretation/deferred-action-poc-normalize.js';
import { admitPocSemanticFidelityV2 } from '../app/domain/action-semantic-admission.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';
import type { PocPrimaryResponse } from '../app/interpretation/deferred-action-poc-wire.js';

type Extracted = Extract<PocPrimaryResponse, { kind: 'extraction' }>;
type Step = Extracted['steps'][number];
const link = (dependsOnStepId: string | null = null): Step => ({ id: 'click', type: 'action_goal', effect: 'activate',
  explicitOperation: 'click', targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
    { kind: 'name', value: 'Dropdown', polarity: 'positive' }], argument: null, dependsOnStepId });
const select = (): Step => ({ id: 'choose', type: 'action_goal', effect: 'choose', explicitOperation: 'select_option',
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
    const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'poc-grounding-attempt');
    return { session, server, url, runtime, admission, close: async () => {
      await session!.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    } };
  } catch (error) {
    await session?.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}
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
