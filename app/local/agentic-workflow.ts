import { randomUUID } from 'node:crypto';
import { LocalArtifactStore } from '../evidence/store.js';
import { finalizeAgenticOutcomeV2, runAgenticProductionV1, runGoalDirectedProductionV1,
  runStructuredActionProductionV1,
  createOpenAIAgenticDecisionModel, createOpenAIAgenticInterpretationModel,
  createOpenAIStructuredActionInterpretationModel, interpretTask,
  createOpenAIVerificationDecisionModel,
  type AgenticDecisionModelV3, type AgenticVerificationModelV4,
  type InterpretationModel } from '../interpretation/index.js';
import { ProfileCatalog, ProtectedContextFactory, parseTrustedBrowserBackend, profilePresentationMode,
  type EffectiveProfile, type ProfileRef, type ProtectedBrowserSession,
  type ProtectedSessionOptions } from '../profile/index.js';
import { envelopeForAgenticTerminalV2, type SubprocessResponseV2 } from '../subprocess/protocol-v2.js';
import { projectStoredAgenticReportV2 } from '../subprocess/report-projection-v2.js';
import { LocalWorkflowError } from './workflow.js';
import { runDeferredLocalWorkflowV1, deferredWorkflowOfflineReviewEnabled } from './deferred-workflow.js';
import type { DeferredProductionModelsV1 } from '../interpretation/deferred-action-production.js';
import { runSemanticGeneralLocalWorkflowV1, type SemanticGeneralLocalOptionsV1 } from './semantic-general-workflow.js';
import { LocalWorkflowRequestSchema, parseTrustedLocalConfiguration, selectActivePocBrowserProfile,
  toInterpretationRequest, type LocalWorkflowTrustedDependencies } from './contracts.js';

/** One trusted v2 job. The request never chooses its workflow or policy. */
export async function runAgenticLocalWorkflow(requestInput: unknown, configInput: unknown,
  dependencies: LocalWorkflowTrustedDependencies, options: { signal?: AbortSignal;
    workflowVersion?: 'agentic-exploration-v1' | 'goal-directed-v1' | 'structured-action-v1' | 'deferred-action-v1' | 'semantic-general-v1';
    deferredModels?: DeferredProductionModelsV1;
    interpretationModel?: InterpretationModel; decisionModel?: AgenticDecisionModelV3;
    verificationModel?: AgenticVerificationModelV4 } & SemanticGeneralLocalOptionsV1 = {},
): Promise<SubprocessResponseV2> {
  const workflowVersion = options.workflowVersion ?? 'agentic-exploration-v1';
  if (workflowVersion === 'deferred-action-v1' && !deferredWorkflowOfflineReviewEnabled())
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  if (workflowVersion === 'semantic-general-v1' &&
      (process.env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION !== 'semantic-general-v1' ||
       process.env.PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE !== 'offline-review'))
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  if (workflowVersion !== 'agentic-exploration-v1' && workflowVersion !== 'goal-directed-v1' &&
      workflowVersion !== 'structured-action-v1' && workflowVersion !== 'deferred-action-v1' &&
      workflowVersion !== 'semantic-general-v1')
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  const request = LocalWorkflowRequestSchema.parse(requestInput);
  let config = parseTrustedLocalConfiguration(configInput);
  if (workflowVersion === 'deferred-action-v1' || workflowVersion === 'semantic-general-v1') {
    try {
      const backend = parseTrustedBrowserBackend(process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND);
      if (backend === 'local-windows') {
        const selected = selectActivePocBrowserProfile(config, backend);
        if (request.executionProfileRef.id !== selected.reference.id ||
            request.executionProfileRef.version !== selected.reference.version)
          throw new Error('Request profile does not match trusted local selection');
        config = selected.config;
      }
    } catch { throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }
  }
  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  let effective: EffectiveProfile;
  try { effective = catalog.resolve(request.executionProfileRef); }
  catch { throw new LocalWorkflowError('PROFILE_UNAVAILABLE'); }
  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  const gate = undefined;

  if (workflowVersion === 'deferred-action-v1') return runDeferredLocalWorkflowV1(request, config, catalog, gate, dependencies, options);
  if (workflowVersion === 'semantic-general-v1') return runSemanticGeneralLocalWorkflowV1(
    request, config, catalog, gate, dependencies, options);

  let interpretationModel: InterpretationModel;
  let decisionModel: AgenticDecisionModelV3;
  let verificationModel: AgenticVerificationModelV4 | undefined;
  try {
    if ((!options.interpretationModel || !options.decisionModel ||
          workflowVersion !== 'agentic-exploration-v1' && !options.verificationModel) &&
        !dependencies.provider.apiKey()?.trim())
      throw new Error('Missing provider credential');
    interpretationModel = options.interpretationModel ?? (workflowVersion === 'structured-action-v1'
      ? createOpenAIStructuredActionInterpretationModel(dependencies.provider)
      : createOpenAIAgenticInterpretationModel(dependencies.provider));
    decisionModel = options.decisionModel ?? createOpenAIAgenticDecisionModel(dependencies.provider);
    if (workflowVersion !== 'agentic-exploration-v1') verificationModel = options.verificationModel ??
      createOpenAIVerificationDecisionModel(dependencies.provider);
  } catch { throw new LocalWorkflowError('PROVIDER_CONFIGURATION_ERROR'); }
  const store = new LocalArtifactStore(config.artifactRoot, undefined, config.retentionDays);
  const requestForModel = toInterpretationRequest(request, `local-${randomUUID()}`);
  const cancellableModel: InterpretationModel = { complete: async (input) => {
    if (!options.signal) return interpretationModel.complete(input);
    if (options.signal.aborted) throw new LocalWorkflowError('CANCELLED');
    const signal = AbortSignal.any([input.signal, options.signal]);
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new LocalWorkflowError('CANCELLED'));
      options.signal!.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([interpretationModel.complete({ ...input, signal }), cancelled]); }
    finally { if (onAbort) options.signal.removeEventListener('abort', onAbort); }
  } };
  const interpretation = await interpretTask(requestForModel, cancellableModel,
    { goalDirected: workflowVersion === 'goal-directed-v1',
      structuredActionIdentity: workflowVersion === 'structured-action-v1' });
  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  if (interpretation.kind === 'rejected') {
    // No validated TestSpec exists, so there is no immutable agentic report to reconstruct.
    const reason = interpretation.result.reason;
    const providerReason = (['MODEL_ERROR', 'MODEL_TIMEOUT', 'PROVIDER_ERROR',
      'PROVIDER_TIMEOUT'] as const).find((code) => code === reason);
    const environmentReason = providerReason ??
      (reason?.startsWith('MODEL_') || reason?.startsWith('PROVIDER_') ?
        'REDACTED_REASON' as const : undefined);
    const terminal = environmentReason
      ? { stage: 'environment' as const, status: 'ENVIRONMENT_FAILED' as const,
          reason: environmentReason }
      : interpretation.result.status === 'AMBIGUOUS_INSTRUCTION'
      ? { stage: 'interpretation' as const, status: 'AMBIGUOUS_INSTRUCTION' as const,
          reason: reason === 'MATERIAL_AMBIGUITY' ? 'MATERIAL_AMBIGUITY' as const : 'REDACTED_REASON' as const }
      : { stage: 'interpretation' as const, status: 'INTERPRETATION_FAILED' as const,
          reason: reason === 'INVALID_TEST_SPEC' || reason === 'MALFORMED_MODEL_OUTPUT' ? reason : 'REDACTED_REASON' as const };
    const { parseResultRecordV2 } = await import('../domain/agentic-result-v2.js');
    const result = parseResultRecordV2({ resultVersion: '2', workflowVersion,
      testSpecId: requestForModel.testSpecId, executionProfileRef: request.executionProfileRef,
      profileFingerprint: effective.fingerprint, presentationMode: profilePresentationMode(effective.profile),
      observation: profilePresentationMode(effective.profile) === 'headed' ? 'observational' : 'unobserved',
      executionRunIds: [], terminal, cleanup: 'not_started' });
    return envelopeForAgenticTerminalV2(result, false);
  }
  await store.createJob(interpretation.testSpec, effective);
  const sessions = new Set<ProtectedBrowserSession>();
  class ManagedFactory extends ProtectedContextFactory {
    override async open(ref: ProfileRef, expected?: EffectiveProfile,
      sessionOptions?: ProtectedSessionOptions): Promise<ProtectedBrowserSession> {
      if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      const session = await super.open(ref, expected, sessionOptions);
      sessions.add(session);
      if (options.signal?.aborted) { await session.close(); throw new LocalWorkflowError('CANCELLED'); }
      return session;
    }
  }
  const factory = new ManagedFactory(catalog, dependencies.authProvider, gate);
  const close = async (): Promise<void> => {
    const settled = await Promise.allSettled([...sessions].map((session) => session.close()));
    sessions.clear();
    if (settled.some((item) => item.status === 'rejected')) throw new LocalWorkflowError('WORKFLOW_FAILED');
  };
  const onAbort = (): void => { void close().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const outcome = workflowVersion === 'structured-action-v1' ?
      await runStructuredActionProductionV1(factory, store, interpretation.testSpec, decisionModel,
        verificationModel!, { workflowVersion, evidencePolicy: config.evidencePolicy,
          ...(options.signal ? { signal: options.signal } : {}) }) :
      workflowVersion === 'goal-directed-v1' ?
      await runGoalDirectedProductionV1(factory, store, interpretation.testSpec, decisionModel,
        verificationModel!, { workflowVersion, evidencePolicy: config.evidencePolicy,
          ...(options.signal ? { signal: options.signal } : {}) }) :
      await runAgenticProductionV1(factory, store, interpretation.testSpec, decisionModel,
        { workflowVersion, evidencePolicy: config.evidencePolicy,
          ...(options.signal ? { signal: options.signal } : {}) });
    await close();
    const result = await finalizeAgenticOutcomeV2(store, interpretation.testSpec, outcome, workflowVersion);
    const provisional = envelopeForAgenticTerminalV2(result, !!result.successfulTraceId);
    const projection = result.successfulTraceId ? await projectStoredAgenticReportV2(
      { reportProjectionVersion: '2', result: provisional }, config) : undefined;
    return envelopeForAgenticTerminalV2(result, projection?.kind === 'available');
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await close();
  }
}
