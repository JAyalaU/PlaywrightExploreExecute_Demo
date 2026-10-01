import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, ExploratoryTargetResolutionError, McpExplorationSession } from '../app/exploration/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function fixture(html: string) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return { url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function factory(port: number) {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'wp2a-desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'wp2a-policy', version: '1' },
  }], [{ id: 'wp2a-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]));
}

function source(url: string) {
  return { schemaVersion: '2', testSpecId: 'test-wp2a',
    sourceInstruction: 'Click the link with the text "200" and fill Name',
    executionProfileRef: { id: 'wp2a-desktop', version: '1' }, startState: { url },
    steps: [
      { id: 's1', type: 'click', sourceText: 'Click the link with the text "200"',
        target: { description: 'link with the text: "200"' } },
      { id: 's2', type: 'fill', sourceText: 'Fill Name', target: { description: 'Name textbox' }, value: 'Jorge' },
    ] };
}

async function open(html: string) {
  const site = await fixture(html);
  const protectedFactory = factory(site.port);
  const session = await McpExplorationSession.open(protectedFactory,
    { id: 'wp2a-desktop', version: '1' },
    protectedFactory.catalog.resolve({ id: 'wp2a-desktop', version: '1' }), 'explore-wp2a');
  await session.navigate(site.url);
  const current = new CurrentStateExploration(session, source(site.url), 'explore-wp2a');
  return { site, session, current, close: async () => { await session.close(); await site.close(); } };
}

function ref(snapshot: string, role: string, name: string): string {
  const line = snapshot.split('\n').find((part) => part.includes(`- ${role} "${name}"`) && part.includes('[ref='));
  const match = line && /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line);
  if (!match) throw new Error(`Missing ${role} ${name} ref`);
  return match[1]!;
}

test('WP2A clicks a grounded numeric link without generating a replay locator', async () => {
  const run = await open('<a href="#done">200</a><label>Name <input></label>');
  try {
    const view = await run.current.observe();
    const binding = await run.current.bind('s1', 'click', ref(view.snapshot, 'link', '200'));
    expect(binding.selectedNode).toMatchObject({ role: 'link', accessibleName: '200' });
    const record = await run.current.act(binding);
    expect(record).toMatchObject({ type: 'click', originStepId: 's1', bindingId: binding.bindingId,
      source: 'authored', result: 'completed' });
    expect(run.session.browserSession.context.pages()[0]!.url()).toContain('#done');
    expect(run.session.calls.map((call) => call.name)).not.toContain('browser_generate_locator');
    expect(run.current.successfulActions).toHaveLength(1);
    expect(JSON.stringify(run.current.successfulActions)).not.toContain('validatedForm');
    expect(JSON.stringify(run.current.successfulActions)).not.toContain('resolvedSpecId');
    await expect(run.current.act(binding)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
  } finally { await run.close(); }
});

test('WP2A rejects stale snapshot, mutation, navigation, and changed epoch before action', async () => {
  const run = await open('<a href="#done">200</a><label>Name <input></label>');
  try {
    const first = await run.current.observe();
    const old = await run.current.bind('s1', 'click', ref(first.snapshot, 'link', '200'));
    await run.current.observe();
    await expect(run.current.act(old)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    const fresh = await run.current.bind('s1', 'click', ref(first.snapshot, 'link', '200'));
    await run.session.browserSession.context.pages()[0]!.locator('a').evaluate((node) => { node.textContent = '201'; });
    await expect(run.current.act(fresh)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    const next = await run.current.observe();
    const fill = await run.current.bind('s2', 'fill', ref(next.snapshot, 'textbox', 'Name'));
    await run.session.navigate(run.site.url);
    await expect(run.current.act(fill, 'Jorge')).rejects.toBeInstanceOf(ExploratoryTargetResolutionError);
  } finally { await run.close(); }
});

test('WP2A denies forged owner, frame, node, operation, and authored contradiction', async () => {
  const run = await open('<a href="#done">200</a><button disabled>Save</button><label>Name <input></label>');
  try {
    const view = await run.current.observe();
    const link = ref(view.snapshot, 'link', '200');
    const binding = await run.current.bind('s1', 'click', link);
    for (const change of [
      { sessionId: 'session-other' }, { pageId: 'page-other' }, { frameId: 'frame-other' },
      { selectedRef: 'ref-other' }, { selectedNode: { role: 'button', accessibleName: '200' } },
      { snapshotDigest: 'f'.repeat(64) }, { profileFingerprint: 'f'.repeat(64) },
      { issuedAt: new Date(Date.now() + 60_000).toISOString() },
    ]) await expect(run.current.act({ ...binding, ...change })).rejects.toBeInstanceOf(ExploratoryTargetResolutionError);
    await expect(run.current.bind('s2', 'fill', link)).rejects.toMatchObject({ reason: 'UNSUPPORTED_OPERATION' });
    await expect(run.current.bind('s1', 'click', ref(view.snapshot, 'button', 'Save')))
      .rejects.toMatchObject({ reason: 'NOT_ACTIONABLE' });
    await expect(run.current.bind('s1', 'click', ref(view.snapshot, 'textbox', 'Name')))
      .rejects.toMatchObject({ reason: 'UNSUPPORTED_OPERATION' });
  } finally { await run.close(); }
});

test('WP2A records fill facts and denies an authored role/name or row-scope mismatch', async () => {
  const run = await open('<table><tr><td>Iuvaret1</td><td><a href="#edit">edit</a></td></tr></table><label>Name <input></label><button>200</button>');
  try {
    const view = await run.current.observe();
    await expect(run.current.bind('s1', 'click', ref(view.snapshot, 'button', '200')))
      .rejects.toMatchObject({ reason: 'WRONG_TARGET' });
    const fill = await run.current.bind('s2', 'fill', ref(view.snapshot, 'textbox', 'Name'));
    await expect(run.current.act(fill, 'different value')).rejects.toMatchObject({ reason: 'WRONG_TARGET' });
    expect(run.session.calls.map((call) => call.name)).not.toContain('browser_fill_form');
    const record = await run.current.act(fill, 'Jorge');
    expect(record).toMatchObject({ type: 'fill', value: 'Jorge', sequence: 1 });
    expect(run.current.successfulActions[0]?.binding.profileFingerprint)
      .toBe(run.session.browserSession.effectiveProfile.fingerprint);
  } finally { await run.close(); }
});

test('WP2A enforces authored row scope and a newly issued session epoch', async () => {
  const run = await open('<table><tr><td>Iuvaret0</td><td><a href="#wrong">edit</a></td></tr>' +
    '<tr><td>Iuvaret1</td><td><a href="#edit">edit</a></td></tr></table>');
  try {
    const scopedSource = { schemaVersion: '2', testSpecId: 'test-scoped-wp2a',
      sourceInstruction: 'Edit the Iuvaret1 row', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Edit the Iuvaret1 row', target: { description: 'edit',
          scope: [{ kind: 'row', description: 'row containing Iuvaret1' }] } }] };
    const first = new CurrentStateExploration(run.session, scopedSource, 'explore-scoped');
    const view = await first.observe();
    const refs = [...view.snapshot.matchAll(/link "edit" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/g)].map((match) => match[1]!);
    expect(refs).toHaveLength(2);
    await expect(first.bind('s1', 'click', refs[0]!)).rejects.toMatchObject({ reason: 'WRONG_TARGET' });
    const allowed = await first.bind('s1', 'click', refs[1]!);
    const replacement = new CurrentStateExploration(run.session, scopedSource, 'explore-scoped');
    await replacement.observe();
    await expect(replacement.act(allowed)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    await expect(first.act(allowed)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    const fresh = await replacement.bind('s1', 'click', refs[1]!);
    expect((await replacement.act(fresh)).type).toBe('click');
    expect(run.session.browserSession.context.pages()[0]!.url()).toContain('#edit');
  } finally { await run.close(); }
});

test('WP2A expires issued bindings before any MCP action', async () => {
  const run = await open('<a href="#done">200</a>');
  try {
    let now = Date.now();
    const current = new CurrentStateExploration(run.session, source(run.site.url), 'explore-expiry', () => now);
    const view = await current.observe();
    const binding = await current.bind('s1', 'click', ref(view.snapshot, 'link', '200'));
    now += 10_001;
    await expect(current.act(binding)).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    expect(run.session.calls.map((call) => call.name)).not.toContain('browser_click');
  } finally { await run.close(); }
});

test('WP2A binds the actual child frame and rejects a forged frame identity', async () => {
  const run = await open('<iframe title="payment frame" srcdoc="<button>Submit</button>"></iframe>');
  try {
    const framedSource = { schemaVersion: '2', testSpecId: 'test-framed-wp2a',
      sourceInstruction: 'Click Submit in payment frame',
      executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Click Submit in payment frame', target: { description: 'Submit',
          scope: [{ kind: 'frame', description: 'payment frame' }] } }] };
    const current = new CurrentStateExploration(run.session, framedSource, 'explore-frame');
    const view = await current.observe();
    const binding = await current.bind('s1', 'click', ref(view.snapshot, 'button', 'Submit'));
    expect(binding.frameId).toMatch(/^frame-/);
    await expect(current.act({ ...binding, frameId: 'frame-forged' }))
      .rejects.toMatchObject({ reason: 'STALE_BINDING' });
    expect((await current.act(binding)).type).toBe('click');
  } finally { await run.close(); }
});

test('v2 capture attests main and exact-title nested frame ancestry without changing action authority', async () => {
  const run = await open('<a href="#done">200</a><iframe title="payment frame" srcdoc="<button>Submit</button>"></iframe>');
  try {
    const view = await run.current.observe();
    const link = await run.current.bind('s1', 'click', ref(view.snapshot, 'link', '200'));
    expect(run.current.traceBinding(link).frameOwnership).toEqual({
      kind: 'main', observationDigest: view.snapshotDigest,
    });
    const framedSource = { schemaVersion: '2', testSpecId: 'test-capture-frame',
      sourceInstruction: 'Click Submit', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Click Submit', target: { description: 'Submit' } }] };
    const current = new CurrentStateExploration(run.session, framedSource, 'explore-capture-frame');
    const nestedView = await current.observe();
    const nested = await current.bind('s1', 'click', ref(nestedView.snapshot, 'button', 'Submit'));
    expect(current.traceBinding(nested).frameOwnership).toMatchObject({ kind: 'nested',
      anchors: [{ identity: { kind: 'title', value: 'payment frame', exact: true },
        observedMatchCount: 1 }] });
    expect((await current.act(nested)).type).toBe('click');
    expect(current.traceBinding(nested).frameOwnership.kind).toBe('nested');
    expect(() => current.traceBinding({ ...nested, frameId: 'forged' }))
      .toThrow(ExploratoryTargetResolutionError);
    expect(run.session.calls.map((call) => call.name)).not.toContain('browser_generate_locator');
  } finally { await run.close(); }
});

test('v2 capture uses unique reviewed testId ancestry and marks duplicate or unnamed anchors unproven', async () => {
  const run = await open('<iframe data-testid="editor-frame" srcdoc="<button>Submit</button>"></iframe>');
  try {
    const framedSource = { schemaVersion: '2', testSpecId: 'test-capture-testid',
      sourceInstruction: 'Click Submit', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Click Submit', target: { description: 'Submit' } }] };
    const current = new CurrentStateExploration(run.session, framedSource, 'explore-capture-testid');
    const view = await current.observe();
    const binding = await current.bind('s1', 'click', ref(view.snapshot, 'button', 'Submit'));
    expect(current.traceBinding(binding).frameOwnership).toMatchObject({ kind: 'nested',
      anchors: [{ identity: { kind: 'testId', value: 'editor-frame', exact: true } }] });
    const page = run.session.browserSession.context.pages()[0]!;
    await page.setContent('<iframe title="duplicate" srcdoc="<button>Submit</button>"></iframe>' +
      '<iframe title="duplicate" srcdoc="<p>Other</p>"></iframe>');
    const duplicateView = await current.observe();
    const duplicate = await current.bind('s1', 'click', ref(duplicateView.snapshot, 'button', 'Submit'));
    expect(current.traceBinding(duplicate).frameOwnership).toEqual({ kind: 'unproven',
      reasonCode: 'ambiguous_anchor' });
    await page.setContent('<iframe srcdoc="<button>Submit</button>"></iframe>');
    const unnamedView = await current.observe();
    const unnamed = await current.bind('s1', 'click', ref(unnamedView.snapshot, 'button', 'Submit'));
    expect(current.traceBinding(unnamed).frameOwnership).toEqual({ kind: 'unproven',
      reasonCode: 'unsupported_anchor' });
  } finally { await run.close(); }
});

test('v2 capture keeps root-to-leaf ancestry for two nested frame anchors', async () => {
  const run = await open('<iframe title="outer"></iframe>');
  try {
    const page = run.session.browserSession.context.pages()[0]!;
    const outer = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
    if (!outer) throw new Error('Missing outer fixture frame');
    await outer.setContent('<iframe data-testid="inner"></iframe>');
    const inner = page.frames().find((frame) => frame.parentFrame() === outer);
    if (!inner) throw new Error('Missing inner fixture frame');
    await inner.setContent('<button>Submit</button>');
    const framedSource = { schemaVersion: '2', testSpecId: 'test-capture-ancestry',
      sourceInstruction: 'Click Submit', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Click Submit', target: { description: 'Submit' } }] };
    const current = new CurrentStateExploration(run.session, framedSource, 'explore-capture-ancestry');
    const view = await current.observe();
    const binding = await current.bind('s1', 'click', ref(view.snapshot, 'button', 'Submit'));
    expect(current.traceBinding(binding).frameOwnership).toMatchObject({ kind: 'nested', anchors: [
      { identity: { kind: 'title', value: 'outer', exact: true } },
      { identity: { kind: 'testId', value: 'inner', exact: true } },
    ] });
  } finally { await run.close(); }
});

test('v2 passive capture witnesses an authored exact URL at the protected transition', async () => {
  const run = await open('<a href="#ready">Status Codes</a>');
  try {
    const expected = `${run.site.url}#ready`;
    const capturedSource = { schemaVersion: '2', testSpecId: 'test-capture-url',
      sourceInstruction: 'Confirm status URL', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'assert_url',
        sourceText: 'Confirm status URL', expectedUrl: expected, match: 'exact' }] };
    const current = new CurrentStateExploration(run.session, capturedSource, 'explore-capture-url');
    const before = await current.observe();
    await run.session.browserSession.context.pages()[0]!.goto(expected);
    const after = await current.observe();
    const record = await current.capturePassiveTransition({ originStepId: 's1',
      recordId: 'record-passive', sequence: 1, preStateDigest: before.stateDigest });
    expect(record).toMatchObject({ type: 'state_observed', condition: { type: 'url_exact', url: expected },
      preStateDigest: before.stateDigest, postStateDigest: after.stateDigest,
      witness: { traceRecordId: 'record-passive', satisfied: true,
        observationDigest: after.snapshotDigest } });
    const forged = await current.capturePassiveTransition({ originStepId: 's1',
      recordId: 'record-second', sequence: 2, preStateDigest: before.stateDigest,
      condition: { type: 'url_exact', url: 'https://attacker.invalid/' } } as any);
    if (forged.type !== 'state_observed') throw new Error('Expected passive record');
    expect(forged.condition).toEqual({ type: 'url_exact', url: expected });
    await expect(current.capturePassiveTransition({ originStepId: 's1', recordId: 'record-stale',
      sequence: 3, preStateDigest: 'f'.repeat(64) })).rejects.toMatchObject({ reason: 'STALE_BINDING' });
  } finally { await run.close(); }
});

test('v2 passive target-visible and target-value checks require owned current bindings', async () => {
  const run = await open('<div id="target"></div><button>Wrong</button><label>Name <input></label>');
  try {
    const capturedSource = { schemaVersion: '2', testSpecId: 'test-capture-target',
      sourceInstruction: 'Wait for Ready and Name value',
      executionProfileRef: { id: 'wp2a-desktop', version: '1' }, startState: { url: run.site.url },
      steps: [
        { id: 's1', type: 'wait_for', sourceText: 'Wait for Ready',
          condition: { type: 'target_visible', target: { description: 'button with text "Ready"' } },
          timeoutPolicyRef: 'default' },
        { id: 's2', type: 'wait_for', sourceText: 'Wait for Name value',
          condition: { type: 'target_value', target: { description: 'textbox with name "Name"' }, expectedValue: 'ready' },
          timeoutPolicyRef: 'default' },
      ] };
    const current = new CurrentStateExploration(run.session, capturedSource, 'explore-capture-target');
    const first = await current.observe();
    const page = run.session.browserSession.context.pages()[0]!;
    await page.locator('#target').evaluate((node) => { node.innerHTML = '<button>Ready</button>'; });
    const ready = await current.observe();
    const wrongBinding = await current.bind('s1', 'wait_for', ref(ready.snapshot, 'button', 'Wrong'),
      'discovered_prerequisite');
    await expect(current.capturePassiveTransition({ originStepId: 's1', recordId: 'record-wrong',
      sequence: 1, preStateDigest: first.stateDigest, binding: wrongBinding }))
      .rejects.toMatchObject({ reason: 'WRONG_TARGET' });
    const readyBinding = await current.bind('s1', 'wait_for', ref(ready.snapshot, 'button', 'Ready'), 'wait_target');
    const visible = await current.capturePassiveTransition({ originStepId: 's1',
      recordId: 'record-visible', sequence: 1, preStateDigest: first.stateDigest, binding: readyBinding });
    expect(visible).toMatchObject({ condition: { type: 'target_visible' }, bindingId: readyBinding.bindingId,
      witness: { satisfied: true } });
    await expect(current.capturePassiveTransition({ originStepId: 's1', recordId: 'record-unowned',
      sequence: 2, preStateDigest: first.stateDigest })).rejects.toMatchObject({ reason: 'STALE_BINDING' });
    await page.getByRole('textbox', { name: 'Name' }).fill('ready');
    const filled = await current.observe();
    const valueBinding = await current.bind('s2', 'wait_for', ref(filled.snapshot, 'textbox', 'Name'), 'wait_target');
    const value = await current.capturePassiveTransition({ originStepId: 's2',
      recordId: 'record-value', sequence: 2, preStateDigest: ready.stateDigest, binding: valueBinding });
    expect(value).toMatchObject({ condition: { type: 'target_value', expectedValue: 'ready' },
      bindingId: valueBinding.bindingId, witness: { satisfied: true } });
    await page.getByRole('textbox', { name: 'Name' }).fill('different');
    await expect(current.capturePassiveTransition({ originStepId: 's2', recordId: 'record-contradiction',
      sequence: 3, preStateDigest: ready.stateDigest, binding: valueBinding }))
      .rejects.toBeInstanceOf(ExploratoryTargetResolutionError);
  } finally { await run.close(); }
});

test('v2 passive capture rejects an intervening exploratory action', async () => {
  const run = await open('<a href="#ready">200</a>');
  try {
    const sourceWithAssertion = { ...source(run.site.url), steps: [
      source(run.site.url).steps[0],
      { id: 's2', type: 'assert_url', sourceText: 'Confirm ready URL',
        expectedUrl: `${run.site.url}#ready`, match: 'exact' },
    ] };
    const current = new CurrentStateExploration(run.session, sourceWithAssertion, 'explore-action-not-passive');
    const before = await current.observe();
    const bound = await current.bind('s1', 'click', ref(before.snapshot, 'link', '200'));
    await current.act(bound);
    await expect(current.capturePassiveTransition({ originStepId: 's2',
      recordId: 'record-false-passive', sequence: 1, preStateDigest: before.stateDigest }))
      .rejects.toMatchObject({ reason: 'STALE_BINDING' });
  } finally { await run.close(); }
});

test('v2 Status Codes shaped readiness captures a new authored target before clicking numeric link', async () => {
  const run = await open('<div id="links"></div>');
  try {
    const statusSource = { schemaVersion: '2', testSpecId: 'test-status-shaped',
      sourceInstruction: 'Click link 200', executionProfileRef: { id: 'wp2a-desktop', version: '1' },
      startState: { url: run.site.url }, steps: [{ id: 's1', type: 'click',
        sourceText: 'Click link 200', target: { description: 'link with text "200"' } }] };
    const current = new CurrentStateExploration(run.session, statusSource, 'explore-status-shaped');
    const before = await current.observe();
    await run.session.browserSession.context.pages()[0]!.locator('#links')
      .evaluate((node) => { node.innerHTML = '<a href="#200">200</a>'; });
    const after = await current.observe();
    const numeric = ref(after.snapshot, 'link', '200');
    const readiness = await current.bind('s1', 'wait_for', numeric, 'discovered_prerequisite');
    const passive = await current.capturePassiveTransition({ originStepId: 's1',
      recordId: 'record-readiness', sequence: 1, preStateDigest: before.stateDigest,
      binding: readiness });
    expect(passive).toMatchObject({ type: 'state_observed', condition: { type: 'target_visible',
      target: { description: 'link with text "200"' } }, witness: { satisfied: true } });
    const action = await current.bind('s1', 'click', numeric);
    expect((await current.act(action)).type).toBe('click');
    expect(run.session.calls.map((call) => call.name)).not.toContain('browser_generate_locator');
  } finally { await run.close(); }
});
