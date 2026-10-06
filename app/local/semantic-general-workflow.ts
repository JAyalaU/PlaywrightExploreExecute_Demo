/** Trusted local composition for the separately gated semantic-general route. */
import { randomUUID } from 'node:crypto';
import { parseResultRecordV2, type ResultRecordV2 } from '../domain/agentic-result-v2.js';
import { issueSemanticGroundedTraceV1, type SemanticGroundedTraceRecordV1 } from '../domain/semantic-resolved-v10.js';
import { requireTrustedSemanticReplayReadbackV2 } from '../evidence/semantic-replay-store-v2.js';
import { SemanticExplorationDiagnosticsV1Store } from '../evidence/semantic-exploration-diagnostics-v1.js';
import { SemanticExplorationDiagnosticCollectorV1, semanticExplorationBrowserSnapshotV1,
  classifySemanticExplorationFailureV1,
  type SemanticExplorationBoundaryV1, type SemanticExplorationFailureV1,
  type SemanticExplorationStepDiagnosticV1 } from '../domain/semantic-exploration-diagnostics-v1.js';
import { DeferredBrowserDiagnosticCollector } from '../domain/deferred-browser-diagnostics.js';
import { McpExplorationSession } from '../exploration/mcp.js';
import { SemanticGroundingSessionV1, SemanticGroundingStopV1 } from '../exploration/semantic-grounding-v1.js';
import { createOpenAISemanticIntentModelsV3 } from '../interpretation/semantic-intent-v3-adapters.js';
import { ModelCompletionFailure } from '../interpretation/model-failure.js';
import { interpretSemanticIntentV3, type SemanticIntentModelsV3 } from '../interpretation/semantic-intent-v3.js';
import { runSemanticGeneralizedOptInV1 } from '../interpretation/semantic-general-production-v1.js';
import { DeferredViewerLifecycle, type DeferredViewerPhase } from '../observability/deferred-viewer-channel.js';
import { ProtectedContextFactory, parseTrustedBrowserBackend, profilePresentationMode,
  type EffectiveProfile, type ExternalTargetGate, type ProfileCatalog, type ProfileRef,
  type ProtectedBrowserSession, type ProtectedSessionOptions } from '../profile/index.js';
import { envelopeForAgenticTerminalV2, type SubprocessResponseV2 } from '../subprocess/protocol-v2.js';
import { toInterpretationRequest, type LocalWorkflowRequest, type LocalWorkflowTrustedDependencies,
  type TrustedLocalConfiguration } from './contracts.js';
import { LocalWorkflowError } from './workflow.js';

export type SemanticGeneralLocalOptionsV1 = { semanticModels?: SemanticIntentModelsV3 };

export async function runSemanticGeneralLocalWorkflowV1(request: LocalWorkflowRequest,
  config: TrustedLocalConfiguration, catalog: ProfileCatalog, gate: ExternalTargetGate | undefined,
  dependencies: LocalWorkflowTrustedDependencies,
  options: SemanticGeneralLocalOptionsV1 & { signal?: AbortSignal }): Promise<SubprocessResponseV2> {
  if (process.env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION !== 'semantic-general-v1' ||
      process.env.PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE !== 'offline-review')
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  const effective = catalog.resolve(request.executionProfileRef);
  const source = toInterpretationRequest(request, `local-${randomUUID()}`);
  const base = { resultVersion: '2' as const, workflowVersion: 'semantic-general-v1' as const,
    testSpecId: source.testSpecId, executionProfileRef: source.executionProfileRef,
    profileFingerprint: effective.fingerprint, presentationMode: profilePresentationMode(effective.profile),
    observation: profilePresentationMode(effective.profile) === 'headed' ? 'observational' as const : 'unobserved' as const };
  const terminal = (fields: Pick<ResultRecordV2, 'terminal' | 'cleanup'> &
    Partial<Pick<ResultRecordV2, 'explorationAttemptId' | 'successfulTraceId' |
      'compilerAttemptId' | 'resolvedSpecId' | 'executionRunIds' | 'semanticReplay'>>): SubprocessResponseV2 =>
    envelopeForAgenticTerminalV2(parseResultRecordV2({ ...base, executionRunIds: [], ...fields }), false);
  let models: SemanticIntentModelsV3;
  try {
    if (!options.semanticModels && !dependencies.provider.apiKey()?.trim())
      throw new Error('Provider credential unavailable');
    models = options.semanticModels ?? createOpenAISemanticIntentModelsV3(dependencies.provider);
  } catch { throw new LocalWorkflowError('PROVIDER_CONFIGURATION_ERROR'); }
  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  let providerFailure: 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'MODEL_ERROR' | 'MODEL_TIMEOUT' | undefined;
  const observe = (model: SemanticIntentModelsV3['primary']): SemanticIntentModelsV3['primary'] => ({
    complete: async input => {
      try { return await model.complete(input); }
      catch (error) {
        if (error instanceof ModelCompletionFailure &&
            ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'MODEL_ERROR', 'MODEL_TIMEOUT'].includes(error.code))
          providerFailure = error.code as typeof providerFailure;
        throw error;
      }
    },
  });
  const interpreted = await interpretSemanticIntentV3(source,
    { primary: observe(models.primary), reviewer: observe(models.reviewer) }, options.signal);
  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  if (providerFailure) return terminal({ terminal: {
    stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: providerFailure,
  }, cleanup: 'not_started' });
  if (interpreted.kind === 'rejected') return terminal({ terminal: {
    stage: 'interpretation', status: 'INTERPRETATION_FAILED',
    reason: interpreted.code === 'INVALID_SOURCE_REPRESENTATION' ? 'INVALID_TEST_SPEC' :
      interpreted.code === 'PROVIDER_OUTPUT_INVALID' ? 'MALFORMED_MODEL_OUTPUT' : 'REDACTED_REASON',
  }, cleanup: 'not_started' });
  const admission = interpreted.admission;
  const attemptId = `semantic-attempt-${randomUUID()}`;
  const diagnostics = new SemanticExplorationDiagnosticCollectorV1(source.testSpecId, attemptId);
  const viewerDiagnostics = new DeferredBrowserDiagnosticCollector();
  const diagnosticStore = new SemanticExplorationDiagnosticsV1Store(config.artifactRoot);
  const persist = async () => { try {
    const events = viewerDiagnostics.snapshot();
    const unavailable = events.findIndex(item => item.operation === 'unavailable' ||
      item.operation === 'capture_timeout');
    diagnostics.setViewerActivity({ captureTimeouts: events.filter(item => item.operation === 'capture_timeout').length,
      unavailableEvents: events.filter(item => item.operation === 'unavailable').length,
      recovered: unavailable >= 0 && events.slice(unavailable + 1).some(item =>
        item.operation === 'capture' && item.outcome === 'success'),
      channelLost: events.some(item => item.operation === 'channel_loss') });
    await diagnosticStore.write(diagnostics.snapshot()); }
    catch { /* Private diagnostics must not change the public terminal. */ } };
  let viewerState: 'not_requested' | 'opening' | 'ready' | 'transient_unavailable' |
    'terminal_unavailable' | 'closed' = 'not_requested';
  let documentGenerationId: string | null = null, domContentLoadedObserved: boolean | null = null;
  let mainResponseStatusClass: '2xx' | '3xx' | '4xx' | '5xx' | 'other' | null = null;
  let navigation: 'not_started' | 'started' | 'committed' | 'returned' | 'failed' = 'not_started';
  let browserLaunchAttempted = false;
  let activeStep: SemanticExplorationStepDiagnosticV1 | null = null;
  let currentBrowser: ProtectedBrowserSession | undefined;
  let viewer: DeferredViewerLifecycle | undefined;
  const mark = (boundary: SemanticExplorationBoundaryV1) => diagnostics.record(boundary, activeStep);
  const safeState = () => semanticExplorationBrowserSnapshotV1(currentBrowser, {
    browserLaunchAttempted, documentGenerationId, domContentLoadedObserved,
    mainResponseStatusClass, navigation,
    viewer: viewerState === 'opening' ? 'opening' : viewer?.diagnosticState ?? viewerState });
  const firstFailure = async (category: SemanticExplorationFailureV1) => {
    const browser = await safeState();
    await diagnostics.fail(browser.browser === 'disconnected' ? 'BROWSER_DISCONNECTED' : category,
      Promise.resolve(browser), activeStep?.stepId ?? null);
  };
  const backend = parseTrustedBrowserBackend(process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND);
  const liveView = process.env.PLAYWRIGHT_DEMO_LIVE_VIEW === '1';
  const viewerMode = backend === 'local-windows' ? 'frame_stream' : 'rfb';
  if (liveView) {
    viewerState = 'opening'; mark('viewer_open_started');
    try { viewer = await DeferredViewerLifecycle.connect(source.testSpecId, viewerMode, viewerDiagnostics.record);
      viewerState = 'ready'; mark('viewer_open_completed'); }
    catch { viewerState = 'terminal_unavailable'; await firstFailure('VIEWER_ONLY_FAILURE'); await persist();
      throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }
  }
  const sessions = new Set<ProtectedBrowserSession>();
  const phases: readonly DeferredViewerPhase[] = ['exploration', 'compilation', 'replay_1', 'replay_2'];
  let opened = 0;
  class ManagedFactory extends ProtectedContextFactory {
    override async open(ref: ProfileRef, expected?: EffectiveProfile, sessionOptions?: ProtectedSessionOptions) {
      if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      const exploration = sessionOptions?.observationOwner?.id === attemptId;
      const session = await super.open(ref, expected, exploration ? {
        ...sessionOptions, observeLifecycle: boundary => {
          if (boundary === 'browser_launch_started') browserLaunchAttempted = true;
          mark(boundary);
        },
      } : sessionOptions);
      if (exploration) currentBrowser = session;
      sessions.add(session);
      if (viewer) {
        const phase = phases[opened++];
        if (!phase || !sessionOptions?.observationOwner) {
          await session.close(); throw new LocalWorkflowError('WORKFLOW_FAILED');
        }
        try { if (exploration) { viewerState = 'opening'; mark('viewer_open_started'); }
          await viewer.open(session, phase, sessionOptions.observationOwner.id);
          if (exploration) { viewerState = viewer.diagnosticState; mark('viewer_open_completed'); } }
        catch { if (exploration) await firstFailure('VIEWER_ONLY_FAILURE');
          await session.close(); throw new LocalWorkflowError('WORKFLOW_FAILED'); }
      }
      if (options.signal?.aborted) { await session.close(); throw new LocalWorkflowError('CANCELLED'); }
      return session;
    }
  }
  const factory = new ManagedFactory(catalog, dependencies.authProvider, gate,
    { viewOnlyHeaded: liveView && viewerMode === 'rfb' });
  const close = async (): Promise<boolean> => {
    const closed = await Promise.allSettled([...sessions].map(session => session.close()));
    sessions.clear();
    return closed.every(item => item.status === 'fulfilled');
  };
  const onAbort = (): void => { void close(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let session: McpExplorationSession | undefined;
  let traceId: string | undefined;
  try {
    let records: SemanticGroundedTraceRecordV1[] = [];
    let groundingSessionId = '';
    try {
      mark('mcp_session_started');
      session = await McpExplorationSession.open(factory, admission.spec.executionProfileRef,
        effective, attemptId);
      mark('mcp_session_completed');
      currentBrowser = session.browserSession;
      const context = session.browserSession.context;
      const watchPage = (page: import('@playwright/test').Page) => {
        mark('page_create_completed');
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) {
          documentGenerationId = `document-${randomUUID()}`; domContentLoadedObserved = false;
          if (navigation === 'started') { navigation = 'committed'; mark('root_navigation_committed'); }
        } });
        page.on('domcontentloaded', () => { domContentLoadedObserved = true; });
      };
      context.on('page', watchPage);
      context.pages().forEach(watchPage);
      context.on('response', response => { try {
        if (response.request().isNavigationRequest() && response.request().frame() ===
            response.request().frame().page().mainFrame()) {
          const value = response.status();
          mainResponseStatusClass = value >= 200 && value < 300 ? '2xx' :
            value >= 300 && value < 400 ? '3xx' : value >= 400 && value < 500 ? '4xx' :
            value >= 500 && value < 600 ? '5xx' : 'other';
        }
      } catch { /* Passive response evidence only. */ } });
      const grounding = new SemanticGroundingSessionV1(session, admission, attemptId, event => {
        if (event.documentGenerationId) documentGenerationId = event.documentGenerationId;
        if (event.domContentLoadedObserved !== undefined)
          domContentLoadedObserved = event.domContentLoadedObserved;
        mark(event.boundary);
      });
      mark('grounding_session_initialized');
      for (const step of admission.spec.steps) {
        if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
        const target = step.type === 'action_intent' ? step.target :
          step.type === 'verification_intent' ? step.subject : null;
        activeStep = { stepId: step.id, kind: step.type === 'navigate' ? 'navigation' :
          step.type === 'action_intent' ? 'action' : 'verification',
          family: step.type === 'navigate' ? 'navigate' :
            step.type === 'action_intent' ? step.desiredEffect : step.observable,
          ordinalPresent: target?.ordinal !== null && target?.ordinal !== undefined,
          relationshipPresent: target?.relation === 'same_as_step' || target?.relation === 'created_by_step',
          mechanic: null, observation: null };
        mark('step_started');
        if (step.type === 'navigate') {
          navigation = 'started'; mark('root_navigation_started');
          if (context.pages().length === 0) mark('page_create_started');
          try { await session.navigate(step.url); navigation = 'returned'; mark('root_navigation_returned'); }
          catch (error) { navigation = 'failed'; throw error; }
          records.push({ type: 'navigate', step, observedUrl: session.browserSession.context.pages()[0]!.url() });
        } else if (step.type === 'action_intent') {
          const witness = await grounding.groundAction(step.id);
          groundingSessionId ||= witness.evidence.sessionId;
          activeStep.mechanic = witness.mechanic; mark('step_grounded');
          const receipt = await grounding.executeGroundedAction(witness);
          records.push({ type: 'action', witness, receipt });
        } else {
          const witness = await grounding.groundVerification(step.id);
          groundingSessionId ||= witness.evidence.sessionId;
          activeStep.observation = witness.observation; mark('step_grounded');
          records.push({ type: 'verification', witness });
        }
      }
    } catch (error) {
      const boundary = diagnostics.latest;
      const browser = await safeState();
      const category = !session && !['browser_launch_started', 'context_create_started',
        'viewer_open_started'].includes(boundary) ? 'UNKNOWN_EXPLORATION_FAILURE' :
        records.length === 1 && records[0]?.type === 'navigate' &&
        (mainResponseStatusClass === '4xx' || mainResponseStatusClass === '5xx') ?
        'ROOT_NAVIGATION_HTTP_FAILURE' : classifySemanticExplorationFailureV1(boundary, browser,
        error instanceof SemanticGroundingStopV1 ? error.reason : undefined);
      await diagnostics.fail(category, Promise.resolve(browser), activeStep?.stepId ?? null);
      await persist();
      mark('cleanup_started');
      const cleaned = await session?.close().then(() => true, () => false) ?? true;
      mark('cleanup_completed'); await persist();
      session = undefined;
      if (!cleaned) return terminal({ explorationAttemptId: attemptId, terminal: {
        stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED',
      }, cleanup: 'unverified' });
      if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      if (error instanceof SemanticGroundingStopV1) return terminal({ explorationAttemptId: attemptId,
        terminal: error.reason === 'ENVIRONMENT_UNAVAILABLE' || error.reason === 'BROWSER_FAILURE' ?
          { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'BROWSER_UNAVAILABLE' } :
          error.reason === 'UNSUPPORTED_CAPABILITY' || error.reason === 'EXPLICIT_MECHANIC_MISMATCH' ?
            { stage: 'exploration', status: 'EXPLORATION_UNSUPPORTED', reason: 'UNSUPPORTED_CAPABILITY' } :
            { stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'REDACTED_REASON' },
        cleanup: 'verified' });
      return terminal({ explorationAttemptId: attemptId, terminal: {
        stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'BROWSER_UNAVAILABLE',
      }, cleanup: 'verified' });
    }
    const trace = issueSemanticGroundedTraceV1(admission, { attemptId,
      sessionId: groundingSessionId || `semantic-session-${randomUUID()}`,
      profileFingerprint: session!.browserSession.effectiveProfile.fingerprint, records });
    traceId = `semantic-trace-${trace.traceDigest.slice(0, 32)}`;
    diagnostics.issuedTrace(traceId); mark('cleanup_started');
    const explorationCleaned = await session!.close().then(() => true, () => false);
    mark('cleanup_completed'); await persist();
    session = undefined;
    if (!explorationCleaned) return terminal({ explorationAttemptId: attemptId,
      successfulTraceId: traceId, terminal: {
        stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED',
      }, cleanup: 'unverified' });
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    const outcome = await runSemanticGeneralizedOptInV1(factory, config.artifactRoot, admission, trace);
    if (outcome.kind === 'compilation_stop') {
      const reason = outcome.compiler.result.status === 'rejected' ? outcome.compiler.result.reason : 'SOURCE_MISMATCH';
      const uncertain = outcome.compiler.cleanup === 'unverified';
      return terminal({ explorationAttemptId: attemptId, successfulTraceId: traceId,
        compilerAttemptId: outcome.compiler.compilerAttemptId, terminal: uncertain ? {
          stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED',
        } : reason === 'ENVIRONMENT_UNAVAILABLE' ? {
          stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'COMPILER_ENVIRONMENT_UNAVAILABLE',
        } : { stage: 'compilation', status: 'COMPILATION_FAILED', reason: 'REDACTED_REASON' },
        cleanup: uncertain ? 'unverified' : 'verified' });
    }
    const pair = requireTrustedSemanticReplayReadbackV2(outcome.replay);
    const runs = pair.runs.map(run => run.executionRunId);
    const compilerAttemptId = outcome.compilerAttemptId;
    if (pair.runs.some(run => run.compilerAttemptId !== compilerAttemptId))
      throw new Error('Semantic replay compiler correlation mismatch');
    const lineage = { explorationAttemptId: attemptId, successfulTraceId: traceId,
      compilerAttemptId, resolvedSpecId: pair.resolvedSpecId, executionRunIds: runs,
      semanticReplay: { sourceSchemaVersion: '7' as const, sourceContractVersion: '3' as const,
        groundingVersion: 'semantic_capability_discovery_v1' as const,
        traceVersion: 'semantic_grounded_trace_v1' as const, compilerVersion: '5' as const,
        resolvedSchemaVersion: '10' as const, runnerVersion: '10' as const,
        replayPairVersion: '2' as const, orchestrationId: pair.orchestrationId,
        traceDigest: trace.traceDigest, resolvedDigest: pair.resolvedDigest, pairDigest: pair.pairDigest,
        executionSessionIds: pair.runs.map(run => run.sessionId),
        runDigests: pair.runs.map(run => run.recordDigest) } };
    if (pair.terminal === 'QA_PASS' || pair.terminal === 'QA_FAIL') return terminal({ ...lineage,
      terminal: pair.terminal === 'QA_PASS' ? { stage: 'qa', status: 'QA_ASSERTION_PASSED' } :
        { stage: 'qa', status: 'QA_ASSERTION_FAILED', reason: 'REDACTED_REASON' }, cleanup: 'verified' });
    if (pair.agreement === 'disagreed') return terminal({ ...lineage, terminal: {
      stage: 'reproducibility', status: 'REPRODUCIBILITY_FAILED', reason: 'REPLAY_OUTCOMES_DISAGREE',
    }, cleanup: 'verified' });
    const uncertain = pair.runs.some(run => run.cleanup === 'unverified');
    return terminal({ ...lineage, terminal: uncertain ? {
      stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED',
    } : { stage: 'replay', status: 'REPLAY_EXECUTION_FAILED', reason: 'REPLAY_EXECUTION_FAILED' },
    cleanup: uncertain ? 'unverified' : 'verified' });
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    try { await session?.close(); await close(); } finally { viewer?.close(); }
  }
}
