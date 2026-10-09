import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { admitSemanticIntentV3, type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { SemanticGroundingSessionV1 } from '../app/exploration/semantic-grounding-v1.js';
import { issueSemanticGroundedTraceV1, type SemanticGroundedTraceRecordV1 } from '../app/domain/semantic-resolved-v10.js';
import { compileSemanticGroundedTraceV1 } from '../app/exploration/semantic-trace-compiler-v5.js';
import { SemanticCompilerV5Store, requireTrustedSemanticResolvedReadbackV10 } from '../app/evidence/semantic-compiler-store-v5.js';
import { SemanticCompilerDiagnosticsV1Store } from '../app/evidence/semantic-compiler-diagnostics-v1.js';
import { runSemanticTwoFreshReplaysV2, requireTrustedSemanticReplayV2 } from '../app/interpretation/semantic-replay-v2.js';
import { SemanticReplayV2Store, requireTrustedSemanticReplayReadbackV2 } from '../app/evidence/semantic-replay-store-v2.js';
import { deriveSemanticAgreementV2, parseSemanticReplayPairV2 } from '../app/domain/semantic-runner-v10.js';
import { parseSemanticResolvedTestSpecV10 } from '../app/domain/semantic-resolved-v10.js';
import { runSemanticGeneralizedOptInV1 } from '../app/interpretation/semantic-general-production-v1.js';
import { runSemanticResolvedTestV10, requireTrustedSemanticRunV10 } from '../app/runner/semantic-v10.js';
import { semanticRunSignatureV10 } from '../app/domain/semantic-runner-v10.js';
import { SemanticRunnerDiagnosticsV10Store } from '../app/runner/semantic-v10-diagnostics.js';

type Target = Extract<SemanticIntentStepV3, { type: 'action_intent' }>['target'];
const target = (category: string, exactName: string | null = null, ordinal: number | null = null,
  relation: Target['relation'] = 'unspecified', relatedStepId: string | null = null): Target =>
  ({ category, exactName, ordinal, relation, relatedStepId, context: null });
const action = (id: string, t: Target, desiredEffect: 'activate' | 'choose' | 'set_value' | 'set_checked',
  value: string | null = null, checkedState: boolean | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'action_intent', authoredText: id, target: t, desiredEffect, value, checkedState,
    authoredMechanic: null, dependsOnStepId: null });
const verify = (id: string, subject: Target | null, observable: 'exists' | 'enabled' | 'checked' |
  'selected' | 'value' | 'url' | 'cardinality', expected: boolean | number | string,
  dependsOnStepId: string | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'verification_intent', authoredText: id, subject, observable, comparator: 'equals',
    expected, dependsOnStepId });
const nav = (url: string): SemanticIntentStepV3 => ({ id: 'nav', type: 'navigate',
  authoredText: 'Navigate', url, dependsOnStepId: null });

async function fixture(html: string, stepsFor: (root: string) => SemanticIntentStepV3[],
  options: { replayHtml?: string; onRunStart?: (ordinal: 1 | 2, setHtml: (value: string) => void) => void;
    beforeReplay?: (factory: ProtectedContextFactory) => void; diagnostics?: boolean } = {}) {
  let servedHtml = html;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/' ? `<a href="/case">Dropdown</a><a href="/case">Add/Remove Elements</a>
      <a href="/case">Checkboxes</a><a href="/case">Dynamic Controls</a>${servedHtml}` : servedHtml);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const root = `http://127.0.0.1:${address.port}/`;
  const source = { testSpecId: 'semantic-runner-fixture', sourceInstruction: 'Offline authored fixture',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
  const admission = admitSemanticIntentV3(source, { ...source, schemaVersion: '7', sourceContractVersion: '3',
    semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2',
    steps: stepsFor(root) }, { verdict: 'faithful', issues: [] });
  const factory = new ProtectedContextFactory(new NativeProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 1500, navigationMs: 3000, waits: { default: 1500 } },
    profileSchemaVersion: '5', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows', presentationMode: 'headless',
  }]));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-v10-'));
  let session: McpExplorationSession | undefined;
  const close = async () => {
    await session?.close(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await rm(artifactRoot, { recursive: true, force: true });
  };
  try {
    session = await McpExplorationSession.open(factory, source.executionProfileRef,
      factory.catalog.resolve(source.executionProfileRef), 'semantic-source-attempt');
    const grounding = new SemanticGroundingSessionV1(session, admission, 'semantic-source-attempt');
    const records: SemanticGroundedTraceRecordV1[] = [];
    let groundingSessionId = '';
    for (const step of admission.spec.steps) {
      if (step.type === 'navigate') {
        await session.navigate(step.url);
        records.push({ type: 'navigate', step, observedUrl: session.browserSession.context.pages()[0]!.url() });
      } else if (step.type === 'action_intent') {
        const witness = await grounding.groundAction(step.id);
        groundingSessionId ||= witness.evidence.sessionId;
        const receipt = await grounding.executeGroundedAction(witness);
        records.push({ type: 'action', witness, receipt });
      } else {
        const witness = await grounding.groundVerification(step.id);
        groundingSessionId ||= witness.evidence.sessionId;
        records.push({ type: 'verification', witness });
      }
    }
    const trace = issueSemanticGroundedTraceV1(admission, { attemptId: 'semantic-source-attempt',
      sessionId: groundingSessionId, profileFingerprint: session.browserSession.effectiveProfile.fingerprint,
      records });
    await session.close(); session = undefined;
    const compiled = await compileSemanticGroundedTraceV1(factory, admission, trace);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled' || !compiled.resolved) throw new Error('Fixture did not compile');
    const store = new SemanticCompilerV5Store(artifactRoot);
    const readback = await store.writeCompilationV5(compiled, admission, trace);
    if (options.replayHtml !== undefined) servedHtml = options.replayHtml;
    options.beforeReplay?.(factory);
    const replay = await runSemanticTwoFreshReplaysV2(factory, readback,
      ordinal => options.onRunStart?.(ordinal, value => { servedHtml = value; }),
      options.diagnostics ? artifactRoot : undefined);
    const pair = requireTrustedSemanticReplayV2(replay);
    const replayStore = new SemanticReplayV2Store(artifactRoot);
    const replayReadback = await replayStore.writeReplayV2(replay, readback);
    expect(requireTrustedSemanticReplayReadbackV2(replayReadback)).toEqual(pair);
    return { root, admission, factory, trace, compiled, store, readback, pair, replayStore,
      replayReadback, artifactRoot, close };
  } catch (error) { await close(); throw error; }
}

const addRemoveHtml = `<button onclick="let b=document.createElement('button');b.textContent='Delete';
  b.onclick=()=>b.remove();document.body.append(b)">Add Element</button>`;

async function withActionPause<T>(raw: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.PLAYWRIGHT_DEMO_ACTION_PAUSE_MS;
  process.env.PLAYWRIGHT_DEMO_ACTION_PAUSE_MS = raw;
  try { return await run(); }
  finally {
    if (before === undefined) delete process.env.PLAYWRIGHT_DEMO_ACTION_PAUSE_MS;
    else process.env.PLAYWRIGHT_DEMO_ACTION_PAUSE_MS = before;
  }
}

test('v10 presentation pause follows only successful actions and preserves evidence and agreement', async () => {
  const f = await withActionPause('0', () => fixture('<input type="checkbox"><input type="checkbox" checked>',
    root => [nav(root), action('check1', target('checkbox', null, 1), 'set_checked', null, true),
      verify('checked1', target('checkbox', null, 1), 'checked', true, 'check1'),
      action('uncheck2', target('checkbox', null, 2), 'set_checked', null, false),
      verify('checked2', target('checkbox', null, 2), 'checked', false, 'uncheck2')]));
  try {
    let now = 0;
    const waits: number[] = [];
    const clock = { now: () => now, wait: async (ms: number) => { waits.push(ms); now += ms; } };
    const paced = await withActionPause('750', async () => requireTrustedSemanticRunV10(
      await runSemanticResolvedTestV10(f.factory, f.readback, clock)));
    expect(waits).toEqual([750, 750]);
    expect(paced.result).toEqual(f.pair.runs[0]!.result);
    expect(paced.steps).toEqual(f.pair.runs[0]!.steps);
    expect(paced.steps.map(step => step.evidenceDigest)).toEqual(
      f.pair.runs[0]!.steps.map(step => step.evidenceDigest));
    expect(semanticRunSignatureV10(paced)).toBe(semanticRunSignatureV10(f.pair.runs[0]!));
    expect(deriveSemanticAgreementV2([f.pair.runs[0]!, paced])).toEqual({
      agreement: 'agreed', terminal: 'QA_PASS' });
  } finally { await f.close(); }
});

test('v10 failed action has no presentation pause', async () => {
  const f = await withActionPause('0', () => fixture('<button>Target</button>', root => [nav(root),
    action('click', target('button', 'Target'), 'activate')], { replayHtml: '<button>Different</button>' }));
  try {
    const waits: number[] = [];
    const clock = { now: () => 0, wait: async (ms: number) => { waits.push(ms); } };
    const stopped = await withActionPause('750', async () => requireTrustedSemanticRunV10(
      await runSemanticResolvedTestV10(f.factory, f.readback, clock)));
    expect(stopped.result.kind).toBe('non_qa_stop');
    expect(stopped.steps.at(-1)?.status).toBe('stopped');
    expect(waits).toEqual([]);
  } finally { await f.close(); }
});

test('v10 resulting-state settling remains active with a controlled presentation clock', async () => {
  const html = `<div id="box"><input type="checkbox"></div>
    <button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='',60)">Remove</button>
    <button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='<input type=checkbox>',60)">Add</button>`;
  const f = await withActionPause('0', () => fixture(html, root => [nav(root),
    action('remove', target('button', 'Remove'), 'activate'),
    verify('gone', target('checkbox'), 'exists', false, 'remove'),
    action('add', target('button', 'Add'), 'activate'),
    verify('back', target('checkbox'), 'exists', true, 'add')]));
  try {
    let virtualNow = 0;
    const waits: number[] = [];
    const clock = { now: () => virtualNow, wait: async (ms: number) => {
      waits.push(ms); virtualNow += ms;
    } };
    const paced = await withActionPause('750', async () => requireTrustedSemanticRunV10(
      await runSemanticResolvedTestV10(f.factory, f.readback, clock)));
    expect(waits).toEqual([750, 750]);
    expect(paced.result).toEqual({ kind: 'completed', assertions: 2, passed: true });
    expect(paced.steps.filter(s => s.status === 'assertion_true').map(s => s.observation)).toEqual([0, 1]);
    expect(deriveSemanticAgreementV2([f.pair.runs[0]!, paced])).toEqual({
      agreement: 'agreed', terminal: 'QA_PASS' });
  } finally { await f.close(); }
});

test('v10 post-click pause follows document readiness and next assertion keeps its own readiness', async () => {
  let runningPage: import('@playwright/test').Page | undefined;
  const html = `<a href="/case">Go</a><button>Ready</button>
    <script>const until=Date.now()+60;while(Date.now()<until){}</script>`;
  const f = await withActionPause('0', () => fixture(html, root => [nav(root),
    action('go', target('link', 'Go'), 'activate'),
    verify('ready', target('button', 'Ready'), 'exists', true, 'go')], {
      beforeReplay: factory => {
        const originalOpen = factory.open.bind(factory);
        factory.open = async (...args) => {
          const session = await originalOpen(...args);
          session.context.on('page', page => { runningPage = page; });
          return session;
        };
      },
    }));
  try {
    const observed: Array<{ url: string; state: string }> = [];
    const clock = { now: () => 0, wait: async (_ms: number) => {
      const page = runningPage;
      expect(page).toBeDefined();
      observed.push({ url: page!.url(), state: await page!.evaluate(() => document.readyState) });
    } };
    const paced = await withActionPause('750', async () => requireTrustedSemanticRunV10(
      await runSemanticResolvedTestV10(f.factory, f.readback, clock)));
    expect(observed).toEqual([{ url: `${f.root}case`, state: 'complete' }]);
    expect(paced.result).toEqual({ kind: 'completed', assertions: 1, passed: true });
    expect(paced.steps.at(-1)?.status).toBe('assertion_true');
  } finally { await f.close(); }
});
test('v10 Dropdown reaches two agreeing deterministic true replays', async () => {
  const f = await fixture('<select><option value="">Please select</option><option value="1">Option 1</option></select>',
    root => [nav(root), action('open', target('link', 'Dropdown'), 'activate'),
      verify('url', null, 'url', `${root}case`),
      action('choose', target('dropdown'), 'choose', 'Option 1'),
      verify('selected', target('option', 'Option 1'), 'selected', true, 'choose')]);
  try { expect(f.pair.terminal).toBe('QA_PASS'); expect(f.pair.runs).toHaveLength(2);
    expect(f.pair.runs[0]?.steps.map(s => s.status)).toEqual(f.pair.runs[1]?.steps.map(s => s.status));
  } finally { await f.close(); }
});
test('v10 Add/Remove simple uses complete counts and two true replays', async () => {
  const f = await fixture(addRemoveHtml, root => [nav(root), action('open', target('link', 'Add/Remove Elements'), 'activate'),
    verify('url', null, 'url', `${root}case`), action('add', target('button', 'Add Element'), 'activate'),
    verify('exists', target('button', 'Delete'), 'exists', true, 'add'),
    action('delete', target('button', 'Delete'), 'activate'),
    verify('absent', target('button', 'Delete'), 'exists', false, 'delete')]);
  try { expect(f.pair.terminal).toBe('QA_PASS'); expect(f.pair.runs).toHaveLength(2);
    expect(f.pair.runs[0]?.steps.at(-1)?.observation).toBe(0);
  } finally { await f.close(); }
});
test('v10 repeated Delete uses authored created-by relation and count two then one', async () => {
  const f = await fixture(addRemoveHtml, root => [nav(root), action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2'),
    action('delete_new', target('button', 'Delete', null, 'created_by_step', 'add2'), 'activate'),
    verify('one', target('button', 'Delete'), 'cardinality', 1, 'delete_new')]);
  try { expect(f.pair.terminal).toBe('QA_PASS'); expect(f.pair.runs).toHaveLength(2);
    expect(f.pair.runs[0]?.steps.find(s => s.stepId === 'two')?.observation).toBe(2);
    expect(f.pair.runs[0]?.steps.find(s => s.stepId === 'one')?.observation).toBe(1);
  } finally { await f.close(); }
});

test('v10 private click and count diagnostics preserve repeated-control receipts and agreement', async () => {
  const f = await fixture(addRemoveHtml, root => [nav(root),
    action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2'),
    action('delete_new', target('button', 'Delete', null, 'created_by_step', 'add2'), 'activate'),
    verify('one', target('button', 'Delete'), 'cardinality', 1, 'delete_new')],
  { diagnostics: true });
  try {
    expect(f.pair.terminal).toBe('QA_PASS');
    expect(f.pair.runs).toHaveLength(2);
    const store = new SemanticRunnerDiagnosticsV10Store(f.artifactRoot);
    for (const run of f.pair.runs) {
      const privateRecord = await store.readByRunId(run.executionRunId);
      expect(privateRecord.executionRunId).toBe(run.executionRunId);
      expect(privateRecord.clicks.filter(item => item.phase === 'click_invocation_returned')).toHaveLength(3);
      expect(privateRecord.clicks.filter(item => item.phase === 'action_receipt_sealed')).toHaveLength(3);
      expect(privateRecord.effects.find(item => item.actionStepId === 'add1')).toMatchObject({
        assertionStepId: 'two', count: 1, error: false });
      expect(privateRecord.effects.find(item => item.actionStepId === 'add2')).toMatchObject({
        assertionStepId: 'two', count: 2, error: false });
      expect(privateRecord.effects.find(item => item.actionStepId === 'delete_new')).toMatchObject({
        assertionStepId: 'one', count: 1, error: false });
      expect(privateRecord.counts.map(item => [item.stepId, item.initialCount,
        item.finalCount, item.exhausted])).toEqual([['two', 2, 2, false], ['one', 1, 1, false]]);
      expect(privateRecord.boundaries.map(item => item.stepId)).toContain('delete_new');
      expect(run.steps.find(item => item.stepId === 'delete_new')?.status).toBe('action_succeeded');
    }
    expect(f.pair.agreement).toBe('agreed');
    const plain = requireTrustedSemanticRunV10(await runSemanticResolvedTestV10(f.factory, f.readback));
    expect(plain.steps).toEqual(f.pair.runs[0]!.steps);
    expect(semanticRunSignatureV10(plain)).toBe(semanticRunSignatureV10(f.pair.runs[0]!));
  } finally { await f.close(); }
});

test('v10 click timeout after guards retains private throw phase without changing stop', async () => {
  const f = await fixture('<button>Target</button>', root => [nav(root),
    action('click', target('button', 'Target'), 'activate')], {
    replayHtml: `<button>Target</button><div style="position:fixed;inset:0;z-index:1000;background:transparent"></div>`,
    diagnostics: true,
  });
  try {
    expect(f.pair.terminal).toBe('NON_QA');
    const run = f.pair.runs[0]!;
    expect(run.result).toMatchObject({ kind: 'non_qa_stop', reason: 'ACTION_FAILED_PARTIAL_OR_UNKNOWN',
      failedStepId: 'click' });
    expect(run.steps.at(-1)).toMatchObject({ invocation: 'unknown', status: 'stopped' });
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(run.executionRunId);
    expect(privateRecord.clicks.map(item => item.phase)).toEqual([
      'guard_complete', 'click_invocation_started', 'click_invocation_threw']);
    expect(privateRecord.clicks.at(-1)?.failure).toBe('PLAYWRIGHT_CLICK_TIMEOUT');
    expect(JSON.stringify(privateRecord)).not.toContain('Timeout 1500ms exceeded');
  } finally { await f.close(); }
});

test('v10 injected detached click after guards retains private category and original stop', async () => {
  const f = await fixture('<button>Target</button>', root => [nav(root),
    action('click', target('button', 'Target'), 'activate')], { diagnostics: true,
    beforeReplay: factory => {
      const open = factory.open.bind(factory);
      factory.open = async (...args) => {
        const session = await open(...args);
        const newPage = session.context.newPage.bind(session.context);
        session.context.newPage = async () => {
          const page = await newPage();
          const locate = page.locator.bind(page);
          page.locator = ((...locatorArgs: Parameters<typeof page.locator>) => {
            const locator = locate(...locatorArgs);
            const nth = locator.nth.bind(locator);
            locator.nth = (index: number) => {
              const item = nth(index);
              const elementHandle = item.elementHandle.bind(item);
              item.elementHandle = async (...handleArgs) => {
                const handle = await elementHandle(...handleArgs);
                if (handle) handle.click = async () => { throw new Error('Element is detached from DOM'); };
                return handle;
              };
              return item;
            };
            return locator;
          }) as typeof page.locator;
          return page;
        };
        return session;
      };
    },
  });
  try {
    const run = f.pair.runs[0]!;
    expect(run.result).toMatchObject({ kind: 'non_qa_stop', reason: 'ACTION_FAILED_PARTIAL_OR_UNKNOWN',
      failedStepId: 'click' });
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(run.executionRunId);
    expect(privateRecord.clicks.map(item => item.phase)).toEqual([
      'guard_complete', 'click_invocation_started', 'click_invocation_threw']);
    expect(privateRecord.clicks.at(-1)?.failure).toBe('TARGET_DETACHED_DURING_CLICK');
  } finally { await f.close(); }
});

test('v10 count diagnostic records observed asynchronous 0 to 1 to 2 settling', async () => {
  const html = `<button onclick="setTimeout(()=>{let b=document.createElement('button');b.textContent='Delete';document.body.append(b)},80);setTimeout(()=>{let b=document.createElement('button');b.textContent='Delete';document.body.append(b)},300)">Add</button>`;
  const f = await fixture(html, root => [nav(root),
    action('add', target('button', 'Add'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add')], { diagnostics: true });
  try {
    expect(f.pair.terminal).toBe('QA_PASS');
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(f.pair.runs[0]!.executionRunId);
    const count = privateRecord.counts.find(item => item.stepId === 'two');
    expect(count).toMatchObject({ initialCount: 0, finalCount: 2, exhausted: false });
    expect(count?.transitions.map(item => item.count)).toEqual([1, 2]);
    expect(privateRecord.effects.find(item => item.actionStepId === 'add')).toMatchObject({
      count: 0, error: false });
  } finally { await f.close(); }
});

test('v10 click diagnostic observes document replacement without changing receipt', async () => {
  const f = await fixture('<button>Target</button>', root => [nav(`${root}case`),
    action('click', target('button', 'Target'), 'activate')], {
    replayHtml: `<button onclick="location.href='/case'">Target</button>`, diagnostics: true,
  });
  try {
    const run = f.pair.runs[0]!;
    expect(run.steps.at(-1)).toMatchObject({ invocation: 'returned', status: 'action_succeeded' });
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(run.executionRunId);
    const returned = privateRecord.clicks.find(item => item.phase === 'click_invocation_returned');
    expect(returned?.navigationDuringClick).toBe(true);
    expect(returned?.documentReplacedDuringClick).toBe(true);
  } finally { await f.close(); }
});

test('v10 count diagnostic retains bounded stable-zero false result', async () => {
  const source = `<button onclick="for(let i=0;i<2;i++){let b=document.createElement('button');b.textContent='Delete';document.body.append(b)}">Add</button>`;
  const f = await fixture(source, root => [nav(root),
    action('add', target('button', 'Add'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add')],
  { replayHtml: '<button>Add</button>', diagnostics: true });
  try {
    expect(f.pair.terminal).toBe('QA_FAIL');
    const run = f.pair.runs[0]!;
    expect(run.steps.at(-1)).toMatchObject({ status: 'assertion_false', observation: 0 });
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(run.executionRunId);
    expect(privateRecord.counts.find(item => item.stepId === 'two')).toMatchObject({
      initialCount: 0, transitions: [], finalCount: 0, exhausted: true });
    expect(privateRecord.effects.find(item => item.actionStepId === 'add')).toMatchObject({
      count: 0, error: false });
  } finally { await f.close(); }
});

test('v10 count diagnostic correlates transient two and reload request without changing stop', async () => {
  const source = `<button onclick="for(let i=0;i<3;i++){let b=document.createElement('button');b.textContent='Delete';document.body.append(b)}">Add</button>`;
  const replayHtml = `<button onclick="setTimeout(()=>{for(let i=0;i<2;i++){let b=document.createElement('button');b.textContent='Delete';document.body.append(b)}},80);setTimeout(()=>location.reload(),350)">Add</button>`;
  const f = await fixture(source, root => [nav(root),
    action('add', target('button', 'Add'), 'activate'),
    verify('three', target('button', 'Delete'), 'cardinality', 3, 'add')],
  { replayHtml, diagnostics: true });
  try {
    const run = f.pair.runs[0]!;
    expect(run.result).toMatchObject({ kind: 'non_qa_stop', reason: 'ENVIRONMENT_FAILURE',
      failedStepId: 'three' });
    const privateRecord = await new SemanticRunnerDiagnosticsV10Store(f.artifactRoot)
      .readByRunId(run.executionRunId);
    const observed = privateRecord.counts.find(item => item.stepId === 'three');
    const failure = privateRecord.countFailures.find(item => item.stepId === 'three');
    expect(observed).toMatchObject({ initialCount: 0, transitions: [{ count: 2 }],
      finalCount: 2, interrupted: true, navigationRequestedDuringSettling: true });
    expect(failure?.category).toBe('COUNT_SETTLING_WAIT_ERROR');
    expect(observed!.ended.navigationRequestGeneration).toBeGreaterThan(
      observed!.started.navigationRequestGeneration);
    expect(observed!.documentChanged).toBe(false);
  } finally { await f.close(); }
});
test('v10 Checkboxes replays ordinal check and uncheck idempotently in two fresh runs', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true),
    verify('checked1', target('checkbox', null, 1), 'checked', true, 'check1'),
    action('uncheck2', target('checkbox', null, 2), 'set_checked', null, false),
    verify('checked2', target('checkbox', null, 2), 'checked', false, 'uncheck2')]);
  try { expect(f.pair.terminal).toBe('QA_PASS'); expect(f.pair.runs).toHaveLength(2);
    expect(f.pair.runs[0]?.steps.find(s => s.stepId === 'check1')?.operation).toBe('check');
    expect(f.pair.runs[0]?.steps.find(s => s.stepId === 'uncheck2')?.operation).toBe('uncheck');
  } finally { await f.close(); }
});
test('v10 Dynamic Controls settles bounded same-document resulting states', async () => {
  const html = `<div id="box"><input type="checkbox"></div><button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='',60)">Remove</button>
    <button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='<input type=checkbox>',60)">Add</button>
    <input type="text" disabled><button onclick="setTimeout(()=>document.querySelector('input[type=text]').disabled=false,60)">Enable</button>
    <button onclick="setTimeout(()=>document.querySelector('input[type=text]').disabled=true,60)">Disable</button>`;
  const f = await fixture(html, root => [nav(root), action('remove', target('button', 'Remove'), 'activate'),
    verify('gone', target('checkbox'), 'exists', false, 'remove'),
    action('add', target('button', 'Add'), 'activate'),
    verify('back', target('checkbox'), 'exists', true, 'add'),
    action('enable', target('button', 'Enable'), 'activate'),
    verify('enabled', target('text input'), 'enabled', true, 'enable'),
    action('disable', target('button', 'Disable'), 'activate'),
    verify('disabled', target('text input'), 'enabled', false, 'disable')]);
  try { expect(f.pair.terminal).toBe('QA_PASS'); expect(f.pair.runs).toHaveLength(2);
  } finally { await f.close(); }
});

test('v10 checkbox cardinality and identifiable ordinal order drift stop non-QA before check', async () => {
  const cardinality = await fixture('<input type="checkbox"><input type="checkbox" checked>', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)],
  { replayHtml: '<input type="checkbox"><input type="checkbox" checked><input type="checkbox">' });
  try { expect(cardinality.pair.terminal).toBe('NON_QA');
    expect(cardinality.pair.runs[0]?.result).toMatchObject({ kind: 'non_qa_stop', reason: 'CARDINALITY_DRIFT' });
    expect(cardinality.pair.runs[0]?.steps.at(-1)?.invocation).toBe('not_invoked');
  } finally { await cardinality.close(); }
  const order = await fixture('<label>A<input type="checkbox"></label><label>B<input type="checkbox"></label>',
    root => [nav(root), action('check1', target('checkbox', null, 1), 'set_checked', null, true)],
    { replayHtml: '<label>B<input type="checkbox"></label><label>A<input type="checkbox"></label>' });
  try { expect(order.pair.terminal).toBe('NON_QA');
    expect(order.pair.runs[0]?.result).toMatchObject({ kind: 'non_qa_stop', reason: 'ORDINAL_DRIFT' });
  } finally { await order.close(); }
});

test('v10 repeated-action ambiguity and missing checkable capability stay non-QA', async () => {
  const ambiguous = await fixture(addRemoveHtml, root => [nav(root),
    action('add', target('button', 'Add Element'), 'activate'),
    action('delete', target('button', 'Delete'), 'activate')],
    { replayHtml: `<button onclick="for(let i=0;i<2;i++){let b=document.createElement('button');b.textContent='Delete';document.body.append(b)}">Add Element</button>` });
  try { expect(ambiguous.pair.terminal).toBe('NON_QA');
    expect(ambiguous.pair.runs[0]?.result).toMatchObject({ kind: 'non_qa_stop', reason: 'CARDINALITY_DRIFT' });
  } finally { await ambiguous.close(); }
  const capability = await fixture('<input type="checkbox">', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)],
    { replayHtml: '<button role="checkbox" aria-checked="false"></button>' });
  try { expect(capability.pair.terminal).toBe('NON_QA');
    expect(capability.pair.runs[0]?.result.kind).toBe('non_qa_stop');
    expect(capability.pair.runs[0]?.steps.at(-1)?.invocation).toBe('not_invoked');
  } finally { await capability.close(); }
});

test('v10 native option remap and selected owner drift stop before select', async () => {
  const steps = (root: string) => [nav(root), action('choose', target('dropdown'), 'choose', 'Option 1')];
  const remap = await fixture('<select><option value="1">Option 1</option></select>', steps,
    { replayHtml: '<select><option value="changed">Option 1</option></select>' });
  try { expect(remap.pair.terminal).toBe('NON_QA');
    expect(remap.pair.runs[0]?.result).toMatchObject({ kind: 'non_qa_stop', reason: 'OPTION_MAPPING_MISMATCH' });
  } finally { await remap.close(); }
  const owner = await fixture('<select><option value="1">Option 1</option></select>', steps,
    { replayHtml: '<div role="combobox"><option value="1">Option 1</option></div>' });
  try { expect(owner.pair.terminal).toBe('NON_QA');
    expect(owner.pair.runs[0]?.result.kind).toBe('non_qa_stop');
  } finally { await owner.close(); }
});

test('v10 healthy opposite checked, enabled and value states produce two agreeing QA false runs', async () => {
  const cases = [
    { source: '<input type="checkbox" checked>', replay: '<input type="checkbox">',
      steps: (root: string) => [nav(root), verify('state', target('checkbox', null, 1), 'checked', true)] },
    { source: '<input type="text">', replay: '<input type="text" disabled>',
      steps: (root: string) => [nav(root), verify('state', target('text input'), 'enabled', true)] },
    { source: '<input type="text" value="one">', replay: '<input type="text" value="two">',
      steps: (root: string) => [nav(root), verify('state', target('text input'), 'value', 'one')] },
  ];
  for (const item of cases) {
    const f = await fixture(item.source, item.steps, { replayHtml: item.replay });
    try { expect(f.pair.terminal).toBe('QA_FAIL'); expect(f.pair.agreement).toBe('agreed');
      expect(f.pair.runs).toHaveLength(2);
      expect(f.pair.runs.every(r => r.steps.at(-1)?.status === 'assertion_false')).toBe(true);
    } finally { await f.close(); }
  }
});

test('v10 bounded async state that never arrives and count-zero contradiction are QA false', async () => {
  const source = `<button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='',50)">Remove</button>
    <div id="box"><input type="checkbox"></div>`;
  const replay = `<button>Remove</button><div id="box"><input type="checkbox"></div>`;
  const f = await fixture(source, root => [nav(root), action('remove', target('button', 'Remove'), 'activate'),
    verify('absent', target('checkbox'), 'exists', false, 'remove')], { replayHtml: replay });
  try { expect(f.pair.terminal).toBe('QA_FAIL'); expect(f.pair.agreement).toBe('agreed');
    expect(f.pair.runs[0]?.steps.at(-1)?.observation).toBe(1);
  } finally { await f.close(); }
});

test('v10 missing unique boolean subject and document replacement after check are non-QA', async () => {
  const missing = await fixture('<input type="checkbox" checked>', root => [nav(root),
    verify('checked', target('checkbox', null, 1), 'checked', true)], { replayHtml: '' });
  try { expect(missing.pair.terminal).toBe('NON_QA');
    expect(missing.pair.runs[0]?.result).toMatchObject({ kind: 'non_qa_stop', reason: 'CARDINALITY_DRIFT' });
  } finally { await missing.close(); }
  const replace = await fixture('<input type="checkbox">', root => [nav(root),
    action('check', target('checkbox', null, 1), 'set_checked', null, true)],
    { replayHtml: `<input type="checkbox" onchange="location.replace('/case')">` });
  try { expect(replace.pair.terminal).toBe('NON_QA');
    expect(replace.pair.runs[0]?.result.kind).toBe('non_qa_stop');
  } finally { await replace.close(); }
});

test('v10 first true and second false replay disagrees; cleanup uncertainty cannot issue QA', async () => {
  const f = await fixture('<input type="text" value="one">', root => [nav(root),
    verify('value', target('text input'), 'value', 'one')],
  { onRunStart: (ordinal, setHtml) => { if (ordinal === 2) setHtml('<input type="text" value="two">'); } });
  try { expect(f.pair.terminal).toBe('NON_QA'); expect(f.pair.agreement).toBe('disagreed');
    const uncertain = structuredClone(f.pair);
    uncertain.runs[0]!.cleanup = 'unverified';
    expect(deriveSemanticAgreementV2(uncertain.runs).terminal).toBe('NON_QA');
    expect(() => parseSemanticReplayPairV2(uncertain)).toThrow();
  } finally { await f.close(); }
});

test('v10 two false runs with different readable values do not agree', async () => {
  const f = await fixture('<input type="text" value="one">', root => [nav(root),
    verify('value', target('text input'), 'value', 'one')],
  { replayHtml: '<input type="text" value="two">',
    onRunStart: (ordinal, setHtml) => { if (ordinal === 2) setHtml('<input type="text" value="three">'); } });
  try { expect(f.pair.runs).toHaveLength(2); expect(f.pair.runs.every(r => r.result.kind === 'completed')).toBe(true);
    expect(f.pair.runs.every(r => r.steps.at(-1)?.status === 'assertion_false')).toBe(true);
    expect(f.pair.agreement).toBe('disagreed'); expect(f.pair.terminal).toBe('NON_QA');
  } finally { await f.close(); }
});

test('v10 actual protected cleanup uncertainty stops replay non-QA', async () => {
  const f = await fixture('<input type="text" value="one">', root => [nav(root),
    verify('value', target('text input'), 'value', 'one')], { beforeReplay: factory => {
      const open = factory.open.bind(factory);
      factory.open = async (...args) => {
        const session = await open(...args);
        const close = session.closeWithFinalCheck.bind(session);
        session.closeWithFinalCheck = async check => {
          await close(check);
          throw new Error('Injected cleanup uncertainty');
        };
        return session;
      };
    } });
  try { expect(f.pair.terminal).toBe('NON_QA'); expect(f.pair.agreement).toBe('not_established');
    expect(f.pair.runs).toHaveLength(1);
    expect(f.pair.runs[0]?.cleanup).toBe('unverified');
  } finally { await f.close(); }
});

test('v10 trusted handoff rejects malformed cross-version input', async () => {
  const f = await fixture('<button>Go</button>', root => [nav(root),
    action('go', target('button', 'Go'), 'activate')]);
  try {
    const wrong = { ...f.compiled.resolved!, schemaVersion: '9' };
    expect(() => parseSemanticResolvedTestSpecV10(wrong, f.trace)).toThrow();
    expect(() => requireTrustedSemanticResolvedReadbackV10({} as typeof f.readback)).toThrow();
    const restarted = new SemanticReplayV2Store(f.artifactRoot);
    const persisted = await restarted.readReplayV2(f.compiled.resolved!.testSpecId,
      f.compiled.resolved!.resolvedSpecId, f.pair.orchestrationId, f.readback);
    expect(requireTrustedSemanticReplayReadbackV2(persisted)).toEqual(f.pair);
    const file = path.join(f.artifactRoot, 'semantic-replay-v2-resolved-v10',
      f.compiled.resolved!.testSpecId, f.compiled.resolved!.resolvedSpecId,
      `${f.pair.orchestrationId}.json`);
    const altered = JSON.parse(await readFile(file, 'utf8')) as { replay: { terminal: string } };
    altered.replay.terminal = 'QA_FAIL';
    await writeFile(file, JSON.stringify(altered));
    await expect(restarted.readReplayV2(f.compiled.resolved!.testSpecId,
      f.compiled.resolved!.resolvedSpecId, f.pair.orchestrationId, f.readback)).rejects.toThrow();
    const compilerFile = path.join(f.artifactRoot, 'semantic-compiler-v5-resolved-v10',
      f.compiled.resolved!.testSpecId, `${f.compiled.compiler.compilerAttemptId}.json`);
    const forgedCompiler = JSON.parse(await readFile(compilerFile, 'utf8')) as {
      resolved: { executionSteps: Array<{ operation?: string }> } };
    const actionStep = forgedCompiler.resolved.executionSteps.find(step => step.operation);
    if (!actionStep) throw new Error('Expected action');
    actionStep.operation = 'check';
    await writeFile(compilerFile, JSON.stringify(forgedCompiler));
    await expect(new SemanticCompilerV5Store(f.artifactRoot).readResolvedV10(
      f.compiled.resolved!.testSpecId, f.compiled.compiler.compilerAttemptId,
      f.admission)).rejects.toThrow();
  } finally { await f.close(); }
});

test('semantic-general v10 handoff runs without a route-selection gate', async () => {
  const f = await fixture('<button>Go</button>', root => [nav(root),
    action('go', target('button', 'Go'), 'activate'),
    verify('exists', target('button', 'Go'), 'exists', true, 'go')]);
  try {
    const outcome = await runSemanticGeneralizedOptInV1(f.factory, f.artifactRoot,
      f.admission, f.trace);
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind === 'replayed') {
      expect(outcome.terminal).toBe('QA_PASS');
      expect(requireTrustedSemanticReplayReadbackV2(outcome.replay).runs).toHaveLength(2);
      const diagnostic = await new SemanticCompilerDiagnosticsV1Store(f.artifactRoot)
        .readByCorrelation({ testSpecId: f.trace.testSpecId });
      expect(diagnostic).toEqual(expect.arrayContaining([
        expect.objectContaining({ recordVersion: 'semantic_compiler_trace_diagnostic_v1',
          traceId: `semantic-trace-${f.trace.traceDigest.slice(0, 32)}` }),
        expect.objectContaining({ recordVersion: 'semantic_compiler_seal_diagnostic_v1',
          allStepsSealed: true, consumedEvidenceRefreshedAtFinalSeal: false }),
      ]));
    }
  } finally {
    await f.close();
  }
});
