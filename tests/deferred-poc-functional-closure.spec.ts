import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ProfileCatalog, ProtectedContextFactory, parseTrustedBrowserBackend } from '../app/profile/index.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';
import { parseTrustedLocalConfiguration, selectActivePocBrowserProfile } from '../app/local/contracts.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { DeferredDocumentReadinessTracker } from '../app/exploration/deferred-document-readiness.js';
import { CommittedDocumentReadiness } from '../app/browser-action/committed-document-readiness.js';
import { runAgenticSubprocessAdapterV2 } from '../app/subprocess/agentic-entry.js';
import { SuccessfulTraceV5Store } from '../app/evidence/trace-store-v5.js';
import { DeferredCompilerV4Store } from '../app/evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store, requireTrustedDeferredReplayReadbackV1 } from '../app/evidence/deferred-replay-store-v9.js';
import { DeferredWorkflowStopStoreV1 } from '../app/evidence/deferred-workflow-store.js';
import { parseProtectedTraceCaptureBundleV5 } from '../app/exploration/trace-assembly-v5.js';
import { successfulTraceDigestV5 } from '../app/domain/agentic-trace-v5.js';
import { candidateGroundingDigest as hash } from '../app/domain/action-candidate-grounding.js';
import { parseDeferredRunnerRecordV9 } from '../app/domain/deferred-action-runner.js';
import { deferredFiveStepSource } from './helpers/deferred-five-step-source.js';
import { DeferredViewerNoticeSchema, DeferredFrameNoticeSchema,
  type DeferredViewerNotice, type DeferredFrameNotice } from '../app/observability/deferred-viewer-channel.js';

test.describe.configure({ mode: 'serial' });

const rootUrl = 'https://the-internet.herokuapp.com/';
const dropdownUrl = `${rootUrl}dropdown`;
const wrongUrl = `${rootUrl}wrong`;
const authoredTask = deferredFiveStepSource().sourceInstruction;
const directActionTask = `1. Go to ${rootUrl}\n2. Find and click the link with the text: "Dropdown"\n` +
  '3. From the dropdown, select Option 1.\n4. Verify that Option 1 is selected.';
const gate = 'PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE';
const optionMarkup = '<select><option value="">Please select an option</option>' +
  '<option value="1">Option 1</option><option value="2">Option 2</option></select>';
type Case = 'normal' | 'duplicate_links' | 'wrong_url' | 'duplicate_selects' | 'missing_option' |
  'replay_disagreement' | 'next_observation_unavailable' | 'compiler_url_snapshot_unavailable' |
  'runner_url_snapshot_unavailable' | 'runner_no_page' | 'runner_closed_page' | 'direct_action' |
  'runner_unrelated_drift' | 'runner_missing_select' | 'runner_duplicate_selects' |
  'runner_missing_option' | 'runner_changed_option' | 'runner_frame_drift' |
  'different_initial' | 'redirect_initial' | 'delayed_load' | 'delayed_target' | 'missing_target' |
  'runner_state_read_timeout' | 'delayed_destination_dcl';

async function fixture(mode: Case, isolated = false, localWindows = false, failFrameCapture = false,
  slowCandidateRead = false, transientFrameTimeouts = 0) {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'deferred-poc-closure-'));
  const config = {
    profiles: [{ id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
      locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
      networkPolicyRef: { id: 'fixture', version: '1' },
      ...(isolated || localWindows ? { profileSchemaVersion: '3', presentationMode: 'headless', browserIsolation: 'docker' } : {}) }],
    networkPolicies: [{ id: 'fixture', version: '1', destinations: [{ host: 'the-internet.herokuapp.com',
      ports: [443], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false,
      failureVideo: false, sensitiveBinaryApproved: false }, artifactRoot, retentionDays: 7,
  };
  const request = { taskText: mode === 'direct_action' ? directActionTask : authoredTask,
    targetUrl: mode === 'different_initial' ? `${rootUrl}start` : rootUrl,
    executionProfileRef: { id: 'desktop', version: '1' } };
  if (localWindows) request.executionProfileRef = selectActivePocBrowserProfile(
    parseTrustedLocalConfiguration(config), 'local-windows').reference;
  const providerFormats: string[] = [];
  const primary = [
    { id: 's1', type: 'navigate', url: rootUrl },
    { id: 's2', type: 'action_goal', effect: 'activate', explicitOperation: 'click', argument: null,
      targetConstraints: [{ kind: 'role', value: 'link', polarity: 'positive' },
        { kind: 'name', value: 'Dropdown', polarity: 'positive' }], dependsOnStepId: null },
    { id: 's3', type: 'verification_goal', verificationVersion: null,
      instruction: `Verify the resulting URL is ${dropdownUrl}`, subject: null, intent: null, dependsOnStepId: 's2' },
    { id: 's4', type: 'action_goal', effect: 'choose', explicitOperation: 'select_option',
      argument: { purpose: 'choice', value: 'Option 1' },
      targetConstraints: [{ kind: 'role', value: 'dropdown', polarity: 'positive' }], dependsOnStepId: null },
    { id: 's5', type: 'verification_goal', verificationVersion: '2', optionLabel: 'Option 1',
      expectedSelected: true, controlConstraints: [], dependsOnStepId: 's4' },
  ];
  if (mode === 'direct_action') {
    primary.splice(2, 1);
    primary[2]!.dependsOnStepId = 's2';
  }
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    const format = body.text.format.name as string;
    providerFormats.push(format);
    let response: unknown;
    if (format === 'qa_deferred_semantic_poc_primary_v1') response = { kind: 'extraction', steps: primary };
    else if (format === 'qa_deferred_semantic_poc_fidelity_v1') {
      const review = JSON.parse(body.input);
      expect(review.originalInstruction).toBe(request.taskText);
      response = { verdict: 'faithful', issues: [] };
    } else if (format === 'agentic_native_option_verification_decision_v6') {
      const context = JSON.parse(body.input);
      const observation = context.observations[0];
      response = observation ? observation.status !== 'complete' ?
        { decisionVersion: '6', kind: 'conclude', conclusion: 'unresolved', comparison: null } :
        { decisionVersion: '6', kind: 'conclude',
          conclusion: observation.result.selected === context.goal.claim.expectedSelected ? 'satisfied' : 'unsatisfied',
          comparison: { comparisonVersion: '2', kind: 'native_owned_option_selected',
            observationId: observation.observationId, expectedSelected: context.goal.claim.expectedSelected } } :
        { decisionVersion: '6', kind: 'observe', request: { kind: 'native_owned_option_state',
          goalStepId: context.goal.id, admissionDigest: context.admissionDigest, claimDigest: context.claimDigest } };
    } else throw new Error(`Unexpected provider format: ${format}`);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ response }) }] }] }), { status: 200 });
  };

  const originalOpen = ProtectedContextFactory.prototype.open;
  const routed: string[] = [], denied: string[] = [], openedContexts: object[] = [],
    openedSessions: Awaited<ReturnType<typeof originalOpen>>[] = [], rootRequests: number[] = [];
  type DestinationSample = { url: string; readyState: string; selectCount: number;
    comboboxCount: number; generation: number; dclObserved: boolean };
  const scriptReleases = new Map<number, () => void>(), releaseRequested = new Set<number>();
  const destinationDcl = new Set<number>(), destinationGenerations = new Map<number, number>();
  const dclSamples = new Map<number, Promise<DestinationSample>>();
  const waitedAtDestination = new Set<number>();
  let clickReturnSample: Promise<DestinationSample> | undefined;
  const releaseScript = (ordinal: number): void => {
    const release = scriptReleases.get(ordinal);
    if (release) { scriptReleases.delete(ordinal); release(); }
    else releaseRequested.add(ordinal);
  };
  const sample = async (ordinal: number): Promise<DestinationSample> => {
    const page = openedSessions[ordinal - 1]!.context.pages()[0]!;
    const state = await page.evaluate(() => ({ readyState: document.readyState,
      selectCount: document.querySelectorAll('select').length }));
    return { url: page.url(), ...state, comboboxCount: await page.getByRole('combobox').count(),
      generation: destinationGenerations.get(ordinal) ?? 0, dclObserved: destinationDcl.has(ordinal) };
  };
  const originalProbe = DeferredDocumentReadinessTracker.prototype.probe;
  const originalWait = CommittedDocumentReadiness.prototype.wait;
  if (mode === 'delayed_destination_dcl') {
    DeferredDocumentReadinessTracker.prototype.probe = function (...args) {
      originalProbe.apply(this, args);
      if (args[0] === 'after_click' && !clickReturnSample) {
        clickReturnSample = sample(1).finally(() => releaseScript(1));
      }
    };
    CommittedDocumentReadiness.prototype.wait = async function (...args) {
      const ordinal = openedSessions.findIndex(session => session === this.session) + 1;
      const pending = originalWait.apply(this, args);
      if (ordinal > 1 && args[0].url() === dropdownUrl) {
        queueMicrotask(() => releaseScript(ordinal));
      }
      const result = await pending;
      if (ordinal > 1 && args[0].url() === dropdownUrl && result.waitRequired)
        waitedAtDestination.add(ordinal);
      return result;
    };
  }
  let runnerDrifts = 0;
  ProtectedContextFactory.prototype.open = async function (...args) {
    const browser = await originalOpen.apply(this, args);
    openedSessions.push(browser);
    const ordinal = openedContexts.push(browser.context);
    rootRequests.push(0);
    if (mode === 'delayed_destination_dcl') browser.context.on('page', page => {
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) destinationGenerations.set(ordinal,
          (destinationGenerations.get(ordinal) ?? 0) + 1);
      });
      page.on('domcontentloaded', () => {
        if (page.url() !== dropdownUrl) return;
        destinationDcl.add(ordinal);
        dclSamples.set(ordinal, sample(ordinal));
      });
    });
    if (failFrameCapture && ordinal === 1)
      browser.context.newCDPSession = async () => { throw new Error('Fixture: observational frame capture unavailable'); };
    if (transientFrameTimeouts && ordinal === 1) {
      const originalNewCDPSession = browser.context.newCDPSession.bind(browser.context);
      let attempts = 0;
      browser.context.newCDPSession = async page => {
        if (++attempts > transientFrameTimeouts) return originalNewCDPSession(page);
        return { send: async (method: string) => method === 'Page.getLayoutMetrics' ? {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
        } : new Promise<never>(() => undefined), detach: async () => undefined } as
          Awaited<ReturnType<typeof browser.context.newCDPSession>>;
      };
    }
    if (slowCandidateRead && ordinal === 1)
      browser.context.on('page', page => page.on('framenavigated', frame => {
        if (frame !== page.mainFrame() || frame.url() !== dropdownUrl) return;
        const original = frame.content.bind(frame);
        let delayed = false;
        frame.content = async () => {
          if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 2200)); }
          return original();
        };
      }));
    if (mode === 'next_observation_unavailable' && ordinal === 1 ||
        mode === 'compiler_url_snapshot_unavailable' && ordinal === 2 ||
        mode === 'runner_url_snapshot_unavailable' && ordinal >= 3)
      browser.context.on('page', (page) => page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && frame.url() === dropdownUrl)
          frame.content = async () => { throw new Error('Fixture: next protected observation unavailable'); };
      }));
    if ((mode === 'runner_no_page' || mode === 'runner_closed_page') && ordinal >= 3)
      browser.context.on('page', (page) => page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || frame.url() !== dropdownUrl) return;
        if (mode === 'runner_no_page') browser.context.pages = () => [];
        else page.isClosed = () => true;
      }));
    if (mode === 'runner_unrelated_drift' && ordinal >= 3)
      browser.context.on('page', (page) => page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || frame.url() !== dropdownUrl) return;
        const content = frame.content.bind(frame); let drifted = false;
        frame.content = async () => {
          const snapshot = await content();
          if (!drifted) {
            drifted = true;
            await page.evaluate(() => { document.body.appendChild(document.createElement('aside')); });
            runnerDrifts++;
          }
          return snapshot;
        };
      }));
    if (mode === 'runner_state_read_timeout' && ordinal >= 3)
      browser.context.on('page', page => page.on('framenavigated', frame => {
        if (frame !== page.mainFrame() || frame.url() !== dropdownUrl) return;
        const originalLocator = frame.locator.bind(frame);
        frame.locator = ((selector: string) => {
          const locator = originalLocator(selector);
          if (selector !== 'body') return locator;
          const originalNested = locator.locator.bind(locator);
          locator.locator = ((nested: string) => {
            const value = originalNested(nested);
            if (nested === 'runner_v9_state=') value.textContent = async () => {
              await new Promise(resolve => setTimeout(resolve, 3_050));
              const error = new Error('locator.textContent: Timeout 3000ms exceeded; private body text');
              error.name = 'TimeoutError'; throw error;
            };
            return value;
          }) as typeof locator.locator;
          return locator;
        }) as typeof frame.locator;
      }));
    await browser.context.route('**/*', async (route) => {
      const url = route.request().url();
      routed.push(url);
      if (route.request().method() !== 'GET') { denied.push(url); await route.abort('blockedbyclient'); return; }
      const disagreement = mode === 'replay_disagreement' && ordinal === 4;
      if (url === rootUrl) {
        rootRequests[ordinal - 1]!++;
        if(mode === 'redirect_initial' && rootRequests[ordinal - 1] === 1){
          await route.fulfill({status:302,headers:{location:`${rootUrl}bounce`},body:''});return;
        }
        const href = mode === 'wrong_url' || disagreement ? '/wrong' : '/dropdown';
        const links = `<a href="${href}">Dropdown</a>`;
        const runner = ordinal >= 3;
        const body = runner && mode === 'delayed_target' ?
          `<script>setTimeout(() => document.body.innerHTML = ${JSON.stringify(links)}, 350)</script>` :
          runner && mode === 'missing_target' ? '<main></main>' :
          runner && mode === 'delayed_load' ? links + '<img src="/slow-resource">' : links;
        await route.fulfill({ status: 200, contentType: 'text/html',
          body: mode === 'duplicate_links' ? links + links : body });
      } else if (url === `${rootUrl}start` || url === `${rootUrl}bounce`) {
        await route.fulfill({ status: 200,contentType:'text/html',body:'' });
      } else if (url === `${rootUrl}slow-resource`) {
        await new Promise(resolve=>setTimeout(resolve,1500));
        await route.fulfill({ status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgo=', 'base64') }).catch(()=>{});
      } else if (url === `${rootUrl}blocking-script`) {
        if (!releaseRequested.delete(ordinal))
          await new Promise<void>(resolve => scriptReleases.set(ordinal, resolve));
        await route.fulfill({ status:200,contentType:'text/javascript',body:'' }).catch(()=>{});
      } else if (url === dropdownUrl || url === wrongUrl) {
        const runner = ordinal >= 3;
        const options = mode === 'missing_option' || runner && mode === 'runner_missing_option' ?
          '<select><option>Option 2</option></select>' : runner && mode === 'runner_changed_option' ?
          optionMarkup.replace('value="1"', 'value="changed"') : optionMarkup;
        await route.fulfill({ status: 200, contentType: 'text/html',
          body: runner && mode === 'runner_missing_select' ? '<main></main>' :
            runner && mode === 'runner_frame_drift' ? `<iframe title="Other" srcdoc='${options}'></iframe>` :
            mode === 'duplicate_selects' || runner && mode === 'runner_duplicate_selects' ? options + options :
            mode === 'delayed_destination_dcl' ? '<script src="/blocking-script"></script>' + options : options });
      } else { denied.push(url); await route.abort('blockedbyclient'); }
    });
    return browser;
  };
  const oldGate = process.env[gate]; process.env[gate] = 'offline-review';
  const oldBackend = process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
  if (localWindows) process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = 'local-windows';
  else delete process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
  return {
    artifactRoot, config, request, providerFormats, routed, denied, openedContexts, openedSessions, rootRequests,
    runnerDrifts: () => runnerDrifts,
    delayedDestination: () => ({ clickReturnSample, dclSamples, waitedAtDestination }),
    run: () => runAgenticSubprocessAdapterV2(Readable.from([JSON.stringify({ protocolVersion: '2', request })]),
      async () => config, { provider: { apiKey: () => 'MOCK_ONLY', fetchImpl } },
      { workflowVersion: 'deferred-action-v1' }),
    close: async () => {
      for (const ordinal of scriptReleases.keys()) releaseScript(ordinal);
      DeferredDocumentReadinessTracker.prototype.probe = originalProbe;
      CommittedDocumentReadiness.prototype.wait = originalWait;
      ProtectedContextFactory.prototype.open = originalOpen;
      if (oldGate === undefined) delete process.env[gate]; else process.env[gate] = oldGate;
      if (oldBackend === undefined) delete process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
      else process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = oldBackend;
      await rm(artifactRoot, { recursive: true, force: true });
    },
  };
}

async function withoutDocker<T>(run: () => Promise<T>): Promise<T> {
  const original = IsolatedBrowser.open;
  IsolatedBrowser.open = async () => { throw new Error('Docker path reached'); };
  try { return await run(); }
  finally { IsolatedBrowser.open = original; }
}

test('local-windows MCP controls the owned context with navigate, snapshot and query', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const f = await fixture('normal', false, true);
  try {
    await withoutDocker(async () => {
      const selected = selectActivePocBrowserProfile(parseTrustedLocalConfiguration(f.config), 'local-windows');
      const catalog = new ProfileCatalog(selected.config.profiles, selected.config.networkPolicies);
      const mcp = await McpExplorationSession.open(new ProtectedContextFactory(catalog),
        selected.reference, catalog.resolve(selected.reference));
      try {
        await mcp.navigate(rootUrl);
        expect(await mcp.snapshot()).toContain('Dropdown');
        expect(await mcp.find('Dropdown')).toContain('Dropdown');
        expect(mcp.browserSession.context.pages()).toHaveLength(1);
      } finally { await mcp.close(); }
    });
    expect(f.openedSessions).toHaveLength(1);
    expect(f.openedSessions[0]!.context.browser()?.isConnected()).toBe(false);
  } finally { await f.close(); }
});

test('local-windows trusted selection completes five-step production QA with four owned browsers and no Docker', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const f = await fixture('normal', false, true);
  try {
    await withoutDocker(async () => {
      const selected = selectActivePocBrowserProfile(parseTrustedLocalConfiguration(f.config), 'local-windows');
      expect(selected.reference).toEqual(f.request.executionProfileRef);
      expect(selected.config.profiles.at(-1)).toMatchObject({ profileSchemaVersion: '5',
        browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows' });
      expect(selected.fingerprint).not.toBe(new ProfileCatalog(f.config.profiles, f.config.networkPolicies)
        .resolve({ id: 'desktop', version: '1' }).fingerprint);
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error(`Bridge error: ${response.code}`);
      const result = response.context.result;
      expect(result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
      expect(result.cleanup).toBe('verified');
      expect(result.executionProfileRef).toEqual(selected.reference);
      expect(result.profileFingerprint).toBe(selected.fingerprint);
      expect(result.executionRunIds).toHaveLength(2);
      expect(f.denied).toEqual([]);
      expect(new Set(f.routed)).toEqual(new Set([rootUrl, dropdownUrl]));
      expect(f.openedSessions).toHaveLength(4);
      expect(new Set(f.openedContexts).size).toBe(4);
      const browsers = f.openedSessions.map(session => session.context.browser());
      expect(new Set(browsers).size).toBe(4);
      for (const session of f.openedSessions) {
        expect(session.isClosed).toBe(true);
        expect(session.context.browser()?.isConnected()).toBe(false);
        expect(session.isolationContainerId).toBeUndefined();
        await expect(session.context.newPage()).rejects.toThrow();
      }
      expect(f.providerFormats).toEqual([
        'qa_deferred_semantic_poc_primary_v1', 'qa_deferred_semantic_poc_fidelity_v1']);
      const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
        .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
      expect(trace.protectedArtifact().trace.traceVersion).toBe('5');
      const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
        .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
      expect(compiler.protectedArtifact().compiler.compilerVersion).toBe('4');
      expect(compiler.protectedArtifact().resolved?.schemaVersion).toBe('9');
      const pair = await new DeferredReplayV9Store(f.artifactRoot)
        .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
      const replay = requireTrustedDeferredReplayReadbackV1(pair).record;
      expect(replay.agreement).toBe('agreed');
      expect(replay.runs.map(run => run.result)).toEqual([
        { kind: 'completed', passed: true, assertions: 2 },
        { kind: 'completed', passed: true, assertions: 2 },
      ]);
      expect(replay.runs.map(run => run.cleanup)).toEqual(['verified', 'verified']);
      const diagnostics = await new DeferredWorkflowStopStoreV1(f.artifactRoot).readBrowserDiagnostics(result.testSpecId);
      const bootstrapEvents = diagnostics.filter(event => event.source === 'grounding' &&
        event.ownerId === result.explorationAttemptId && event.operation === 'main_document_navigation' &&
        event.currentUrl === rootUrl);
      const rootStart = bootstrapEvents.find(event => event.outcome === 'started');
      const rootCommit = bootstrapEvents.find(event => event.outcome === 'success' && event.navigationCommitted);
      const rootResponse = diagnostics.find(event => event.source === 'grounding' &&
        event.ownerId === result.explorationAttemptId && event.operation === 'main_document_response' &&
        event.currentUrl === rootUrl && event.mainResponseStatusClass === '2xx');
      const firstCandidate = diagnostics.find(event => event.source === 'grounding' &&
        event.ownerId === result.explorationAttemptId && event.operation === 'candidate_enumeration' &&
        event.stepId === 's2');
      const rootQuery = diagnostics.find(event => event.source === 'grounding' &&
        event.ownerId === result.explorationAttemptId && event.operation === 'document_readiness' &&
        event.readinessBoundary === 'before_candidate_query' && event.stepId === 's2' && event.outcome === 'success');
      expect(rootStart).toMatchObject({ pageId: rootCommit?.pageId, mainFrameId: rootCommit?.mainFrameId });
      expect(rootCommit).toMatchObject({ documentGenerationId: rootStart?.documentGenerationId,
        navigationCommitted: true });
      expect(rootResponse).toMatchObject({ documentGenerationId: rootCommit?.documentGenerationId });
      expect(rootQuery).toMatchObject({ documentGenerationId: rootCommit?.documentGenerationId,
        pageId: rootCommit?.pageId, mainFrameId: rootCommit?.mainFrameId,
        documentReadyState: 'complete', domContentLoadedObserved: true, loadObserved: true });
      expect(firstCandidate).toMatchObject({ documentGenerationId: rootCommit?.documentGenerationId,
        pageId: rootCommit?.pageId, mainFrameId: rootCommit?.mainFrameId });
      const readiness = diagnostics.filter(event => event.source === 'grounding' &&
        event.operation === 'document_readiness' && event.outcome !== 'started' &&
        event.ownerId === result.explorationAttemptId);
      expect(readiness.map(event => event.readinessBoundary)).toEqual(expect.arrayContaining([
        'before_click', 'after_click', 'url_observation', 'before_candidate_query']));
      const urlRead = readiness.filter(event => event.readinessBoundary === 'url_observation').at(-1);
      const candidateRead = readiness.find(event => event.readinessBoundary === 'before_candidate_query' && event.stepId === 's4');
      expect(candidateRead).toMatchObject({ documentReplacedSinceUrlObservation: false,
        documentGenerationId: urlRead?.documentGenerationId, mainResponseStatusClass: '2xx' });
      const inventory = diagnostics.find(event => event.source === 'grounding' && event.stepId === 's4' &&
        event.operation === 'native_select_inventory');
      expect(inventory).toMatchObject({ documentGenerationId: candidateRead?.documentGenerationId,
        nativeSelectCount: 1, visibleNativeSelectCount: 1, enabledNativeSelectCount: 1 });
      expect(JSON.stringify(response.context.result)).not.toContain('documentGenerationId');
      for (const run of replay.runs) {
        const owner = diagnostics.filter(event => event.source === 'runner' && event.ownerId === run.executionRunId);
        expect(owner.some(event => event.operation === 'pre_action_ownership' && event.outcome === 'success')).toBe(true);
        expect(owner.some(event => event.operation === 'rich_after_url' && event.outcome === 'success')).toBe(true);
        expect(owner.some(event => event.operation === 'frame_content' && event.outcome === 'success')).toBe(true);
        expect(owner.some(event => event.operation === 'runner_v9_state' && event.outcome === 'success')).toBe(true);
        expect(owner.some(event => event.operation === 'execution_entry_ownership' && event.outcome === 'success')).toBe(true);
      }
    });
  } finally { await f.close(); }
});

test('local-windows five-step closure survives a delayed destination DOMContentLoaded without live view', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const f = await fixture('delayed_destination_dcl', false, true);
  try {
    await withoutDocker(async () => {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error(`Bridge error: ${response.code}`);
      expect(response.context.result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
      expect(response.context.result.cleanup).toBe('verified');
      expect(response.context.result.executionRunIds).toHaveLength(2);
      expect(f.denied).toEqual([]);
      const delayed = f.delayedDestination();
      expect(delayed.clickReturnSample).toBeDefined();
      const immediate = await delayed.clickReturnSample!;
      expect(immediate).toMatchObject({ url: dropdownUrl, readyState: 'loading',
        selectCount: 0, comboboxCount: 0, dclObserved: false });
      expect(immediate.generation).toBeGreaterThan(0);
      expect(delayed.dclSamples.size).toBe(4);
      for (const [ordinal, pending] of delayed.dclSamples) {
        const afterDcl = await pending;
        expect(afterDcl, `owner ${ordinal}`).toMatchObject({ url: dropdownUrl,
          selectCount: 1, comboboxCount: 1, dclObserved: true });
        if (ordinal === 1) expect(afterDcl.generation).toBe(immediate.generation);
      }
      expect([...delayed.waitedAtDestination].sort()).toEqual([2, 3, 4]);
    });
  } finally { await f.close(); }
});

test('local-windows live frames follow all four owners without changing five-step QA or cleanup', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  test.setTimeout(180_000);
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const notices: DeferredFrameNotice[] = [];
  let wireError: unknown;
  let finishWire!: () => void;
  const wireEnded = new Promise<void>(resolve => { finishWire = resolve; });
  const wireSockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    wireSockets.add(socket);
    let pending = '', greeted = false;
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!greeted) {
            expect(value).toEqual({ deferredViewerVersion: '1', kind: 'hello', streamId, capability });
            greeted = true;
            socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
          } else notices.push(DeferredFrameNoticeSchema.parse(value));
        } catch (error) { wireError = error; socket.destroy(); }
      }
    });
    socket.on('close', () => { wireSockets.delete(socket); finishWire(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No viewer loopback listener');
  const envKeys = ['PLAYWRIGHT_DEMO_LIVE_VIEW', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT',
    'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY'] as const;
  const oldEnv = envKeys.map(key => process.env[key]);
  process.env[envKeys[0]] = '1'; process.env[envKeys[1]] = String(address.port);
  process.env[envKeys[2]] = streamId; process.env[envKeys[3]] = capability;
  const f = await fixture('normal', false, true, false, true);
  try {
    await withoutDocker(async () => {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error(`Live-view bridge error: ${response.code}`);
      await Promise.race([wireEnded, new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Frame viewer channel did not close')), 5000))]);
      if (wireError) throw wireError;
      const result = response.context.result;
      expect(result.terminal.status, JSON.stringify(result)).toBe('QA_ASSERTION_PASSED');
      expect(result.cleanup).toBe('verified');
      expect(result.executionRunIds).toHaveLength(2);
      expect(new Set(f.openedContexts).size).toBe(4);
      expect(f.openedSessions.every(session => session.context.browser()?.isConnected() === false)).toBe(true);
      const phases = ['exploration', 'compilation', 'replay_1', 'replay_2'];
      const owners = [result.explorationAttemptId, result.compilerAttemptId, ...result.executionRunIds];
      expect(notices.filter(notice => notice.kind === 'ready').map(notice => notice.phase)).toEqual(phases);
      expect(notices.filter(notice => notice.kind === 'ready').map(notice => notice.ownerId)).toEqual(owners);
      expect(notices.filter(notice => notice.kind === 'closed').map(notice => notice.phase)).toEqual(phases);
      expect(notices.filter(notice => notice.kind === 'transition').map(notice => notice.phase)).toEqual(phases.slice(0, 3));
      expect(notices.some(notice => notice.kind === 'frame')).toBe(true);
      expect(notices.filter(notice => notice.kind === 'frame').every(notice =>
        owners[phases.indexOf(notice.phase)] === notice.ownerId)).toBe(true);
      expect(notices.every(notice => !('port' in notice) && !('path' in notice))).toBe(true);
      expect(notices.some(notice => notice.kind === 'unavailable')).toBe(false);
      expect(JSON.stringify(result)).not.toContain('imageBase64');
      expect(JSON.stringify(result)).not.toContain('frame_stream');
      const diagnostics = await new DeferredWorkflowStopStoreV1(f.artifactRoot)
        .readBrowserDiagnostics(result.testSpecId);
      for (const phase of phases) {
        const ready = diagnostics.find(item => item.source === 'viewer' && item.phase === phase &&
          item.operation === 'ready');
        const closed = diagnostics.find(item => item.source === 'viewer' && item.phase === phase &&
          item.operation === 'closed');
        if (ready && closed && closed.endedAtMs - ready.startedAtMs >= 5_000)
          expect(notices.some(notice => notice.kind === 'frame' && notice.phase === phase)).toBe(true);
      }
      const captures = diagnostics.filter(item => item.source === 'viewer' && item.phase === 'exploration' &&
        item.operation === 'capture' && item.outcome === 'success');
      const selectRead = diagnostics.find(item => item.source === 'grounding' && item.stepId === 's4' &&
        item.operation === 'initial_state');
      expect(captures.length).toBeGreaterThanOrEqual(2);
      expect(selectRead).toBeDefined();
      expect(captures.some(item => item.startedAtMs < selectRead!.endedAtMs &&
        item.endedAtMs > selectRead!.startedAtMs)).toBe(true);
      for (const runId of result.executionRunIds) {
        const runner = diagnostics.filter(item => item.source === 'runner' && item.ownerId === runId);
        const viewer = diagnostics.filter(item => item.source === 'viewer' && item.ownerId === runId);
        expect(runner.some(item => item.operation === 'rich_after_url' && item.outcome === 'success')).toBe(true);
        expect(viewer.some(item => item.operation === 'ready')).toBe(true);
        expect(runner.every(item => Number.isFinite(item.startedAtMs) && Number.isFinite(item.endedAtMs))).toBe(true);
      }
      expect(diagnostics.every(item => item.ownerId === result.explorationAttemptId ||
        item.ownerId === result.compilerAttemptId || result.executionRunIds.includes(item.ownerId!))).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain('imageBase64');
      expect(JSON.stringify(diagnostics)).not.toContain('<select>');
      const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
        .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
      const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
        .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
      const pair = await new DeferredReplayV9Store(f.artifactRoot)
        .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
      expect(requireTrustedDeferredReplayReadbackV1(pair).record.agreement).toBe('agreed');
    });
  } finally {
    await f.close();
    envKeys.forEach((key, index) => { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index]; });
    wireSockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const failure of ['permanent', 'transient'] as const) test(`local-windows ${failure} frame capture loss leaves five-step QA authoritative`, async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  test.setTimeout(180_000);
  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const notices: DeferredFrameNotice[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let pending = '', greeted = false;
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const value: unknown = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (!greeted) {
          greeted = true;
          socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
        } else notices.push(DeferredFrameNoticeSchema.parse(value));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No viewer loopback listener');
  const envKeys = ['PLAYWRIGHT_DEMO_LIVE_VIEW', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT',
    'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY'] as const;
  const oldEnv = envKeys.map(key => process.env[key]);
  process.env[envKeys[0]] = '1'; process.env[envKeys[1]] = String(address.port);
  process.env[envKeys[2]] = streamId; process.env[envKeys[3]] = capability;
  const f = await fixture('normal', false, true, failure === 'permanent',
    failure === 'transient', failure === 'transient' ? 2 : 0);
  try {
    await withoutDocker(async () => {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error(`Live-view bridge error: ${response.code}`);
      expect(response.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');
      expect(response.context.result.cleanup).toBe('verified');
      expect(f.openedSessions).toHaveLength(4);
      expect(f.openedSessions.every(session => session.context.browser()?.isConnected() === false)).toBe(true);
      expect(notices.some(notice => notice.kind === 'unavailable' && notice.phase === 'exploration'))
        .toBe(failure === 'permanent');
      const diagnostics = await new DeferredWorkflowStopStoreV1(f.artifactRoot)
        .readBrowserDiagnostics(response.context.result.testSpecId);
      if (failure === 'permanent') expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'viewer', phase: 'exploration', operation: 'capture', outcome: 'failure' }),
        expect.objectContaining({ source: 'viewer', phase: 'exploration', operation: 'unavailable', outcome: 'success' }),
      ]));
      else expect(diagnostics.filter(item => item.source === 'viewer' && item.phase === 'exploration' &&
        (item.operation === 'capture_timeout' || item.operation === 'capture' && item.outcome === 'skipped')).length)
        .toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(response.context.result)).not.toContain('diagnostics');
    });
  } finally {
    await f.close();
    envKeys.forEach((key, index) => { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index]; });
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('local-windows rejects profile mismatch and missing trusted viewer channel before browser or Docker launch', async () => {
  const f = await fixture('normal', false, true);
  const oldView = process.env.PLAYWRIGHT_DEMO_LIVE_VIEW;
  try {
    await withoutDocker(async () => {
      f.request.executionProfileRef = { id: 'desktop', version: '1' };
      expect(await f.run()).toMatchObject({ kind: 'bridge_error', code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
      expect(f.openedSessions).toHaveLength(0);
      f.request.executionProfileRef = selectActivePocBrowserProfile(
        parseTrustedLocalConfiguration(f.config), 'local-windows').reference;
      delete process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
      expect(await f.run()).toMatchObject({ kind: 'bridge_error', code: 'PROFILE_UNAVAILABLE', cleanup: 'not_started' });
      process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND = 'local-windows';
      process.env.PLAYWRIGHT_DEMO_LIVE_VIEW = '1';
      expect(await f.run()).toMatchObject({ kind: 'bridge_error', code: 'INVALID_TRUSTED_CONFIGURATION', cleanup: 'not_started' });
      expect(f.openedSessions).toHaveLength(0);
    });
  } finally {
    if (oldView === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_VIEW;
    else process.env.PLAYWRIGHT_DEMO_LIVE_VIEW = oldView;
    await f.close();
  }
});

test('absent backend selection retains the trusted Docker profile and fingerprint', async () => {
  const f = await fixture('normal', true);
  try {
    const config = parseTrustedLocalConfiguration(f.config);
    const selected = selectActivePocBrowserProfile(config, parseTrustedBrowserBackend(undefined));
    expect(selected.config).toBe(config);
    expect(selected.reference).toEqual({ id: 'desktop', version: '1' });
    expect(selected.fingerprint).toBe(new ProfileCatalog(config.profiles, config.networkPolicies)
      .resolve(selected.reference).fingerprint);
  } finally { await f.close(); }
});

test('local-windows ambiguous target remains non-QA and closes its browser', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const f = await fixture('duplicate_links', false, true);
  try {
    await withoutDocker(async () => {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error(`Bridge error: ${response.code}`);
      expect(response.context.result.terminal.stage).toBe('exploration');
      expect(response.context.result.deferredStage?.code).toBe('NON_UNIQUE');
      expect(response.context.result.cleanup).toBe('verified');
      expect(f.openedSessions).toHaveLength(1);
      expect(f.openedSessions[0]!.context.browser()?.isConnected()).toBe(false);
    });
  } finally { await f.close(); }
});

test('exact five-line PoC reaches trace v5, compiler v4, two model-free v9 replays and authoritative QA pass', async () => {
  const f = await fixture('normal');
  try {
    expect(f.request.taskText).toBe(authoredTask);
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    expect(response.context.result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
    expect(JSON.stringify(response)).not.toContain('observationAttempts');
    expect(response.context.result.cleanup).toBe('verified');
    expect(response.context.result.executionRunIds).toHaveLength(2);
    expect(f.denied).toEqual([]);
    expect(new Set(f.routed)).toEqual(new Set([rootUrl, dropdownUrl]));
    expect(new Set(f.openedContexts).size).toBe(4);
    expect(f.rootRequests).toEqual([1,1,1,1]);
    expect(f.providerFormats.slice(0, 2)).toEqual([
      'qa_deferred_semantic_poc_primary_v1', 'qa_deferred_semantic_poc_fidelity_v1']);
    expect(new Set(f.providerFormats)).toEqual(new Set([
      'qa_deferred_semantic_poc_primary_v1', 'qa_deferred_semantic_poc_fidelity_v1']));
    const result = response.context.result;
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const artifact = trace.protectedArtifact().trace;
    expect(artifact.source.semanticMode).toBe('poc_v1');
    expect(artifact.source.sourceInstruction).toBe(authoredTask);
    expect(artifact.source.steps.map((step) => step.type)).toEqual([
      'navigate', 'action_goal', 'verification_goal', 'action_goal', 'verification_goal']);
    expect(artifact.successfulPath[0]).toMatchObject({type:'navigate',bootstrapAdopted:true});
    const linkSource = artifact.source.steps[1]!;
    expect(linkSource.type === 'action_goal' ? linkSource.obligations : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'constraint', constraint: 'role', authoredText: 'link' }),
      expect.objectContaining({ kind: 'constraint', constraint: 'name', authoredText: 'Dropdown' }),
    ]));
    expect(artifact.source.steps[2]).toMatchObject({ dependsOnStepId: 's2' });
    const selectSource = artifact.source.steps[3]!;
    expect(selectSource.type === 'action_goal' ? selectSource.obligations : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'constraint', constraint: 'role', authoredText: 'dropdown' }),
      expect.objectContaining({ kind: 'argument', purpose: 'choice', authoredText: 'Option 1' }),
    ]));
    expect(artifact.source.steps[4]).toMatchObject({ dependsOnStepId: 's4',
      claim: { kind: 'native_owned_option_selected', optionLabel: 'Option 1', expectedSelected: true,
        controlConstraints: [] } });
    const link = artifact.successfulPath.find((step) => step.type === 'action_goal' && step.originStepId === 's2');
    expect(link?.type === 'action_goal' ? link.witness.postEffect.effect : undefined)
      .toMatchObject({ kind: 'generic_activation', role: 'link', accessibleName: 'Dropdown',
        delivery: { stepId: 's2', clicks: 1, targetOwned: true, dispatched: true, returned: true,
          elapsedMs: expect.any(Number) } });
    if (link?.type !== 'action_goal') throw new Error('Missing generic click');
    expect(link.witness.postEffect.after).toBeUndefined();
    expect(link.retirement).toBeUndefined();
    const urlRecord = artifact.successfulPath[2];
    if (urlRecord?.type !== 'verification_goal') throw new Error('Missing URL verification');
    expect(link.continuation && 'observationId' in link.continuation ? link.continuation.observationId : undefined)
      .toBe(urlRecord.observationIds[0]);
    expect(link.continuation?.after.stateDigest).toBe(urlRecord.preStateDigest);
    expect(link.continuation?.after.stateDigest).not.toBe(link.witness.postEffect.before.stateDigest);
    const selection = artifact.successfulPath.find((step) => step.type === 'action_goal' && step.originStepId === 's4');
    if (selection?.type !== 'action_goal') throw new Error('Missing selection action');
    expect(selection.stateRefresh).toMatchObject({fromObservationId:urlRecord.observationIds[0],
      after:expect.objectContaining({pageId:urlRecord.observations[0]!.pageId,
        stateEpoch:expect.any(Number)})});
    const changed = structuredClone(artifact);
    const changedSelection = changed.successfulPath[3];
    if (changedSelection?.type !== 'action_goal' || !changedSelection.stateRefresh)
      throw new Error('Missing URL state refresh');
    changedSelection.stateRefresh.after.pageId = 'unrelated-page';
    const {traceDigest:_changedDigest,...changedData}=changed;
    changed.traceDigest=successfulTraceDigestV5(changedData);
    expect(()=>parseProtectedTraceCaptureBundleV5(trace.protectedArtifact().capture,changed)).toThrow();
    expect(selection?.type === 'action_goal' ? selection.witness.postEffect.effect : undefined)
      .toMatchObject({ kind: 'native_choice', value: '1' });
    const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
      .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
    expect(compiler.protectedArtifact().compiler.compilerVersion).toBe('4');
    expect(compiler.protectedArtifact().compiler.freshNavigations[0]).toMatchObject({bootstrapAdopted:true});
    const freshLink = compiler.protectedArtifact().compiler.freshActions.find((action) => action.traceRecordId === link.recordId);
    expect(freshLink?.retirement).toBeUndefined();
    expect(freshLink?.witness.postEffect.after).toBeUndefined();
    expect(compiler.protectedArtifact().resolved?.schemaVersion).toBe('9');
    expect(compiler.protectedArtifact().resolved?.executionSteps.find((step) => step.originStepId === 's3'))
      .toMatchObject({ type: 'verification_goal', assertion: { kind: 'url', operator: 'equal', expected: dropdownUrl } });
    const privateDiagnostics=await new DeferredWorkflowStopStoreV1(f.artifactRoot)
      .readVerificationDiagnostics(result.testSpecId,result.explorationAttemptId!,result.profileFingerprint);
    expect(privateDiagnostics.find((item)=>item.stepId==='s3')?.observationAttempts).toEqual([
      expect.objectContaining({stepId:'s3',strategy:'poc_resulting_url',observationKind:'current_url',
        outcome:'complete',selectedPageBefore:'open',selectedPageAfter:'open',
        currentUrlBefore:dropdownUrl,currentUrlAfter:dropdownUrl,elapsedMs:expect.any(Number)})]);
    expect(privateDiagnostics.find((item)=>item.stepId==='s5')?.observationAttempts).toEqual([
      expect.objectContaining({stepId:'s5',strategy:'native_owned_option',observationKind:'native_owned_option_state',outcome:'complete'})]);
    const pair = await new DeferredReplayV9Store(f.artifactRoot)
      .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
    const replay = requireTrustedDeferredReplayReadbackV1(pair).record;
    expect(replay.agreement).toBe('agreed');
    expect(replay.runs).toHaveLength(2);
    expect(new Set(replay.runs.map((run) => run.provenance?.sessionId)).size).toBe(2);
    for (const run of replay.runs) {
      expect(run.steps[0]).toMatchObject({type:'navigate',bootstrapAdopted:true});
      expect(run.result).toMatchObject({ kind: 'completed', passed: true, assertions: 2 });
      expect(run.cleanup).toBe('verified');
      expect(run.steps.filter((step) => step.type === 'verification_goal').map((step) => step.status))
        .toEqual(['assertion_passed', 'assertion_passed']);
      expect(run.steps.find((step) => step.originStepId === 's3'))
        .toMatchObject({ status: 'assertion_passed', verification: { actual: dropdownUrl, evaluated: true,
          assertion: { kind: 'url', expected: dropdownUrl } } });
      expect(run.steps.find((step) => step.originStepId === 's2'))
        .toMatchObject({ status: 'succeeded', afterStateStatus: 'unavailable', effect: { kind: 'generic_activation' } });
      const optionAction = run.steps.find((step) => step.originStepId === 's4')!;
      expect(optionAction.stateRefresh?.kind).toBe('rich_after_url');
      expect(optionAction.stateRefresh?.from.pageId).toBe(optionAction.before.pageId);
      expect(optionAction.before.stateEpoch).toBeGreaterThan(optionAction.stateRefresh!.from.stateEpoch);
      const drifted = structuredClone(run);
      const driftedAction = drifted.steps.find((step) => step.originStepId === 's4')!;
      driftedAction.before.pageId = 'different-page';
      const { recordDigest: _digest, ...data } = drifted;
      drifted.recordDigest = hash(data);
      expect(() => parseDeferredRunnerRecordV9(drifted)).toThrow('INVALID_RUN_STEP_V9');
    }
  } finally { await f.close(); }
});

for(const [mode,expected] of [['different_initial',[1,1,1,1]]] as const){
  test(`${mode} keeps required physical navigation transitions`,async()=>{
    const f=await fixture(mode);
    try{const response=await f.run();if(response.kind==='bridge_error')throw new Error('Bridge error');
      expect(response.context.result.terminal.status,JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
      expect(f.rootRequests).toEqual(expected);
      expect(f.routed.filter(url=>url===`${rootUrl}start`)).toHaveLength(4);
      expect(response.context.result.cleanup).toBe('verified');
    }finally{await f.close();}
  });
}

test('redirected bootstrap never adopts the authored navigation',async()=>{
  const f=await fixture('redirect_initial');
  try{const response=await f.run();if(response.kind==='bridge_error')throw new Error('Bridge error');
    expect(response.context.result.terminal.status).toBe('ENVIRONMENT_FAILED');
    expect(f.rootRequests).toEqual([1]);
    expect(response.context.result.cleanup).toBe('verified');
  }finally{await f.close();}
});

for(const mode of ['delayed_load','delayed_target'] as const){
  test(`${mode} continues after DOMContentLoaded with a fresh unique target`,async()=>{
    const f=await fixture(mode);
    try{const response=await f.run();if(response.kind==='bridge_error')throw new Error('Bridge error');
      expect(response.context.result.terminal.status,JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
      expect(f.rootRequests).toEqual([1,1,1,1]);
    }finally{await f.close();}
  });
}

test('missing post-DOMContentLoaded target remains a non-QA runner stop',async()=>{
  const f=await fixture('missing_target');
  try{const response=await f.run();if(response.kind==='bridge_error')throw new Error('Bridge error');
    expect(response.context.result.terminal.status).toBe('REPLAY_EXECUTION_FAILED');
    expect(response.context.result.cleanup).toBe('verified');
  }finally{await f.close();}
});

test('trusted live view follows the same four protected sessions and preserves five-step QA', async () => {
  test.setTimeout(180_000);
  const baseline = await fixture('normal', true);
  let baselineStatus: string;
  try {
    const response = await baseline.run();
    if (response.kind === 'bridge_error') throw new Error('Baseline bridge error');
    baselineStatus = response.context.result.terminal.status;
    expect(baselineStatus).toBe('QA_ASSERTION_PASSED');
  } finally { await baseline.close(); }

  const streamId = randomUUID(), capability = randomBytes(32).toString('hex');
  const notices: DeferredViewerNotice[] = [];
  let wireError: unknown;
  let finishWire!: () => void;
  const wireEnded = new Promise<void>(resolve => { finishWire = resolve; });
  const wireSockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    wireSockets.add(socket);
    let pending = '', greeted = false;
    socket.on('data', bytes => {
      pending += bytes.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!greeted) {
            expect(value).toEqual({ deferredViewerVersion: '1', kind: 'hello', streamId, capability });
            greeted = true;
            socket.write(JSON.stringify({ deferredViewerVersion: '1', kind: 'ready', streamId }) + '\n');
          } else notices.push(DeferredViewerNoticeSchema.parse(value));
        } catch (error) { wireError = error; socket.destroy(); }
      }
    });
    socket.on('close', () => { wireSockets.delete(socket); finishWire(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  const envKeys = ['PLAYWRIGHT_DEMO_LIVE_VIEW', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT',
    'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID', 'PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY'] as const;
  const oldEnv = envKeys.map(key => process.env[key]);
  process.env[envKeys[0]] = '1'; process.env[envKeys[1]] = String(address.port);
  process.env[envKeys[2]] = streamId; process.env[envKeys[3]] = capability;
  const live = await fixture('normal', true);
  try {
    const response = await live.run();
    if (response.kind === 'bridge_error') throw new Error(`Live-view bridge error: ${response.code}`);
    await Promise.race([wireEnded, new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Viewer channel did not close')), 5000))]);
    if (wireError) throw wireError;
    const result = response.context.result;
    expect(result.terminal.status, JSON.stringify({ result, notices })).toBe(baselineStatus);
    expect(result.cleanup).toBe('verified');
    expect(result.presentationMode).toBe('headless'); // Accepted profile mode; live rendering is view-only.
    expect(result.observation).toBe('unobserved');
    expect(result.executionRunIds).toHaveLength(2);
    const liveTrace=await new SuccessfulTraceV5Store(live.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId,result.explorationAttemptId!);
    const liveCompiler=await new DeferredCompilerV4Store(live.artifactRoot)
      .readResolvedV9(result.testSpecId,result.compilerAttemptId!,liveTrace);
    const livePair=await new DeferredReplayV9Store(live.artifactRoot)
      .readReplayV1(result.testSpecId,result.deferredReplay!.orchestrationId,liveCompiler);
    const liveReplay=requireTrustedDeferredReplayReadbackV1(livePair).record;
    expect(liveReplay.agreement).toBe('agreed');
    expect(liveReplay.runs).toHaveLength(2);
    expect(liveReplay.runs.every(run=>run.result.kind==='completed'&&run.result.passed)).toBe(true);
    expect(new Set(live.openedContexts).size).toBe(4);
    expect(live.denied).toEqual([]);
    const phases = ['exploration', 'compilation', 'replay_1', 'replay_2'];
    const expectedOwners = [result.explorationAttemptId, result.compilerAttemptId,
      ...result.executionRunIds];
    expect(notices.filter(n => n.kind === 'ready').map(n => n.phase)).toEqual(phases);
    expect(notices.filter(n => n.kind === 'ready').map(n => n.ownerId)).toEqual(expectedOwners);
    expect(notices.filter(n => n.kind === 'closed').map(n => n.phase)).toEqual(phases);
    expect(notices.filter(n => n.kind === 'transition').map(n => n.phase)).toEqual(phases.slice(0, 3));
    expect(notices.map(n => n.sequence)).toEqual(notices.map((_n, index) => index + 1));
    expect(new Set(notices.map(n => n.testSpecId))).toEqual(new Set([result.testSpecId]));
    expect(notices.some(n => n.kind === 'unavailable')).toBe(false);
  } finally {
    await live.close();
    envKeys.forEach((key, index) => { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index]; });
    wireSockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const mode of ['duplicate_links', 'duplicate_selects', 'missing_option'] as const) {
  test(`${mode} stops before authoritative QA`, async () => {
    const f = await fixture(mode);
    try {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error('Bridge error');
      expect(response.context.result.deferredStage?.code).toBe(mode === 'missing_option' ? 'OPTION_ABSENT' : 'NON_UNIQUE');
      expect(response.context.result.terminal.stage).toBe('exploration');
      expect(response.context.result.executionRunIds).toEqual([]);
      expect(response.context.result.cleanup).toBe('verified');
      expect(f.denied).toEqual([]);
    } finally { await f.close(); }
  });
}

test('wrong resulting URL becomes an agreeing QA assertion failure', async () => {
  const f = await fixture('wrong_url');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    expect(response.context.result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_FAILED');
    expect(response.context.result.executionRunIds).toHaveLength(2);
    expect(response.context.result.cleanup).toBe('verified');
    expect(f.denied).toEqual([]);
    const result = response.context.result;
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
      .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
    const pair = await new DeferredReplayV9Store(f.artifactRoot)
      .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
    const replay = requireTrustedDeferredReplayReadbackV1(pair).record;
    expect(replay.agreement).toBe('agreed');
    for (const run of replay.runs) {
      expect(run.result).toMatchObject({ kind: 'completed', passed: false, assertions: 2 });
      expect(run.steps.find((step) => step.originStepId === 's3'))
        .toMatchObject({ status: 'assertion_failed', verification: { actual: wrongUrl, evaluated: false,
          assertion: { kind: 'url', expected: dropdownUrl } } });
      expect(run.steps.find((step) => step.originStepId === 's5')).toMatchObject({ status: 'assertion_passed' });
    }
  } finally { await f.close(); }
});

test('URL verification succeeds without a document snapshot; later grounding still stops if the document is unavailable', async () => {
  const f = await fixture('next_observation_unavailable');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.stage).toBe('environment');
    expect(result.terminal.status).toBe('ENVIRONMENT_FAILED');
    expect(result.deferredStage?.stage).toBe('grounding');
    expect(result.executionRunIds).toEqual([]);
    expect(result.cleanup).toBe('verified');
    const privateAccounting=await new DeferredWorkflowStopStoreV1(f.artifactRoot).readPrivateAccounting(result.testSpecId);
    expect(privateAccounting.verificationDiagnostics?.find((item)=>item.stepId==='s3')?.observationAttempts).toEqual([
      expect.objectContaining({stepId:'s3',strategy:'poc_resulting_url',observationKind:'current_url',
        outcome:'complete',currentUrlBefore:dropdownUrl,currentUrlAfter:dropdownUrl})]);
    expect(privateAccounting.verificationDiagnostics?.find((item)=>item.stepId==='s3'))
      .toMatchObject({decision:'true',observed:dropdownUrl,comparisonAttempted:true});
    expect(JSON.stringify(response)).not.toContain('observationAttempts');
  } finally { await f.close(); }
});

test('fresh compiler URL verification succeeds without a document snapshot', async () => {
  const f = await fixture('compiler_url_snapshot_unavailable');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.status).toBe('ENVIRONMENT_FAILED');
    expect(result.deferredStage?.stage).toBe('compilation');
    expect(result.executionRunIds).toEqual([]);
    expect(result.cleanup).toBe('verified');
    const accounting = await new DeferredWorkflowStopStoreV1(f.artifactRoot)
      .readPrivateAccounting(result.testSpecId);
    expect(accounting.compilerAttempt?.verificationObservationDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({originStepId:'s3',assertionKind:'url',observationKind:'current_url',
        outcome:'complete',currentUrlBefore:dropdownUrl,currentUrlAfter:dropdownUrl})]));
    expect(accounting.compilerAttempt?.freshVerifications).toEqual(expect.arrayContaining([
      expect.objectContaining({observation:expect.objectContaining({status:'complete',
        result:{kind:'url',value:dropdownUrl,complete:true}})})]));
  } finally { await f.close(); }
});

test('runner URL assertion succeeds without a document snapshot; the next DOM action stops', async () => {
  const f = await fixture('runner_url_snapshot_unavailable');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.status, JSON.stringify(response)).toBe('ENVIRONMENT_FAILED');
    expect(result.cleanup).toBe('verified');
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
      .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
    const pair = await new DeferredReplayV9Store(f.artifactRoot)
      .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
    const replay = requireTrustedDeferredReplayReadbackV1(pair).record;
    expect(replay.runs).toHaveLength(1);
    for (const run of replay.runs) {
      expect(run.steps.find((step) => step.originStepId === 's3'))
        .toMatchObject({status:'assertion_passed',verification:{actual:dropdownUrl,evaluated:true}});
      expect(run.result).toMatchObject({kind:'non_qa_stop',failedStepId:expect.any(String)});
    }
  } finally { await f.close(); }
});

test('local-windows delayed runner-v9 state read remains non-QA and identifies the exact timeout', async () => {
  test.skip(process.platform !== 'win32', 'Windows process boundary');
  const f = await fixture('runner_state_read_timeout', false, true);
  try {
    await withoutDocker(async () => {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error('Bridge error');
      const result = response.context.result;
      expect(result.terminal.status).toBe('ENVIRONMENT_FAILED');
      expect(result.cleanup).toBe('verified');
      const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
        .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
      const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
        .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
      const pair = await new DeferredReplayV9Store(f.artifactRoot)
        .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
      const run = requireTrustedDeferredReplayReadbackV1(pair).record.runs[0]!;
      expect(run.result).toMatchObject({ kind: 'non_qa_stop', reasonCode: 'ENVIRONMENT_FAILURE' });
      expect(run.steps.find(step => step.originStepId === 's3')?.status).toBe('assertion_passed');
      expect(run.steps.find(step => step.originStepId === 's4')).toBeUndefined();
      const diagnostics = await new DeferredWorkflowStopStoreV1(f.artifactRoot).readBrowserDiagnostics(result.testSpecId);
      const owner = diagnostics.filter(event => event.source === 'runner' && event.ownerId === run.executionRunId);
      expect(owner.some(event => event.operation === 'pre_action_ownership' && event.outcome === 'success')).toBe(true);
      expect(owner.some(event => event.operation === 'frame_content' && event.outcome === 'success' &&
        event.currentUrl === dropdownUrl)).toBe(true);
      expect(owner).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'runner_v9_state', outcome: 'failure',
          runnerExceptionCategory: 'PLAYWRIGHT_TIMEOUT', playwrightTimeout: true }),
        expect.objectContaining({ operation: 'rich_after_url', outcome: 'failure',
          runnerExceptionCategory: 'PLAYWRIGHT_TIMEOUT' }),
      ]));
      expect(JSON.stringify(owner)).not.toContain('private body text');
    });
  } finally { await f.close(); }
});

test('poc replay freshly binds the select after unrelated page digest drift', async () => {
  const f = await fixture('runner_unrelated_drift');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
    expect(f.runnerDrifts()).toBe(2);
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const compiled = await new DeferredCompilerV4Store(f.artifactRoot)
      .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
    const pair = await new DeferredReplayV9Store(f.artifactRoot)
      .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiled);
    const replays = requireTrustedDeferredReplayReadbackV1(pair).record.runs;
    expect(replays).toHaveLength(2);
    for (const replay of replays) {
      expect(replay.result).toEqual({kind:'completed',assertions:2,passed:true});
      expect(replay.steps.find(step => step.originStepId === 's3')?.status).toBe('assertion_passed');
      expect(replay.steps.find(step => step.originStepId === 's4')).toMatchObject({
        status:'succeeded',invocation:'returned',effect:{kind:'native_choice',label:'Option 1',value:'1'},
      });
    }
  } finally { await f.close(); }
});

for (const [mode, reason] of [
  ['runner_missing_select', 'TARGET_MISMATCH'],
  ['runner_duplicate_selects', 'NON_UNIQUE_MATCH'],
  ['runner_missing_option', 'OPTION_MAPPING_MISMATCH'],
  ['runner_changed_option', 'OPTION_MAPPING_MISMATCH'],
  ['runner_frame_drift', 'FRAME_MISMATCH'],
] as const) test(`${mode} stops on fresh target proof after the URL assertion`, async () => {
  const f = await fixture(mode);
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.status, JSON.stringify(response)).toBe('REPLAY_EXECUTION_FAILED');
    expect(result.cleanup).toBe('verified');
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const compiled = await new DeferredCompilerV4Store(f.artifactRoot)
      .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
    const pair = await new DeferredReplayV9Store(f.artifactRoot)
      .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiled);
    const replays = requireTrustedDeferredReplayReadbackV1(pair).record.runs;
    expect(replays).toHaveLength(1);
    expect(replays[0]!.steps.find(step => step.originStepId === 's3')?.status).toBe('assertion_passed');
    expect(replays[0]!.steps.find(step => step.originStepId === 's4')).toMatchObject({
      status:'stopped',invocation:'not_invoked',reasonCode:reason,
    });
    expect(replays[0]!.result).toMatchObject({kind:'non_qa_stop',reasonCode:reason});
  } finally { await f.close(); }
});

for (const mode of ['runner_no_page', 'runner_closed_page'] as const) {
  test(`${mode} remains a non-QA replay environment stop`, async () => {
    const f = await fixture(mode);
    try {
      const response = await f.run();
      if (response.kind === 'bridge_error') throw new Error('Bridge error');
      const result = response.context.result;
      expect(result.terminal.status, JSON.stringify(response)).toBe('ENVIRONMENT_FAILED');
      expect(result.cleanup).toBe('verified');
      expect(result.executionRunIds).toHaveLength(1);
      const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
        .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
      const compiler = await new DeferredCompilerV4Store(f.artifactRoot)
        .readResolvedV9(result.testSpecId, result.compilerAttemptId!, trace);
      const pair = await new DeferredReplayV9Store(f.artifactRoot)
        .readReplayV1(result.testSpecId, result.deferredReplay!.orchestrationId, compiler);
      const replay = requireTrustedDeferredReplayReadbackV1(pair).record;
      expect(replay.runs).toHaveLength(1);
      expect(replay.runs[0]!.result).toMatchObject({kind:'non_qa_stop',reasonCode:'ENVIRONMENT_FAILURE',failedStepId:expect.any(String)});
      expect(replay.runs[0]!.steps.find((step) => step.originStepId === 's3')).toBeUndefined();
    } finally { await f.close(); }
  });
}

test('a delivered navigating click can resume directly at the next action', async () => {
  const f = await fixture('direct_action');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    const result = response.context.result;
    expect(result.terminal.status, JSON.stringify(response)).toBe('QA_ASSERTION_PASSED');
    const trace = await new SuccessfulTraceV5Store(f.artifactRoot)
      .readSuccessfulExplorationV5(result.testSpecId, result.explorationAttemptId!);
    const path = trace.protectedArtifact().trace.successfulPath;
    const link = path.find((step) => step.type === 'action_goal' && step.originStepId === 's2');
    const choice = path.find((step) => step.type === 'action_goal' && step.originStepId === 's4');
    if (link?.type !== 'action_goal' || choice?.type !== 'action_goal') throw new Error('Missing actions');
    expect(link.continuation && 'nextActionWitnessId' in link.continuation ? link.continuation.nextActionWitnessId : undefined)
      .toBe(choice.witness.witnessId);
    expect(choice.witness.postEffect.before.stateDigest).toBe(link.postStateDigest);
  } finally { await f.close(); }
});

test('different completed replay assertions remain a reproducibility stop', async () => {
  const f = await fixture('replay_disagreement');
  try {
    const response = await f.run();
    if (response.kind === 'bridge_error') throw new Error('Bridge error');
    expect(response.context.result.terminal.status, JSON.stringify(response)).toBe('REPRODUCIBILITY_FAILED');
    expect(response.context.result.terminal.stage).toBe('reproducibility');
    expect(response.context.result.cleanup).toBe('verified');
    expect(f.denied).toEqual([]);
  } finally { await f.close(); }
});
