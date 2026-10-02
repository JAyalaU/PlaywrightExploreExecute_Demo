import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalArtifactStore, readStoredJobReport } from '../evidence/index.js';
import {
  createOpenAIModelAdapters, handoffTask,
  type InterpretationModel, type StepDecisionModel,
} from '../interpretation/index.js';
import {
  ProfileCatalog, ProtectedContextFactory, profilePresentationMode,
  type EffectiveProfile, type ProfileRef, type ProtectedBrowserSession, type ProtectedSessionOptions,
} from '../profile/index.js';
import {
  LocalWorkflowOutcomeSchema, LocalWorkflowRequestSchema,
  parseTrustedLocalConfiguration, toInterpretationRequest,
  type LocalWorkflowOutcome, type LocalWorkflowTrustedDependencies,
} from './contracts.js';
import { LocalObservationRecorder } from './observation.js';
import type { LiveEventProducer } from '../observability/live-events.js';
import type { ViewerLifecycle } from '../observability/viewer-channel.js';
import { LiveImageCaptureCoordinator, type LiveImageSink } from '../observability/live-images.js';

export type LocalWorkflowFailureCode =
  | 'INVALID_REQUEST' | 'INVALID_TRUSTED_CONFIGURATION' | 'PROFILE_UNAVAILABLE'
  | 'DESTINATION_DENIED' | 'PROVIDER_CONFIGURATION_ERROR' | 'CANCELLED'
  | 'WORKFLOW_FAILED' | 'REPORT_INVALID';

/** Local setup/transport failures stay separate from the M7 typed handoff result. */
export class LocalWorkflowError extends Error {
  constructor(readonly code: LocalWorkflowFailureCode) {
    super(code);
    this.name = 'LocalWorkflowError';
  }
}

export interface LocalWorkflowOptions {
  signal?: AbortSignal;
  events?: LiveEventProducer;
  viewer?: ViewerLifecycle;
  /** Trusted P4-2A capture seam. P4-2B owns private authenticated delivery. */
  liveImageSink?: LiveImageSink;
  /** Trusted composition seam for credential-free integration tests. */
  modelAdapters?: { interpretationModel: InterpretationModel; stepDecisionModel: StepDecisionModel };
}

class ManagedContextFactory extends ProtectedContextFactory {
  readonly #sessions = new Set<ProtectedBrowserSession>();
  readonly #recorder: LocalObservationRecorder;
  readonly #images: LiveImageCaptureCoordinator | undefined;
  readonly #viewer: ViewerLifecycle | undefined;
  readonly #signal: AbortSignal | undefined;
  #finishPause: (() => void) | undefined;
  #openedProtectedSession = false;
  #cancelled = false;

  constructor(catalog: ProfileCatalog, recorder: LocalObservationRecorder,
    images?: LiveImageCaptureCoordinator, viewer?: ViewerLifecycle,
    authProvider?: ConstructorParameters<typeof ProtectedContextFactory>[1],
    externalTargetGate?: ConstructorParameters<typeof ProtectedContextFactory>[2],
    signal?: AbortSignal) {
    super(catalog, authProvider, externalTargetGate);
    this.#recorder = recorder;
    this.#images = images;
    this.#viewer = viewer;
    this.#signal = signal;
  }

  get openedProtectedSession(): boolean { return this.#openedProtectedSession; }

  async #presentationPause(ms: number): Promise<void> {
    if (this.#cancelled || this.#signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#signal?.removeEventListener('abort', finish);
        if (this.#finishPause === finish) this.#finishPause = undefined;
        resolve();
      };
      this.#finishPause = finish;
      timer = setTimeout(finish, ms);
      this.#signal?.addEventListener('abort', finish, { once: true });
      if (this.#cancelled || this.#signal?.aborted) finish();
    });
  }

  override async pauseForObservation(session: ProtectedBrowserSession): Promise<void> {
    if (this.#viewer?.approved && !session.isClosed &&
        profilePresentationMode(session.effectiveProfile.profile) === 'headed') {
      await this.#presentationPause(4_000);
    }
  }

  override async open(reference: ProfileRef, expected?: EffectiveProfile,
    options?: ProtectedSessionOptions): Promise<ProtectedBrowserSession> {
    if (this.#cancelled) throw new LocalWorkflowError('CANCELLED');
    const session = await super.open(reference, expected, options);
    // Cancellation must own the session as soon as Docker has created it,
    // including while the headed viewer is warming up before browser work.
    this.#sessions.add(session);
    try {
      if (this.#cancelled) throw new LocalWorkflowError('CANCELLED');
      if (profilePresentationMode(session.effectiveProfile.profile) === 'headed') {
        if (!options?.observationOwner) throw new Error('Headed session has no observation owner');
        await this.#recorder.attach(session, options.observationOwner);
        if (this.#viewer?.approved) {
          await this.#viewer.open(session, options.observationOwner);
          // The lifecycle notice and pinned noVNC module need a bounded chance
          // to connect before the first browser navigation can finish.
          await this.#presentationPause(3_000);
        }
      }
      if (this.#cancelled) throw new LocalWorkflowError('CANCELLED');
      this.#openedProtectedSession = true;
      if (options?.observationOwner) this.#images?.attach(session, options.observationOwner);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    this.#finishPause?.();
    await this.close();
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
    const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new LocalWorkflowError('WORKFLOW_FAILED');
  }
}

async function completeWithCancellation<R extends { signal: AbortSignal }>(
  complete: (request: R) => Promise<string>, request: R, signal?: AbortSignal,
): Promise<string> {
  if (!signal) return complete(request);
  if (signal.aborted) throw new LocalWorkflowError('CANCELLED');
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new LocalWorkflowError('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      complete({ ...request, signal: AbortSignal.any([signal, request.signal]) }), cancelled,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** One local request through the existing M7 handoff and protected browser boundary. */
export async function runLocalWorkflow(
  requestInput: unknown,
  trustedConfigurationInput: unknown,
  trustedDependencies: LocalWorkflowTrustedDependencies,
  options: LocalWorkflowOptions = {},
): Promise<LocalWorkflowOutcome> {
  let request: z.infer<typeof LocalWorkflowRequestSchema>;
  try { request = LocalWorkflowRequestSchema.parse(requestInput); }
  catch { throw new LocalWorkflowError('INVALID_REQUEST'); }

  let config: ReturnType<typeof parseTrustedLocalConfiguration>;
  try { config = parseTrustedLocalConfiguration(trustedConfigurationInput); }
  catch { throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }

  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  let effective: EffectiveProfile;
  try { effective = catalog.resolve(request.executionProfileRef); }
  catch { throw new LocalWorkflowError('PROFILE_UNAVAILABLE'); }

  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  const externalGate = undefined;

  let models: NonNullable<LocalWorkflowOptions['modelAdapters']>;
  try { models = options.modelAdapters ?? createOpenAIModelAdapters(trustedDependencies.provider); }
  catch { throw new LocalWorkflowError('PROVIDER_CONFIGURATION_ERROR'); }

  const store = new LocalArtifactStore(config.artifactRoot, undefined, config.retentionDays);
  const testSpecId = `local-${randomUUID()}`;
  options.events?.begin({ testSpecId, executionProfileRef: request.executionProfileRef,
    profileFingerprint: effective.fingerprint });
  const recorder = new LocalObservationRecorder(store, testSpecId);
  const images = options.events && options.liveImageSink
    ? new LiveImageCaptureCoordinator(config.liveImagePolicy, options.events, options.liveImageSink)
    : undefined;
  if (profilePresentationMode(effective.profile) === 'headed' && config.liveViewerPolicy?.displayApproved &&
      !options.viewer?.approved) throw new LocalWorkflowError('WORKFLOW_FAILED');
  const factory = new ManagedContextFactory(catalog, recorder, images, options.viewer,
    trustedDependencies.authProvider,
    externalGate, options.signal);
  const interpretationRequest = toInterpretationRequest(request, testSpecId);
  let cleanup: Promise<void> | undefined;
  const onAbort = (): void => {
    cleanup ??= factory.cancel();
    void cleanup.catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    const handoff = await handoffTask(factory, store, interpretationRequest,
      { complete: (value) => completeWithCancellation(
        (request) => models.interpretationModel.complete(request), value, options.signal) },
      { complete: (value) => completeWithCancellation(
        (request) => models.stepDecisionModel.complete(request), value, options.signal) },
      { evidencePolicy: config.evidencePolicy, ...(options.events ? { events: options.events } : {}) });
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');

    await recorder.flush();

    const report = handoff.kind === 'executed' || handoff.attemptId
      ? await readStoredJobReport(store, testSpecId).then((stored) => {
          if (stored.effectiveProfile.fingerprint !== effective.fingerprint ||
              stored.testSpec.testSpecId !== testSpecId) throw new LocalWorkflowError('REPORT_INVALID');
          return { kind: 'available' as const, artifactRoot: config.artifactRoot, testSpecId };
        }).catch(() => { throw new LocalWorkflowError('REPORT_INVALID'); })
      : { kind: 'unavailable' as const };
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    options.events?.emit('report_completed', { availability: report.kind },
      handoff.kind === 'executed'
        ? { explorationAttemptId: handoff.attemptId, resolvedSpecId: handoff.resolvedSpecId }
        : handoff.attemptId ? { explorationAttemptId: handoff.attemptId } : {});

    const presentationMode = profilePresentationMode(effective.profile);
    const eventIds = recorder.eventIds();
    const observation = presentationMode === 'headed'
      ? { state: 'observational' as const, inputProvenance: 'unverified' as const,
          autonomousEligible: false, eventIds }
      : factory.openedProtectedSession && handoff.kind === 'executed'
        ? { state: 'no_intervention' as const, autonomousEligible: true, eventIds: [] }
        : { state: 'unobserved' as const, autonomousEligible: false, eventIds: [] };
    return LocalWorkflowOutcomeSchema.parse({
      testSpecId, executionProfileRef: request.executionProfileRef,
      profileFingerprint: effective.fingerprint, presentationMode,
      handoff, report, observation,
    }) as LocalWorkflowOutcome;
  } catch (error) {
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    if (error instanceof LocalWorkflowError) throw error;
    throw new LocalWorkflowError('WORKFLOW_FAILED');
  } finally {
    images?.close();
    options.signal?.removeEventListener('abort', onAbort);
    if (cleanup) await cleanup.catch(() => undefined);
    try { await factory.close(); await recorder.flush(); }
    catch { throw new LocalWorkflowError('WORKFLOW_FAILED'); }
  }
}
