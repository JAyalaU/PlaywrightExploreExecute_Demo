import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { parseResolvedTestSpec, parseTestSpec, type ExecutionStep } from '../app/domain/index.js';
import { acceptGeneratedLocator, type BindingResult } from '../app/locator/index.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';
import { classifyBinding, executeResolvedTestSpec, replayTwice } from '../app/runner/index.js';

async function fixtureServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function factory(port: number, waitMs = 600) {
  const catalog = new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 800, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: waitMs, navigationMs: 3000, waits: { default: waitMs } },
    networkPolicyRef: { id: 'fixture-policy', version: '1' },
  }], [{ id: 'fixture-policy', version: '1', destinations: [{ host: '127.0.0.1', ports: [port], addresses: ['127.0.0.1'] }] }]);
  return new ProtectedContextFactory(catalog);
}

const target = (description: string) => ({ description });
function accepted(expression: string, role?: string, accessibleName?: string) {
  return acceptGeneratedLocator(expression, {
    matchCount: 1, observedTargetMatches: true,
    ...(role === undefined ? {} : { role }),
    ...(accessibleName === undefined ? {} : { accessibleName }),
  });
}
function located(id: string, expression: string, description: string, role?: string, name?: string) {
  return { locatorId: `loc-${id}`, targetDescription: description, locator: accepted(expression, role, name) };
}
function bundle(base: string, authored: object[], execution: object[], start = 'about:blank') {
  const source = parseTestSpec({
    schemaVersion: '2', testSpecId: 'test-m4', sourceInstruction: 'Exercise the approved operations',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: start }, steps: authored,
  });
  const resolved = parseResolvedTestSpec({
    schemaVersion: '2', resolvedSpecId: 'resolved-m4', testSpecId: source.testSpecId,
    explorationAttemptId: 'explore-m4', executionProfileRef: source.executionProfileRef,
    runtimeVersions: { playwright: '1.63.0', mcp: 'fixture', runner: '1' },
    executionSteps: execution.map((step, index) => ({
      id: `x${index + 1}`, derivationEvidenceRef: `evidence/explore-m4/x${index + 1}.json`, ...step,
    })),
  }, source);
  return { source, resolved, base };
}
function authored(id: string, type: string, fields: object) { return { id, type, sourceText: `Do ${id}`, ...fields }; }
function step(originStepId: string, type: string, fields: object, source = 'authored') {
  return { originStepId, source, type, ...fields };
}

test('M4-A interprets every operation and wait variant in prerequisite order', async () => {
  const server = await fixtureServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><button aria-label="Menu" onclick="document.getElementById('admin').hidden=false">Open</button>
      <button id="admin" hidden onclick="document.getElementById('status').textContent='Saved Admin';document.getElementById('status').setAttribute('aria-label','Saved Admin');localStorage.setItem('visited','yes')">Admin</button>
      <label>Name<input /></label><label>Role<select><option>Guest</option><option>User</option></select></label>
      <div role="status" id="status">Ready</div><button id="continue" hidden>Continue</button>
      <script>setTimeout(()=>{document.getElementById('continue').hidden=false},80)</script>`);
  });
  try {
    const url = `${server.url}/start`;
    const user = [
      authored('s1', 'navigate', { url }),
      authored('s2', 'click', { target: target('Admin') }),
      authored('s3', 'fill', { target: target('Name'), value: { kind: 'dataRef', ref: 'fixtureName' } }),
      authored('s4', 'select_option', { target: target('Role'), value: 'User' }),
      authored('s5', 'wait_for', { condition: { type: 'target_visible', target: target('Continue') }, timeoutPolicyRef: 'default' }),
      authored('s6', 'wait_for', { condition: { type: 'url_exact', url }, timeoutPolicyRef: 'default' }),
      authored('s7', 'wait_for', { condition: { type: 'url_pattern', pattern: `${server.url}/*` }, timeoutPolicyRef: 'default' }),
      authored('s8', 'wait_for', { condition: { type: 'target_value', target: target('Role'), expectedValue: 'User' }, timeoutPolicyRef: 'default' }),
      authored('s9', 'assert_visible', { target: target('Continue') }),
      authored('s10', 'assert_text', { target: target('status'), expectedText: 'Saved', match: 'contains' }),
      authored('s11', 'assert_value', { target: target('Role'), expectedValue: 'User' }),
      authored('s12', 'assert_url', { expectedUrl: url, match: 'exact' }),
    ];
    const runSteps = [
      step('s1', 'navigate', { url }),
      step('s2', 'click', { ...located('menu', "getByRole('button', { name: 'Menu' })", 'Menu', 'button', 'Menu'), reason: 'Expose Admin' }, 'discoveredPrerequisite'),
      step('s2', 'click', located('admin', "getByRole('button', { name: 'Admin' })", 'Admin', 'button', 'Admin')),
      step('s3', 'fill', { ...located('name', "getByLabel('Name')", 'Name'), value: { kind: 'dataRef', ref: 'fixtureName' } }),
      step('s4', 'select_option', { ...located('role', "getByLabel('Role')", 'Role'), value: 'User' }),
      step('s5', 'wait_for', { ...located('continue', "getByRole('button', { name: 'Continue' })", 'Continue'), condition: { type: 'target_visible', target: target('Continue') }, timeoutPolicyRef: 'default' }),
      step('s6', 'wait_for', { condition: { type: 'url_exact', url }, timeoutPolicyRef: 'default' }),
      step('s7', 'wait_for', { condition: { type: 'url_pattern', pattern: `${server.url}/*` }, timeoutPolicyRef: 'default' }),
      step('s8', 'wait_for', { ...located('rolewait', "getByLabel('Role')", 'Role'), condition: { type: 'target_value', target: target('Role'), expectedValue: 'User' }, timeoutPolicyRef: 'default' }),
      step('s9', 'assert_visible', located('continueassert', "getByRole('button', { name: 'Continue' })", 'Continue')),
      step('s10', 'assert_text', { ...located('status', "getByRole('status', { name: 'Saved Admin' })", 'status'), expectedText: 'Saved', match: 'contains' }),
      step('s11', 'assert_value', { ...located('roleassert', "getByLabel('Role')", 'Role'), expectedValue: 'User' }),
      step('s12', 'assert_url', { expectedUrl: url, match: 'exact' }),
    ];
    const { source, resolved } = bundle(server.url, user, runSteps);
    const run = await executeResolvedTestSpec(factory(server.port), source, resolved, { dataValues: { resolve: async (ref) => {
      expect(ref).toBe('fixtureName');
      return 'Alice';
    } } });
    expect(run.outcomes).toHaveLength(13);
    expect(run.outcomes.map((item) => item.status)).toEqual([
      ...Array(8).fill('OPERATION_SUCCEEDED'), 'OPERATION_SUCCEEDED',
      'QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED', 'QA_ASSERTION_PASSED',
    ]);
    expect(run.outcomes[1]).toMatchObject({ originStepId: 's2', executionStepId: 'x2', locatorId: 'loc-menu' });
  } finally { await server.close(); }
});

test('M4-B browser outcomes separate absent assertions, ambiguity, identity drift, and false assertions', async () => {
  const server = await fixtureServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<button>Duplicate</button><button>Duplicate</button><button>Visible</button><label>Hidden<input hidden /></label>');
  });
  try {
    const cases = [
      { type: 'assert_visible', target: 'Missing', expression: "getByRole('button', { name: 'Missing' })", expectedStatus: 'QA_ASSERTION_FAILED', reason: 'NO_MATCH' },
      { type: 'assert_visible', target: 'Duplicate', expression: "getByRole('button', { name: 'Duplicate' })", expectedStatus: 'LOCATOR_BINDING_FAILED', reason: 'AMBIGUOUS_MATCH' },
      { type: 'assert_visible', target: 'Visible', expression: "getByRole('button', { name: 'Visible' })", role: 'button', name: 'Different', expectedStatus: 'LOCATOR_BINDING_FAILED', reason: 'IDENTITY_MISMATCH' },
      { type: 'assert_visible', target: 'Hidden', expression: "getByLabel('Hidden')", role: 'textbox', name: 'Hidden', expectedStatus: 'QA_ASSERTION_FAILED', reason: 'NOT_VISIBLE' },
    ] as const;
    for (const item of cases) {
      const { source, resolved } = bundle(server.url,
        [authored('s1', item.type, { target: target(item.target) })],
        [step('s1', item.type, located(item.target, item.expression, item.target, 'role' in item ? item.role : undefined, 'name' in item ? item.name : undefined))],
        server.url);
      const run = await executeResolvedTestSpec(factory(server.port, 120), source, resolved);
      expect(run.outcomes[0]).toMatchObject({ status: item.expectedStatus, reason: item.reason });
    }
  } finally { await server.close(); }
});

test('M4-B reports evaluated text/value/URL failures and bounded wait failures', async () => {
  const server = await fixtureServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<button>Visible</button><label>Role<select><option>Guest</option></select></label>');
  });
  try {
    const url = server.url;
    const cases = [
      { authored: authored('s1', 'assert_text', { target: target('Visible'), expectedText: 'Saved', match: 'exact' }),
        execution: step('s1', 'assert_text', { ...located('text', "getByRole('button', { name: 'Visible' })", 'Visible'), expectedText: 'Saved', match: 'exact' }), status: 'QA_ASSERTION_FAILED', reason: 'TEXT_MISMATCH' },
      { authored: authored('s1', 'assert_value', { target: target('Role'), expectedValue: 'User' }),
        execution: step('s1', 'assert_value', { ...located('value', "getByLabel('Role')", 'Role'), expectedValue: 'User' }), status: 'QA_ASSERTION_FAILED', reason: 'VALUE_MISMATCH' },
      { authored: authored('s1', 'assert_url', { expectedUrl: `${url}/other`, match: 'exact' }),
        execution: step('s1', 'assert_url', { expectedUrl: `${url}/other`, match: 'exact' }), status: 'QA_ASSERTION_FAILED', reason: 'URL_MISMATCH' },
      { authored: authored('s1', 'wait_for', { condition: { type: 'target_visible', target: target('Missing') }, timeoutPolicyRef: 'default' }),
        execution: step('s1', 'wait_for', { ...located('wait', "getByRole('button', { name: 'Missing' })", 'Missing'), condition: { type: 'target_visible', target: target('Missing') }, timeoutPolicyRef: 'default' }), status: 'LOCATOR_BINDING_FAILED', reason: 'NO_MATCH' },
      { authored: authored('s1', 'wait_for', { condition: { type: 'url_exact', url: `${url}/other` }, timeoutPolicyRef: 'default' }),
        execution: step('s1', 'wait_for', { condition: { type: 'url_exact', url: `${url}/other` }, timeoutPolicyRef: 'default' }), status: 'BROWSER_EXECUTION_FAILED', reason: 'WAIT_CONDITION_TIMEOUT' },
    ];
    for (const item of cases) {
      const { source, resolved } = bundle(url, [item.authored], [item.execution], url);
      const run = await executeResolvedTestSpec(factory(server.port, 120), source, resolved);
      expect(run.outcomes[0]).toMatchObject({ status: item.status, reason: item.reason });
    }
  } finally { await server.close(); }
});

test('M4-B classifies binding facts by operation and stops dependent steps', async () => {
  const server = await fixtureServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<p>Empty</p>'); });
  try {
    const click = step('s1', 'click', located('missing', "getByRole('button', { name: 'Missing' })", 'Missing'));
    const assertion = step('s1', 'assert_visible', located('missing', "getByRole('button', { name: 'Missing' })", 'Missing'));
    const matrix: BindingResult[] = [
      { reason: 'NO_MATCH', matchCount: 0 }, { reason: 'AMBIGUOUS_MATCH', matchCount: 2 },
      { reason: 'IDENTITY_MISMATCH', matchCount: 1, observedTargetMatches: false },
      { reason: 'FRAME_RESOLUTION_FAILED' }, { reason: 'UNSUPPORTED_FORM' }, { reason: 'EVALUATION_FAILED' },
    ];
    const clickStep = { ...click, id: 'x1', derivationEvidenceRef: 'evidence/x1.json' } as ExecutionStep;
    const assertStep = { ...assertion, id: 'x2', derivationEvidenceRef: 'evidence/x2.json' } as ExecutionStep;
    expect(classifyBinding(clickStep, matrix[0]!)).toMatchObject({ status: 'LOCATOR_BINDING_FAILED', reason: 'NO_MATCH' });
    expect(classifyBinding(assertStep, matrix[0]!)).toMatchObject({ status: 'QA_ASSERTION_FAILED', reason: 'NO_MATCH' });
    for (const fact of matrix.slice(1)) expect(classifyBinding(assertStep, fact)).toMatchObject({ status: 'LOCATOR_BINDING_FAILED', reason: fact.reason });

    const { source, resolved } = bundle(server.url,
      [authored('s1', 'click', { target: target('Missing') }), authored('s2', 'assert_visible', { target: target('Missing') })],
      [step('s1', 'click', { ...located('prerequisite', "getByRole('button', { name: 'Missing' })", 'Missing'), reason: 'Required prerequisite' }, 'discoveredPrerequisite'), click,
        step('s2', 'assert_visible', located('other', "getByRole('button', { name: 'Missing' })", 'Missing'))], server.url);
    const run = await executeResolvedTestSpec(factory(server.port, 150), source, resolved);
    expect(run.outcomes.map((item) => [item.status, item.reason])).toEqual([
      ['LOCATOR_BINDING_FAILED', 'NO_MATCH'], ['NOT_RUN', 'DEPENDENCY_FAILED'], ['NOT_RUN', 'DEPENDENCY_FAILED'],
    ]);
  } finally { await server.close(); }
});

test('M4 browser boundary rejects denied navigation and leaves a later clean run usable', async () => {
  const allowed = await fixtureServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<button>Ready</button>'); });
  const denied = await fixtureServer((_req, res) => { res.end('unexpected'); });
  try {
    const guarded = factory(allowed.port);
    const blocked = bundle(denied.url,
      [authored('s1', 'navigate', { url: denied.url })],
      [step('s1', 'navigate', { url: denied.url })]);
    const blockedRun = await executeResolvedTestSpec(guarded, blocked.source, blocked.resolved);
    expect(blockedRun.outcomes[0]).toMatchObject({ status: 'BROWSER_EXECUTION_FAILED', reason: 'NETWORK_POLICY_DENIED' });

    const clean = bundle(allowed.url,
      [authored('s1', 'navigate', { url: allowed.url }), authored('s2', 'assert_visible', { target: target('Ready') })],
      [step('s1', 'navigate', { url: allowed.url }), step('s2', 'assert_visible', located('ready', "getByRole('button', { name: 'Ready' })", 'Ready'))]);
    const cleanRun = await executeResolvedTestSpec(guarded, clean.source, clean.resolved);
    expect(cleanRun.outcomes.map((item) => item.status)).toEqual(['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED']);
  } finally { await allowed.close(); await denied.close(); }
});

test('M4-C replays scoped and frame locators in two fresh protected contexts', async () => {
  const server = await fixtureServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/frame') { res.end('<button onclick="parent.postMessage(\'done\',\'*\')">Submit</button>'); return; }
    res.end(`<!doctype html><div role="dialog" aria-label="Editor"><button onclick="localStorage.setItem('used','1');document.getElementById('state').textContent='Saved';document.getElementById('state').setAttribute('aria-label','Saved')">Save</button></div>
      <span role="status" aria-label="Fresh" id="state">Fresh</span><iframe title="payment frame" src="/frame"></iframe>
      <script>if(localStorage.getItem('used')){document.getElementById('state').textContent='Dirty';document.getElementById('state').setAttribute('aria-label','Dirty')}
      addEventListener('message',()=>{document.getElementById('state').textContent='Submitted';document.getElementById('state').setAttribute('aria-label','Submitted')})</script>`);
  });
  try {
    const scoped = "getByRole('dialog', { name: 'Editor' }).getByRole('button', { name: 'Save' })";
    const frame = "locator('iframe[title=\"payment frame\"]').contentFrame().getByRole('button', { name: 'Submit' })";
    const { source, resolved } = bundle(server.url,
      [authored('s1', 'assert_text', { target: target('state'), expectedText: 'Fresh', match: 'exact' }),
        authored('s2', 'click', { target: target('Save in Editor') }),
        authored('s3', 'click', { target: target('Submit in payment frame') }),
        authored('s4', 'assert_text', { target: target('state'), expectedText: 'Submitted', match: 'exact' })],
      [step('s1', 'assert_text', { ...located('fresh', "getByRole('status', { name: 'Fresh' })", 'state'), expectedText: 'Fresh', match: 'exact' }),
        step('s2', 'click', located('save', scoped, 'Save')),
        step('s3', 'click', located('submit', frame, 'Submit', 'button', 'Submit')),
        step('s4', 'assert_text', { ...located('submitted', "getByRole('status', { name: 'Submitted' })", 'state'), expectedText: 'Submitted', match: 'exact' })],
      server.url);
    const sourceBefore = JSON.stringify(source);
    const resolvedBefore = JSON.stringify(resolved);
    const replay = await replayTwice(factory(server.port), source, resolved);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(resolved)).toBe(resolvedBefore);
    expect(replay[0].executionRunId).not.toBe(replay[1].executionRunId);
    expect(replay[0].effectiveProfile.fingerprint).toBe(replay[1].effectiveProfile.fingerprint);
    for (const run of replay) expect(run.outcomes.map((item) => item.status)).toEqual([
      'QA_ASSERTION_PASSED', 'OPERATION_SUCCEEDED', 'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    ]);
    const changed = factory(server.port, 1000);
    await expect(executeResolvedTestSpec(changed, source, resolved, { expectedProfile: replay[0].effectiveProfile })).rejects.toThrow('new profile version');
  } finally { await server.close(); }
});
