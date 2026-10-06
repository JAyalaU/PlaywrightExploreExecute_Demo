import { z } from 'zod';
import {
  ExecutionProfileRefSchema, ResultRecordSchema, TestSpecSchema,
} from '../domain/schema.js';
import type { HandoffOutcome } from '../interpretation/handoff.js';
import type { InterpretationRequest } from '../interpretation/interpret.js';
import type { OpenAIResponsesConfig } from '../interpretation/openai-responses.js';
import {
  ExecutionProfileSchema, LocalWindowsExecutionProfileSchema, NetworkPolicySchema, ProfileCatalog,
  PublicTargetApprovalSchema,
  type AuthStateProvider, type ExternalTargetGate, type PresentationMode,
  type TrustedBrowserBackend,
} from '../profile/index.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const url = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}, 'Expected an absolute HTTP(S) URL');

/** Untrusted task input cannot carry egress, evidence, credential, or browser settings. */
export const LocalWorkflowRequestSchema = z.strictObject({
  taskText: z.string().min(1).refine((value) => value.trim().length > 0),
  targetUrl: url,
  executionProfileRef: ExecutionProfileRefSchema,
});
export type LocalWorkflowRequest = z.infer<typeof LocalWorkflowRequestSchema>;

export function toInterpretationRequest(requestInput: unknown, testSpecId: string): InterpretationRequest {
  const request = LocalWorkflowRequestSchema.parse(requestInput);
  return {
    sourceInstruction: request.taskText,
    testSpecId: id.parse(testSpecId),
    executionProfileRef: request.executionProfileRef,
    startState: { url: request.targetUrl },
  };
}

export const LocalEvidencePolicySchema = z.strictObject({
  finalScreenshot: z.boolean(), failureScreenshot: z.boolean(),
  failureTrace: z.boolean(), failureVideo: z.boolean(),
  sensitiveBinaryApproved: z.boolean(),
}).superRefine((policy, context) => {
  if (!policy.sensitiveBinaryApproved &&
      (policy.finalScreenshot || policy.failureScreenshot || policy.failureTrace || policy.failureVideo)) {
    context.addIssue({ code: 'custom', path: ['sensitiveBinaryApproved'], message: 'Binary capture requires approval' });
  }
});

/** Separate, ephemeral P4-G1 authority. Stored binary-evidence approval does not imply this approval. */
export const LiveImagePolicySchema = z.strictObject({
  liveImagePolicyVersion: z.literal('1'),
  captureApproved: z.boolean(),
  displayApproved: z.boolean(),
});
export type LiveImagePolicy = z.infer<typeof LiveImagePolicySchema>;

export const LiveViewerPolicySchema = z.strictObject({
  liveViewerPolicyVersion: z.literal('1'),
  displayApproved: z.boolean(),
});
export type LiveViewerPolicy = z.infer<typeof LiveViewerPolicySchema>;

/** Serializable trusted settings. Secret values and approval callbacks stay external. */
export const TrustedLocalConfigurationSchema = z.strictObject({
  profiles: z.array(ExecutionProfileSchema).min(1),
  networkPolicies: z.array(NetworkPolicySchema).default([]),
  evidencePolicy: LocalEvidencePolicySchema,
  liveImagePolicy: LiveImagePolicySchema.optional(),
  liveViewerPolicy: LiveViewerPolicySchema.optional(),
  artifactRoot: z.string().min(1),
  retentionDays: z.number().int().min(1).max(365),
  publicTargetApproval: PublicTargetApprovalSchema.optional(),
});
export type TrustedLocalConfiguration = z.infer<typeof TrustedLocalConfigurationSchema>;

export function parseTrustedLocalConfiguration(input: unknown): TrustedLocalConfiguration {
  const config = TrustedLocalConfigurationSchema.parse(input);
  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  for (const profile of config.profiles) catalog.resolve({ id: profile.id, version: profile.version });
  return config;
}

/** Active PoC runtime setting. Historical reads retain their stored profile. */
export const ACTIVE_POC_NAVIGATION_MS = 90_000;

export function parseActivePocTrustedConfiguration(input: unknown): TrustedLocalConfiguration {
  const config = parseTrustedLocalConfiguration(input);
  return {
    ...config,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      timeoutPolicy: { ...profile.timeoutPolicy, navigationMs: ACTIVE_POC_NAVIGATION_MS },
    })),
  };
}

/** Derive the reviewed Windows runtime identity from trusted PoC configuration only. */
export function selectActivePocBrowserProfile(config: TrustedLocalConfiguration,
  backend: TrustedBrowserBackend): { config: TrustedLocalConfiguration;
    reference: { id: string; version: string }; fingerprint: string } {
  const preferred = config.publicTargetApproval?.executionProfileRef;
  const source = preferred && config.profiles.some((profile) =>
    profile.id === preferred.id && profile.version === preferred.version)
    ? preferred : { id: config.profiles[0]!.id, version: config.profiles[0]!.version };
  const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
  const effective = catalog.resolve(source);
  if (backend === 'docker-isolated') return { config, reference: source, fingerprint: effective.fingerprint };
  const profile = effective.profile;
  if (!('browserIsolation' in profile) || profile.browserIsolation !== 'docker')
    throw new Error('Local Windows PoC requires a trusted Docker source profile');
  const local = LocalWindowsExecutionProfileSchema.parse({
    id: `local-windows-${effective.fingerprint.slice(0, 32)}`, version: '1',
    profileSchemaVersion: '5', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows', presentationMode: 'headless',
    browser: profile.browser, viewport: profile.viewport, locale: profile.locale,
    timeoutPolicy: profile.timeoutPolicy,
    ...(profile.timezoneId ? { timezoneId: profile.timezoneId } : {}),
    ...(profile.colorScheme ? { colorScheme: profile.colorScheme } : {}),
    ...(profile.deviceScaleFactor ? { deviceScaleFactor: profile.deviceScaleFactor } : {}),
    ...(profile.isMobile !== undefined ? { isMobile: profile.isMobile } : {}),
    ...(profile.hasTouch !== undefined ? { hasTouch: profile.hasTouch } : {}),
    ...(profile.javaScriptEnabled !== undefined ? { javaScriptEnabled: profile.javaScriptEnabled } : {}),
    ...(profile.reducedMotion ? { reducedMotion: profile.reducedMotion } : {}),
    ...(profile.authStateRef ? { authStateRef: profile.authStateRef } : {}),
  });
  const selectedConfig = { ...config, profiles: [...config.profiles, local] };
  const reference = { id: local.id, version: local.version };
  return { config: selectedConfig, reference,
    fingerprint: new ProfileCatalog(selectedConfig.profiles, selectedConfig.networkPolicies)
      .resolve(reference).fingerprint };
}

/** Trusted dependencies are not serializable request fields or evidence. */
export interface LocalWorkflowTrustedDependencies {
  provider: OpenAIResponsesConfig;
  authProvider?: AuthStateProvider;
  externalTargetGate?: ExternalTargetGate;
}

export const AutomationActionScopeSchema = z.strictObject({
  scopeId: id,
  actionId: id,
  originStepId: id.optional(),
  executionStepId: id.optional(),
});

const observationOwner = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attempt'), id }),
  z.strictObject({ kind: z.literal('run'), id }),
]);

export const ObservationCorrelationSchema = z.strictObject({
  testSpecId: id,
  owner: observationOwner,
  executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: fingerprint,
});
export type ObservationCorrelation = z.infer<typeof ObservationCorrelationSchema>;

/** These records contain no keystrokes, coordinates, page text, or credentials. */
export const ObservationEventSchema = ObservationCorrelationSchema.extend({
  eventId: id,
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  inputCategory: z.enum(['pointer', 'keyboard', 'touch', 'wheel', 'other']),
  attribution: z.enum(['operator', 'uncertain', 'outside_scope']),
  interventionReason: z.enum(['OPERATOR_INPUT', 'UNCERTAIN_ORIGIN', 'INPUT_OUTSIDE_SCOPE']),
  automationScope: AutomationActionScopeSchema.optional(),
}).superRefine((event, context) => {
  if (event.attribution === 'outside_scope' && event.automationScope) {
    context.addIssue({ code: 'custom', path: ['automationScope'], message: 'Out-of-scope input cannot carry an action scope' });
  }
  const expectedReason = {
    operator: 'OPERATOR_INPUT', uncertain: 'UNCERTAIN_ORIGIN', outside_scope: 'INPUT_OUTSIDE_SCOPE',
  }[event.attribution];
  if (event.interventionReason !== expectedReason) {
    context.addIssue({ code: 'custom', path: ['interventionReason'], message: 'Reason must match attribution' });
  }
});
export type ObservationEvent = z.infer<typeof ObservationEventSchema>;
export type ObservationEventInput = Omit<ObservationEvent, 'sequence'>;

/** The contract's append/readback semantics; P2-2C supplies detection and storage. */
export class ObservationJournal {
  readonly #correlation: ObservationCorrelation;
  readonly #presentationMode: PresentationMode;
  readonly #events: ObservationEvent[] = [];
  readonly #ids = new Set<string>();

  constructor(correlation: unknown, presentationMode: PresentationMode) {
    this.#correlation = ObservationCorrelationSchema.parse(correlation);
    this.#presentationMode = z.enum(['headless', 'headed']).parse(presentationMode);
  }

  append(input: ObservationEventInput): ObservationEvent {
    const event = ObservationEventSchema.parse({ ...input, sequence: this.#events.length });
    if (JSON.stringify(this.#correlation) !== JSON.stringify({
      testSpecId: event.testSpecId, owner: event.owner,
      executionProfileRef: event.executionProfileRef, profileFingerprint: event.profileFingerprint,
    })) throw new Error('Observation event correlation mismatch');
    if (this.#ids.has(event.eventId)) throw new Error('Observation event ID already exists');
    this.#ids.add(event.eventId);
    this.#events.push(event);
    return structuredClone(event);
  }

  records(): readonly ObservationEvent[] { return structuredClone(this.#events); }
  get autonomousEligible(): boolean {
    return this.#presentationMode === 'headless' && this.#events.length === 0;
  }

  state(observationActive: boolean): z.infer<typeof ObservationStateSchema> {
    if (this.#presentationMode === 'headed') return {
      state: 'observational', inputProvenance: 'unverified', autonomousEligible: false,
      eventIds: this.#events.map((event) => event.eventId),
    };
    if (this.#events.length) return {
      state: 'intervened', autonomousEligible: false,
      eventIds: this.#events.map((event) => event.eventId),
    };
    return observationActive
      ? { state: 'no_intervention', autonomousEligible: true, eventIds: [] }
      : { state: 'unobserved', autonomousEligible: false, eventIds: [] };
  }

  static readback(correlation: unknown, records: unknown, presentationMode: PresentationMode): ObservationJournal {
    if (!Array.isArray(records)) throw new Error('Observation log must be an array');
    const log = new ObservationJournal(correlation, presentationMode);
    for (const [sequence, raw] of records.entries()) {
      const event = ObservationEventSchema.parse(raw);
      if (event.sequence !== sequence) throw new Error('Observation event order mismatch');
      log.append(event);
    }
    return log;
  }
}

export const ObservationStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('observational'), inputProvenance: z.literal('unverified'),
    autonomousEligible: z.literal(false), eventIds: z.array(id) }),
  z.strictObject({ state: z.literal('unobserved'), autonomousEligible: z.literal(false), eventIds: z.tuple([]) }),
  z.strictObject({ state: z.literal('no_intervention'), autonomousEligible: z.literal(true), eventIds: z.tuple([]) }),
  z.strictObject({ state: z.literal('intervened'), autonomousEligible: z.literal(false), eventIds: z.array(id).min(1) }),
]);

const effectiveProfile = z.strictObject({
  profile: ExecutionProfileSchema, policy: NetworkPolicySchema, fingerprint,
});
const executionRun = z.strictObject({
  executionRunId: id, effectiveProfile,
  versions: z.strictObject({ node: z.string(), playwright: z.string(), browser: z.string() }),
  outcomes: z.array(ResultRecordSchema),
});
const handoff = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stopped'), result: ResultRecordSchema, attemptId: id.optional() }),
  z.strictObject({
    kind: z.literal('executed'), testSpec: TestSpecSchema,
    resolvedSpecId: id, attemptId: id, replay: z.tuple([executionRun, executionRun]),
  }),
]);

export const LocalReportAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('available'), artifactRoot: z.string().min(1), testSpecId: id }),
]);

/** Handoff remains the typed engine result; observations are separate metadata. */
export const LocalWorkflowOutcomeSchema = z.strictObject({
  testSpecId: id,
  executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: fingerprint,
  presentationMode: z.enum(['headless', 'headed']),
  handoff,
  report: LocalReportAvailabilitySchema,
  observation: ObservationStateSchema,
}).superRefine((outcome, context) => {
  if ((outcome.presentationMode === 'headed') !== (outcome.observation.state === 'observational')) {
    context.addIssue({ code: 'custom', path: ['observation'],
      message: 'Headed outcomes require unverified observational provenance' });
  }
  if (outcome.handoff.kind === 'stopped' && outcome.handoff.result.testSpecId !== outcome.testSpecId) {
    context.addIssue({ code: 'custom', path: ['handoff'], message: 'Stopped result TestSpec ID mismatch' });
  }
  if (outcome.handoff.kind === 'executed' && (
    outcome.handoff.testSpec.testSpecId !== outcome.testSpecId ||
    JSON.stringify(outcome.handoff.testSpec.executionProfileRef) !== JSON.stringify(outcome.executionProfileRef) ||
    outcome.handoff.replay.some((run) => run.effectiveProfile.fingerprint !== outcome.profileFingerprint)
  )) context.addIssue({ code: 'custom', path: ['handoff'], message: 'Executed handoff correlation mismatch' });
  if (outcome.report.kind === 'available' && outcome.report.testSpecId !== outcome.testSpecId) {
    context.addIssue({ code: 'custom', path: ['report'], message: 'Report TestSpec ID mismatch' });
  }
  if (outcome.handoff.kind === 'executed' && outcome.report.kind !== 'available') {
    context.addIssue({ code: 'custom', path: ['report'], message: 'Executed handoff requires a stored report' });
  }
});
export type LocalWorkflowOutcome = z.infer<typeof LocalWorkflowOutcomeSchema> & { handoff: HandoffOutcome };
