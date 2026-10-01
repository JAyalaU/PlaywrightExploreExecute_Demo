import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, McpExplorationSession,
  TrustedObservationSessionV1 } from '../app/exploration/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function fixture(html: string) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html'); response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
function factory(port: number) {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'observation-desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'observation-policy', version: '1' },
  }], [{ id: 'observation-policy', version: '1', destinations: [
    { host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] },
  ] }]));
}
const clause = 'Confirm a button with the text "Delete" does not exist.';
function source(url: string) {
  return { schemaVersion: '4', testSpecId: 'test-observation',
    sourceInstruction: `Click the "Add Element" button. ${clause}`,
    executionProfileRef: { id: 'observation-desktop', version: '1' }, startState: { url },
    steps: [
      { id: 's1', type: 'click', sourceText: 'Click the "Add Element" button.',
        target: { description: 'Add Element button' } },
      { id: 's2', type: 'verification_goal', sourceText: clause, instruction: clause,
        subject: { role: 'button', accessibleName: 'Delete' },
        intent: { kind: 'presence', expected: 'absent' } },
    ] };
}
async function open(html: string) {
  const site = await fixture(html);
  const protectedFactory = factory(site.port);
  const session = await McpExplorationSession.open(protectedFactory,
    { id: 'observation-desktop', version: '1' },
    protectedFactory.catalog.resolve({ id: 'observation-desktop', version: '1' }), 'explore-observation');
  await session.navigate(site.url);
  const current = new CurrentStateExploration(session, source(site.url), 'explore-observation');
  const observations = new TrustedObservationSessionV1(session, current);
  return { site, session, current, observations,
    close: async () => { await session.close(); await site.close(); } };
}
const query = (name: string, scope?: object) => ({ kind: 'semantic_query',
  query: { role: 'button', name, frame: { kind: 'main' }, ...scope } });
const property = (name: string, prop: string, scope?: object) => ({ kind: 'target_property',
  query: { role: 'button', name, frame: { kind: 'main' }, ...scope }, property: prop });
function ref(snapshot: string, name: string): string {
  const line = snapshot.split('\n').find((part) => part.includes(`button "${name}"`) && part.includes('[ref='));
  const found = line && /\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line);
  if (!found) throw new Error(`Missing ${name} ref`);
  return found[1]!;
}

test('Add/Remove zero count becomes stale after the reviewed click; fresh count is complete', async () => {
  const run = await open('<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<button>Delete</button>\')">Add Element</button>');
  try {
    const absent = await run.observations.observe(query('Delete'));
    expect(absent).toMatchObject({ observationVersion: '1', status: 'complete',
      result: { kind: 'matches', count: 0, complete: true }, frame: { kind: 'main' } });
    expect(await run.observations.currentEvidence(absent)).toBeDefined();
    const view = await run.current.observe();
    const binding = await run.current.bind('s1', 'click', ref(view.snapshot, 'Add Element'));
    await run.current.act(binding);
    expect(await run.observations.currentEvidence(absent)).toBeUndefined();
    const present = await run.observations.observe(query('Delete'));
    expect(present).toMatchObject({ status: 'complete', result: { kind: 'matches', count: 1 } });
    expect(present.stateEpoch).toBeGreaterThan(absent.stateEpoch);
    expect(await run.observations.currentEvidence(present)).toBeDefined();
  } finally { await run.close(); }
});

test('hidden presence, visibility, enabled state, text, value and checked are distinct facts', async () => {
  const run = await open('<button style="display:none">Delete</button><button disabled>Save</button>' +
    '<button aria-expanded="true">Open</button><label>Name<input value="Alice"></label>' +
    '<label>Done<input type="checkbox" checked></label>');
  try {
    expect(await run.observations.observe(query('Delete'))).toMatchObject({ status: 'complete', result: { count: 1 } });
    expect(await run.observations.observe(property('Delete', 'visible'))).toMatchObject({ status: 'complete', result: { value: false } });
    expect(await run.observations.observe(property('Open', 'visible'))).toMatchObject({ status: 'complete', result: { value: true } });
    expect(await run.observations.observe(property('Save', 'enabled'))).toMatchObject({ status: 'complete', result: { value: false } });
    expect(await run.observations.observe(property('Open', 'enabled'))).toMatchObject({ status: 'complete', result: { value: true } });
    expect(await run.observations.observe(property('Open', 'expanded'))).toMatchObject({ status: 'complete', result: { value: true } });
    expect(await run.observations.observe(property('Open', 'text'))).toMatchObject({ status: 'complete', result: { value: 'Open' } });
    expect(await run.observations.observe({ kind: 'target_property', property: 'value', query: {
      role: 'textbox', name: 'Name', frame: { kind: 'main' } } })).toMatchObject({ status: 'complete', result: { value: 'Alice' } });
    expect(await run.observations.observe({ kind: 'target_property', property: 'checked', query: {
      role: 'checkbox', name: 'Done', frame: { kind: 'main' } } })).toMatchObject({ status: 'complete', result: { value: true } });
    expect(await run.observations.observe(property('Open', 'semantic'))).toMatchObject({ status: 'complete',
      result: { value: { role: 'button', accessibleName: 'Open' } } });
  } finally { await run.close(); }
});

test('multiple matches report full count and uniqueness-required properties do not choose a match', async () => {
  const run = await open('<button>Delete</button><button>Delete</button><button>Delete</button>');
  try {
    expect(await run.observations.observe(query('Delete'))).toMatchObject({ status: 'complete', result: { count: 3 } });
    expect(await run.observations.observe(property('Delete', 'visible'))).toMatchObject({
      status: 'error', reason: 'NON_UNIQUE', observedMatchCount: 3,
    });
    expect(await run.observations.observe(property('Missing', 'visible'))).toMatchObject({
      status: 'error', reason: 'NO_MATCH', observedMatchCount: 0,
    });
    expect(await run.observations.observe(query('Missing'))).toMatchObject({
      status: 'complete', result: { count: 0 },
    });
  } finally { await run.close(); }
});

test('defined scope and nested frame have reviewed provenance; invalid scope is an error', async () => {
  const run = await open('<button>Delete</button><div role="dialog" aria-label="Settings"><button>Delete</button></div>' +
    '<iframe title="items" srcdoc="<button>Delete</button>"></iframe>');
  try {
    expect(await run.observations.observe(query('Delete', { within: [{ kind: 'dialog', name: 'Settings' }] })))
      .toMatchObject({ status: 'complete', result: { count: 1 } });
    expect(await run.observations.observe(query('Delete', { within: [{ kind: 'dialog', name: 'Unknown' }] })))
      .toMatchObject({ status: 'error', reason: 'INVALID_SCOPE' });
    const nested = await run.observations.observe({ kind: 'semantic_query', query: {
      role: 'button', name: 'Delete', frame: { kind: 'nested', anchors: [
        { kind: 'title', value: 'items', exact: true },
      ] },
    } });
    expect(nested).toMatchObject({ status: 'complete', result: { count: 1 },
      frame: { kind: 'nested', anchors: [{ kind: 'title', value: 'items', observedMatchCount: 1 }] } });
    await run.session.browserSession.context.pages()[0]!.evaluate(() => {
      document.querySelector('iframe')!.setAttribute('title', 'renamed');
    });
    expect(await run.observations.currentEvidence(nested)).toBeUndefined();
    expect(await run.observations.observe({ kind: 'semantic_query', query: {
      role: 'button', name: 'Delete', frame: { kind: 'nested', anchors: [
        { kind: 'title', value: 'items', exact: true },
      ] },
    } })).toMatchObject({ status: 'error', reason: 'INVALID_SCOPE' });
    expect(await run.observations.observe({ kind: 'semantic_query', query: {
      role: 'button', name: 'Delete', frame: { kind: 'nested', anchors: [
        { kind: 'title', value: 'unknown', exact: true },
      ] },
    } })).toMatchObject({ status: 'error', reason: 'INVALID_SCOPE' });
  } finally { await run.close(); }
});

test('URL, mutation, navigation, session transition and forged facts obey freshness', async () => {
  const run = await open('<button>Save</button>');
  try {
    const initial = await run.observations.observe(query('Save'));
    expect(await run.observations.observe({ kind: 'current_url' })).toMatchObject({ status: 'complete',
      result: { kind: 'url', value: run.site.url } });
    expect(await run.observations.currentEvidence({ ...initial, result: { kind: 'matches', count: 0, complete: true } }))
      .toBeUndefined();
    await run.current.observe();
    expect(await run.observations.currentEvidence(initial)).toBeUndefined();
    const beforeMutation = await run.observations.observe(query('Save'));
    const page = run.session.browserSession.context.pages()[0]!;
    await page.evaluate(() => { document.querySelector('button')!.textContent = 'Changed'; });
    expect(await run.observations.currentEvidence(beforeMutation)).toBeUndefined();
    const next = await run.observations.observe(query('Changed'));
    await run.session.navigate(`${run.site.url}#next`);
    expect(await run.observations.currentEvidence(next)).toBeUndefined();
    const afterNav = await run.observations.observe(query('Save'));
    new CurrentStateExploration(run.session, source(run.site.url), 'explore-observation');
    expect(await run.observations.currentEvidence(afterNav)).toBeUndefined();
    expect(await run.observations.observe(query('Save'))).toMatchObject({
      status: 'error', reason: 'STALE_STATE', frame: { kind: 'unresolved' },
    });
  } finally { await run.close(); }
});

test('truncated model snapshot cannot establish absence; arbitrary selectors and code are rejected', async () => {
  const run = await open(`<p>${'x'.repeat(18_000)}</p><button>Save</button>`);
  try {
    const snapshot = await run.observations.observe({ kind: 'semantic_snapshot' });
    expect(snapshot).toMatchObject({ status: 'complete', result: { kind: 'snapshot', truncated: true,
      evidenceGrade: false } });
    expect(await run.observations.currentEvidence(snapshot)).toBeUndefined();
    expect(await run.observations.observe(query('Delete'))).toMatchObject({ status: 'complete',
      result: { kind: 'matches', count: 0, complete: true } });
    await expect(run.observations.observe({ ...query('Delete'), selector: '#Delete' })).rejects.toThrow();
    await expect(run.observations.observe({ ...query('Delete'), sessionId: 'session-forged',
      status: 'complete', result: { count: 0 } })).rejects.toThrow();
    await expect(run.observations.observe({ kind: 'semantic_query', query: {
      role: 'button', name: 'Delete', frame: { kind: 'main' }, javascript: 'document.body',
    } })).rejects.toThrow();
  } finally { await run.close(); }
});

test('a closed protected page yields a browser error, never a zero-match fact', async () => {
  const run = await open('<button>Save</button>');
  try {
    const before = await run.observations.observe(query('Save'));
    await run.session.browserSession.context.pages()[0]!.close();
    expect(await run.observations.currentEvidence(before)).toBeUndefined();
    expect(await run.observations.observe(query('Delete'))).toMatchObject({
      status: 'error', reason: 'BROWSER_FAILURE', frame: { kind: 'unresolved' },
    });
  } finally { await run.close(); }
});
