import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { McpExplorationSession, assertMcpCapabilities, inspectGeneratedLocator, resolveAndReplay } from '../app/exploration/index.js';
import { LocalArtifactStore } from '../app/evidence/index.js';
import { assessGeneratedLocator } from '../app/locator/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function serve(html: string) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function serveSequence(first: string, later: string) {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(++hits === 1 ? first : later);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}/`, port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function factory(port: number) {
  return new ProtectedContextFactory(new ProfileCatalog([{
    id: 'm6-desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'm6-policy', version: '1' },
  }], [{ id: 'm6-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]));
}

test('M6-A connects MCP to the protected context and exposes testing tools', async () => {
  expect(() => assertMcpCapabilities(['browser_snapshot'])).toThrow('Missing required tools');
  const fixture = await serve('<button onclick="document.getElementById(\'status\').textContent=\'Saved\'">Save</button><p id="status">Waiting</p>');
  const protectedFactory = factory(fixture.port);
  const session = await McpExplorationSession.open(protectedFactory, { id: 'm6-desktop', version: '1' }, protectedFactory.catalog.resolve({ id: 'm6-desktop', version: '1' }));
  try {
    expect(session.toolInventory).toContain('browser_generate_locator');
    await session.navigate(fixture.url);
    const snapshot = await session.snapshot();
    expect(snapshot).toContain('Save');
    expect(await session.find('Save')).toContain('Save');
    const ref = /button "Save" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    expect(ref).toBeTruthy();
    await expect(session.generateLocator('e999999', 'missing button')).rejects.toThrow('browser_generate_locator');
    const locator = await session.generateLocator(ref!, 'Save button');
    expect(locator).toContain('getByRole');
    await session.click(ref!, 'Save button');
    expect(await session.snapshot()).toContain('Saved');
    expect(session.calls.map((call) => call.name)).toContain('browser_generate_locator');
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('M6-C checks live uniqueness and exact selected-target identity', async () => {
  const fixture = await serve('<button>Save</button><button>Save</button><button>Cancel</button>');
  const protectedFactory = factory(fixture.port);
  const session = await McpExplorationSession.open(protectedFactory, { id: 'm6-desktop', version: '1' }, protectedFactory.catalog.resolve({ id: 'm6-desktop', version: '1' }));
  try {
    await session.navigate(fixture.url);
    const snapshot = await session.snapshot();
    const saveRef = /button "Save" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
    expect(saveRef).toBeTruthy();
    const page = session.browserSession.context.pages()[0]!;
    const ambiguous = await inspectGeneratedLocator(page, "getByRole('button', { name: 'Save' })", saveRef!, snapshot);
    expect(ambiguous.matchCount).toBe(2);
    expect(assessGeneratedLocator("getByRole('button', { name: 'Save' })", ambiguous).checks.uniqueness).toBe('failed');
    const wrong = await inspectGeneratedLocator(page, "getByRole('button', { name: 'Cancel' })", saveRef!, snapshot);
    expect(wrong).toMatchObject({ matchCount: 1, observedTargetMatches: false });
    expect(assessGeneratedLocator("getByRole('button', { name: 'Cancel' })", wrong).checks.observedTarget).toBe('failed');
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('M6-A uses M3 policy for MCP navigation and secondary browser traffic', async () => {
  let deniedHits = 0;
  const denied = http.createServer((_request, response) => { deniedHits++; response.end('unexpected'); });
  denied.listen(0, '127.0.0.1');
  await once(denied, 'listening');
  const deniedAddress = denied.address();
  if (!deniedAddress || typeof deniedAddress === 'string') throw new Error('Missing denied port');
  const deniedUrl = `http://127.0.0.1:${deniedAddress.port}/`;
  const allowed = await serve(`<button>Save</button><iframe src="${deniedUrl}"></iframe><script>fetch('${deniedUrl}data').catch(() => {})</script>`);
  const protectedFactory = factory(allowed.port);
  const session = await McpExplorationSession.open(protectedFactory, { id: 'm6-desktop', version: '1' }, protectedFactory.catalog.resolve({ id: 'm6-desktop', version: '1' }));
  try {
    await session.navigate(allowed.url);
    expect(await session.snapshot()).toContain('Save');
    await expect(session.navigate(deniedUrl)).rejects.toThrow('NETWORK_POLICY_DENIED');
    expect(deniedHits).toBe(0);
    expect(session.browserSession.context.pages()).toHaveLength(1);
  } finally {
    await session.close();
    await allowed.close();
    denied.closeAllConnections();
    await new Promise<void>((resolve) => denied.close(() => resolve()));
  }
});

test('M6-B/C stores a menu prerequisite and replays both operations in fresh contexts', async () => {
  const fixture = await serve(`
    <button aria-label="Menu" onclick="document.getElementById('menu').hidden=false">☰</button>
    <div id="menu" role="menu" hidden><button role="menuitem" onclick="document.getElementById('status').textContent='Admin selected'">Admin</button></div>
    <p id="status">Waiting</p>
  `);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-menu-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const profile = protectedFactory.catalog.resolve({ id: 'm6-desktop', version: '1' });
  const source = {
    schemaVersion: '2', testSpecId: 'test-menu',
    sourceInstruction: 'Select Admin from the menu',
    executionProfileRef: { id: 'm6-desktop', version: '1' },
    startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Select Admin from the menu',
      target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Menu' }] } }],
  };
  try {
    await store.createJob(source, profile);
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot }) => {
      const admin = /menuitem "Admin" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      if (admin) return { kind: 'target', ref: admin, element: 'Admin menu item' };
      const menu = /button "Menu" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      if (menu) return { kind: 'prerequisite', ref: menu, element: 'Menu button', reason: 'Expose Admin', action: 'click' };
      return { kind: 'unresolved', reason: 'Menu or Admin unavailable' };
    });
    expect(outcome.status, outcome.failureReason).toBe('resolved');
    expect(outcome.resolved?.executionSteps.map((step) => [step.source, step.type])).toEqual([
      ['discoveredPrerequisite', 'click'], ['authored', 'click'],
    ]);
    expect(outcome.replay?.map((run) => run.outcomes.map((item) => item.status))).toEqual([
      ['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED'],
      ['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED'],
    ]);
    expect(outcome.replay?.[0].executionRunId).not.toBe(outcome.replay?.[1].executionRunId);
    const persisted = await store.readAttempt('test-menu', outcome.attemptId);
    expect(persisted.status).toBe('resolved');
    expect(persisted.evidenceRefs.length).toBeGreaterThan(0);
    expect(await store.readResolved('test-menu', outcome.resolved!.resolvedSpecId)).toEqual(outcome.resolved);
    for (const run of outcome.replay!) {
      const storedRun = await store.readRun('test-menu', run.executionRunId);
      expect(storedRun.outcomes.every((item) => item.evidenceRefs.length > 0)).toBe(true);
      expect(storedRun.profileFingerprint).toBe(profile.fingerprint);
    }
    expect(JSON.stringify(outcome.resolved)).not.toContain('[ref=');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M6-C preserves MCP frame context as a declarative locator', async () => {
  const fixture = await serve('<iframe title="payment frame" srcdoc="<button>Submit</button>"></iframe>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-frame-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = {
    schemaVersion: '2', testSpecId: 'test-frame', sourceInstruction: 'Select Submit in payment frame',
    executionProfileRef: { id: 'm6-desktop', version: '1' }, startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Select Submit in payment frame',
      target: { description: 'Submit', scope: [{ kind: 'frame', description: 'payment frame' }] } }],
  };
  try {
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot }) => {
      const ref = /button "Submit" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
      return ref ? { kind: 'target', ref, element: 'Submit in payment frame' }
        : { kind: 'unresolved', reason: 'Submit unavailable' };
    });
    expect(outcome.status, outcome.failureReason).toBe('resolved');
    const step = outcome.resolved?.executionSteps[0];
    expect(step && 'locator' in step && step.locator.validatedForm.type).toBe('frame');
    expect(outcome.replay?.map((run) => run.outcomes[0]?.status)).toEqual(['OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED']);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M6-C retains non-semantic icon locator evidence but blocks runnable acceptance', async () => {
  const fixture = await serve('<span onclick="document.body.append(\' opened\')">&#9776;</span>');
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-glyph-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = {
    schemaVersion: '2', testSpecId: 'test-glyph', sourceInstruction: 'Select the menu icon',
    executionProfileRef: { id: 'm6-desktop', version: '1' }, startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Select the menu icon', target: { description: 'menu icon' } }],
  };
  try {
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot }) => {
      const ref = /\[ref=([A-Za-z0-9]+)\]:\s*\u2630/.exec(snapshot)?.[1];
      return ref ? { kind: 'target', ref, element: 'menu icon' }
        : { kind: 'unresolved', reason: 'Menu icon unavailable' };
    });
    expect(outcome.status).toBe('unresolved');
    expect(outcome.failureStatus).toBe('LOCATOR_QUALITY_FAILED');
    const attempt = await store.readAttempt('test-glyph', outcome.attemptId);
    expect(attempt.status).toBe('unresolved');
    expect(attempt.results.some((item) => item.reason?.includes('UNSUPPORTED_GRAMMAR') || item.reason?.includes('WEAK_IDENTITY'))).toBe(true);
    expect(await store.listIds('test-glyph', 'resolved')).toEqual([]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M6-B replays a dialog prerequisite with a duplicate background Save', async () => {
  const fixture = await serve(`
    <button>Save</button><button onclick="document.getElementById('dialog').showModal()">Open profile</button>
    <dialog id="dialog" aria-label="Edit profile dialog"><button onclick="this.textContent='Saved'">Save</button></dialog>
  `);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-dialog-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = {
    schemaVersion: '2', testSpecId: 'test-dialog', sourceInstruction: 'Open profile and Save in the dialog',
    executionProfileRef: { id: 'm6-desktop', version: '1' }, startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Save in the profile dialog',
      target: { description: 'Save', scope: [{ kind: 'dialog', description: 'Edit profile dialog' }] } }],
  };
  try {
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot, prerequisites }) => {
      if (!prerequisites) {
        const ref = /button "Open profile" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
        return ref ? { kind: 'prerequisite', ref, element: 'Open profile', reason: 'Enter profile dialog', action: 'click' }
          : { kind: 'unresolved', reason: 'Profile opener unavailable' };
      }
      const dialog = snapshot.split('dialog "Edit profile dialog"')[1] ?? '';
      const ref = /button "Save"[^\n]*\[ref=([A-Za-z0-9]+)\]/.exec(dialog)?.[1];
      return ref ? { kind: 'target', ref, element: 'Save in profile dialog' }
        : { kind: 'unresolved', reason: 'Dialog Save unavailable' };
    });
    expect(outcome.status, outcome.failureReason).toBe('resolved');
    expect(outcome.resolved?.executionSteps.map((step) => step.source)).toEqual(['discoveredPrerequisite', 'authored']);
    expect(outcome.replay?.map((run) => run.outcomes.every((item) => item.status === 'OPERATION_SUCCEEDED'))).toEqual([true, true]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M6-B waits for a dynamic custom control and records only replay-required state changes', async () => {
  const fixture = await serve(`
    <button onclick="setTimeout(() => document.getElementById('apply').hidden=false, 250)">Show panel</button>
    <div id="apply" role="button" tabindex="0" hidden onclick="this.textContent='Applied'">Apply</div>
  `);
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-dynamic-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = {
    schemaVersion: '2', testSpecId: 'test-dynamic', sourceInstruction: 'Show the panel and select Apply',
    executionProfileRef: { id: 'm6-desktop', version: '1' }, startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Select Apply after showing the panel',
      target: { description: 'Apply', scope: [{ kind: 'region', description: 'panel' }] } }],
  };
  try {
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot, prerequisites }) => {
      if (!prerequisites) {
        const ref = /button "Show panel" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
        return ref ? { kind: 'prerequisite', ref, element: 'Show panel', reason: 'Reveal Apply', action: 'click' }
          : { kind: 'unresolved', reason: 'Panel opener unavailable' };
      }
      const ref = /button "Apply" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
      return ref ? { kind: 'target', ref, element: 'Apply control' } : { kind: 'wait', text: 'Apply' };
    });
    expect(outcome.status, outcome.failureReason).toBe('resolved');
    expect(outcome.resolved?.executionSteps).toHaveLength(2);
    expect(outcome.replay?.map((run) => run.outcomes.every((item) => item.status === 'OPERATION_SUCCEEDED'))).toEqual([true, true]);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M6-C reports a stale prerequisite locator as binding failure without repair', async () => {
  const fixture = await serveSequence(
    '<button aria-label="Menu" onclick="document.getElementById(\'admin\').hidden=false">Open</button><button id="admin" hidden>Admin</button>',
    '<button aria-label="Options" onclick="document.getElementById(\'admin\').hidden=false">Open</button><button id="admin" hidden>Admin</button>',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-m6-stale-'));
  const protectedFactory = factory(fixture.port);
  const store = new LocalArtifactStore(directory);
  const source = {
    schemaVersion: '2', testSpecId: 'test-stale', sourceInstruction: 'Select Admin from Menu',
    executionProfileRef: { id: 'm6-desktop', version: '1' }, startState: { url: fixture.url },
    steps: [{ id: 's1', type: 'click', sourceText: 'Select Admin from Menu',
      target: { description: 'Admin', scope: [{ kind: 'menu', description: 'Menu' }] } }],
  };
  try {
    await store.createJob(source, protectedFactory.catalog.resolve(source.executionProfileRef));
    const outcome = await resolveAndReplay(protectedFactory, store, source, ({ snapshot, prerequisites }) => {
      const ref = prerequisites
        ? /button "Admin" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1]
        : /button "Menu" \[ref=([A-Za-z0-9]+)\]/.exec(snapshot)?.[1];
      if (!ref) return { kind: 'unresolved', reason: 'Target unavailable' };
      return prerequisites ? { kind: 'target', ref, element: 'Admin' }
        : { kind: 'prerequisite', ref, element: 'Menu', reason: 'Expose Admin', action: 'click' };
    });
    expect(outcome.status, outcome.failureReason).toBe('resolved');
    expect(outcome.replay?.map((run) => run.outcomes.map((item) => [item.status, item.reason]))).toEqual([
      [['LOCATOR_BINDING_FAILED', 'NO_MATCH'], ['NOT_RUN', 'DEPENDENCY_FAILED']],
      [['LOCATOR_BINDING_FAILED', 'NO_MATCH'], ['NOT_RUN', 'DEPENDENCY_FAILED']],
    ]);
    expect(await store.listIds('test-stale', 'resolved')).toHaveLength(1);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
