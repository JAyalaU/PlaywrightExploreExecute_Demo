import { randomUUID } from 'node:crypto';
import { ProtectedContextFactory, type ProfileCatalog, type ProfileRef, type EffectiveProfile,
  type ProtectedBrowserSession, type ProtectedSessionOptions, type ExternalTargetGate } from '../profile/index.js';
import { runDeferredActionProductionV1, type DeferredProductionModelsV1 } from '../interpretation/deferred-action-production.js';
import { createOpenAIPocSemanticModels } from '../interpretation/deferred-action-poc-adapters.js';
import { createOpenAIActionGroundingModelsV1 } from '../interpretation/action-grounding-adapters.js';
import { createOpenAIVerificationDecisionModel } from '../interpretation/openai-adapters.js';
import {createOpenAINativeOptionVerificationModelV6} from '../interpretation/native-option-verification-controller.js';
import { envelopeForAgenticTerminalV2 } from '../subprocess/protocol-v2.js';
import { toInterpretationRequest, type LocalWorkflowRequest, type TrustedLocalConfiguration,
  type LocalWorkflowTrustedDependencies } from './contracts.js';
import { LocalWorkflowError } from './workflow.js';
import { DeferredViewerLifecycle, DeferredViewerPreflightError,
  type DeferredViewerPhase } from '../observability/deferred-viewer-channel.js';

/** Trusted offline-review gate is launch state. Neither the task nor wire request selects it. */
export function deferredWorkflowOfflineReviewEnabled(): boolean {
  return process.env.PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE === 'offline-review';
}
export async function runDeferredLocalWorkflowV1(request: LocalWorkflowRequest, config: TrustedLocalConfiguration,
  catalog: ProfileCatalog, gate: ExternalTargetGate | undefined, dependencies: LocalWorkflowTrustedDependencies,
  options: { signal?: AbortSignal; deferredModels?: DeferredProductionModelsV1 }) {
  if (!deferredWorkflowOfflineReviewEnabled()) throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  let models: DeferredProductionModelsV1;
  try {
    if (!options.deferredModels && !dependencies.provider.apiKey()?.trim()) throw new Error('Credential unavailable');
    const mapping = options.deferredModels ? undefined : createOpenAIActionGroundingModelsV1(dependencies.provider);
    models = options.deferredModels ?? { extraction: createOpenAIPocSemanticModels(dependencies.provider),
      grounding: mapping!.primary, independentGrounding: mapping!.independent,
      verification: createOpenAIVerificationDecisionModel(dependencies.provider),nativeVerification:createOpenAINativeOptionVerificationModelV6(dependencies.provider) };
  } catch { throw new LocalWorkflowError('PROVIDER_CONFIGURATION_ERROR'); }
  const requestForModel = toInterpretationRequest(request, `local-${randomUUID()}`);
  const viewOnlyHeaded = process.env.PLAYWRIGHT_DEMO_LIVE_VIEW === '1';
  let viewer: DeferredViewerLifecycle | undefined;
  if (viewOnlyHeaded) {
    try { viewer = await DeferredViewerLifecycle.connect(requestForModel.testSpecId); }
    catch { throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }
  }
  let browserPhase: DeferredViewerPhase | undefined;
  const sessions = new Set<ProtectedBrowserSession>();
  class ManagedFactory extends ProtectedContextFactory {
    override async open(ref: ProfileRef, expected?: EffectiveProfile, sessionOptions?: ProtectedSessionOptions) {
      if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      const session = await super.open(ref, expected, sessionOptions); sessions.add(session);
      if (options.signal?.aborted) { await session.close(); throw new LocalWorkflowError('CANCELLED'); }
      if (viewer) {
        try {
          if (!browserPhase || !sessionOptions?.observationOwner) throw new Error('Deferred viewer phase owner unavailable');
          await viewer.open(session, browserPhase, sessionOptions.observationOwner.id);
        } catch {
          try { await session.close(); } catch { throw new DeferredViewerPreflightError('unverified'); }
          throw new DeferredViewerPreflightError('verified');
        }
      }
      return session;
    }
  }
  // Cancellation tears down protected resources; both asynchronous errors and final close are observed.
  let cancellationCleanup: Promise<void> | undefined;
  const close = async () => {
    const result = await Promise.allSettled([...sessions].map(session => session.close()));
    if (result.some(item => item.status === 'rejected')) throw new LocalWorkflowError('WORKFLOW_FAILED');
  };
  const aborted = () => { cancellationCleanup = close(); void cancellationCleanup.catch(() => undefined); };
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    const outcome = await runDeferredActionProductionV1(new ManagedFactory(catalog, dependencies.authProvider, gate,
      { viewOnlyHeaded }), config.artifactRoot, requestForModel, models,
      { ...(options.signal ? { signal: options.signal } : {}),
        ...(viewer ? { onBrowserPhase: (phase: DeferredViewerPhase) => { browserPhase = phase; } } : {}) });
    await cancellationCleanup; await close();
    if (options.signal?.aborted) return { protocolVersion: '2' as const, kind: 'bridge_error' as const,
      code: 'CANCELLED' as const, cleanup: outcome.result.cleanup === 'unverified' ? 'unverified' as const : 'verified' as const };
    return envelopeForAgenticTerminalV2(outcome.result, outcome.reportAvailable);
  } finally {
    options.signal?.removeEventListener('abort', aborted);
    try { await close(); } finally { sessions.clear(); viewer?.close(); }
  }
}
