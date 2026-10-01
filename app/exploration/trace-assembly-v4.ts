import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  parseExplorationAttemptV3, parseSuccessfulExplorationTraceV4, parseTestSpec,
  SuccessfulPathRecordV2Schema, SuccessfulVerificationRecordV3Schema,
  TrustedObservationResultV1Schema,
  ActionIdentityWitnessV1Schema, parseActionIdentityWitnessV1,
  type ExplorationAttemptV3, type ExplorationTargetBindingV1,
  type ProtectedTraceActionIdentitySourceV4, type SuccessfulExplorationTraceV4,
  type ActionIdentityWitnessV1,
  type SuccessfulPathRecordV2, type SuccessfulVerificationRecordV3,
  type TraceBindingV2, type TrustedObservationResultV1,
} from '../domain/index.js';
import { parseSuccessfulVerificationStrategyV1,
  type SuccessfulVerificationStrategyV1 } from '../interpretation/verification-strategy.js';
import { type CurrentStateExploration } from './current-state.js';
import { type TrustedObservationSessionV1,
  verifyTrustedObservationWitnessV1 } from './trusted-observation.js';
import type { CurrentStateActionFact } from './trace-assembly.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Restricted protected-source material, stored with the trace as one immutable artifact. */
export const ProtectedTraceCaptureBundleV4Schema = z.strictObject({
  captureVersion: z.literal('1'), testSpecId: id, explorationAttemptId: id,
  successfulTraceId: id, sessionId: id, profileFingerprint: digest,
  observations: z.array(z.strictObject({
    record: TrustedObservationResultV1Schema, actionOrdinal: z.number().int().nonnegative(),
    pathPosition: z.number().int().nonnegative(), pathStateDigest: digest,
    currentAtCapture: z.boolean(),
  })).max(80),
  strategies: z.array(z.unknown()).max(80),
  currentAtGoal: z.array(z.strictObject({ goalStepId: id, observationId: id })).max(80),
  actionWitnesses: z.array(ActionIdentityWitnessV1Schema).max(80),
});
export type ProtectedTraceCaptureBundleV4 = z.infer<typeof ProtectedTraceCaptureBundleV4Schema>;

/** Readback source only. Creation authority remains with the runtime-owned assembler. */
export function parseProtectedTraceCaptureBundleV4(input: unknown, trace: SuccessfulExplorationTraceV4):
  { bundle: ProtectedTraceCaptureBundleV4; source: ProtectedTraceActionIdentitySourceV4 } {
  const bundle = ProtectedTraceCaptureBundleV4Schema.parse(input);
  if (bundle.testSpecId !== trace.testSpecId ||
      bundle.explorationAttemptId !== trace.explorationAttemptId ||
      bundle.successfulTraceId !== trace.successfulTraceId ||
      bundle.sessionId !== trace.sessionId ||
      bundle.profileFingerprint !== trace.profileFingerprint)
    throw new Error('Protected capture bundle ownership mismatch');
  const captures = new Map<string, ProtectedTraceCaptureBundleV4['observations'][number]>();
  for (const entry of bundle.observations) {
    if (captures.has(entry.record.observationId) || !entry.currentAtCapture)
      throw new Error('Duplicate or ineligible protected observation capture');
    verifyTrustedObservationWitnessV1(entry.record);
    captures.set(entry.record.observationId, entry);
  }
  const strategies = new Map<string, SuccessfulVerificationStrategyV1>();
  for (const value of bundle.strategies) {
    const strategy = parseSuccessfulVerificationStrategyV1(value);
    if (strategies.has(strategy.goalStepId)) throw new Error('Duplicate successful strategy');
    strategies.set(strategy.goalStepId, strategy);
  }
  const goalFreshness = new Map<string, string>();
  for (const entry of bundle.currentAtGoal) {
    if (goalFreshness.has(entry.goalStepId) || !captures.has(entry.observationId))
      throw new Error('Invalid goal-time freshness attestation');
    goalFreshness.set(entry.goalStepId, entry.observationId);
  }
  const verificationRecords = trace.successfulPath.filter((entry) => entry.type === 'verification_goal');
  const expectedGoals = verificationRecords.map((entry) => entry.goalStepId);
  const expectedObservations = new Set(verificationRecords.flatMap((entry) => entry.observationIds));
  if (strategies.size !== expectedGoals.length || goalFreshness.size !== expectedGoals.length ||
      captures.size !== expectedObservations.size ||
      expectedGoals.some((goal) => !strategies.has(goal) || !goalFreshness.has(goal)) ||
      [...captures.keys()].some((observationId) => !expectedObservations.has(observationId)))
    throw new Error('Protected capture contains missing or abandoned strategy facts');
  const witnesses = new Map<string, ActionIdentityWitnessV1>();
  for (const input of bundle.actionWitnesses) {
    const witness = parseActionIdentityWitnessV1(input);
    if (witnesses.has(witness.bindingId)) throw new Error('Duplicate protected action witness');
    witnesses.set(witness.bindingId, witness);
  }
  const expectedBindings = trace.actionIdentityProofs.map((proof) => proof.selectedWitness.bindingId);
  if (witnesses.size !== expectedBindings.length || expectedBindings.some((bindingId) =>
      !witnesses.has(bindingId)))
    throw new Error('Protected capture contains missing or abandoned action witnesses');
  const source: ProtectedTraceActionIdentitySourceV4 = {
    readObservation(observationId, goalStepId) {
      const capture = captures.get(observationId);
      return capture ? { ...structuredClone(capture),
        currentAtGoal: goalFreshness.get(goalStepId) === observationId } : undefined;
    },
    readStrategy(goalStepId) {
      const strategy = strategies.get(goalStepId);
      return strategy ? structuredClone(strategy) : undefined;
    },
    readActionWitness(bindingId) {
      const witness = witnesses.get(bindingId);
      return witness ? structuredClone(witness) : undefined;
    },
  };
  return { bundle, source };
}

const assemblyToken = Symbol('protected-trace-v4-assembly');
export class AssembledSuccessfulTraceV4 {
  readonly #attempt: ExplorationAttemptV3;
  readonly #trace: SuccessfulExplorationTraceV4;
  readonly #capture: ProtectedTraceCaptureBundleV4;
  constructor(token: symbol, attempt: ExplorationAttemptV3, trace: SuccessfulExplorationTraceV4,
    capture: ProtectedTraceCaptureBundleV4) {
    if (token !== assemblyToken) throw new Error('Protected assembler authority required');
    this.#attempt = structuredClone(attempt);
    this.#trace = structuredClone(trace);
    this.#capture = structuredClone(capture);
  }
  /** The store revalidates this exact restricted payload against its job and profile. */
  protectedArtifact(): { attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV4;
    capture: ProtectedTraceCaptureBundleV4 } {
    return { attempt: structuredClone(this.#attempt), trace: structuredClone(this.#trace),
      capture: structuredClone(this.#capture) };
  }
}

type CompletionState = 'running' | 'cancelled' | 'budget_exhausted' | 'failed';

/** Private v4 assembler. It never invokes the v2 compiler or deterministic runner. */
export class SuccessfulTraceAssemblerV4 {
  readonly #source;
  readonly #current: CurrentStateExploration;
  readonly #observations: TrustedObservationSessionV1;
  readonly #journal: () => readonly SuccessfulVerificationStrategyV1[];
  readonly #completionState: () => CompletionState;
  readonly #signal: AbortSignal;
  readonly #startedAt: string;
  readonly #startStateDigest: string;
  readonly #profileFingerprint: string;
  readonly #path: (SuccessfulPathRecordV2 | SuccessfulVerificationRecordV3)[] = [];
  readonly #bindings: TraceBindingV2[] = [];
  readonly #actions: CurrentStateActionFact[] = [];
  readonly #actionProofs: SuccessfulExplorationTraceV4['actionIdentityProofs'] = [];
  readonly #usedGoals = new Set<string>();
  readonly #captures = new Map<string, ProtectedTraceCaptureBundleV4['observations'][number]>();
  readonly #freshGoals = new Map<string, string>();
  readonly #stopCapture: () => void;
  #finalized = false;

  constructor(sourceInput: unknown, owner: {
    current: CurrentStateExploration; observations: TrustedObservationSessionV1;
    strategyJournal: () => readonly SuccessfulVerificationStrategyV1[];
    startedAt: string; startStateDigest: string; profileFingerprint: string;
    signal: AbortSignal; completionState: () => CompletionState;
  }) {
    this.#source = parseTestSpec(sourceInput);
    if (this.#source.schemaVersion !== '5' ||
      !same(this.#source, owner.current.source)) throw new Error('V4 assembly requires owned TestSpec v5');
    this.#current = owner.current;
    this.#observations = owner.observations;
    this.#journal = owner.strategyJournal;
    this.#completionState = owner.completionState;
    this.#signal = owner.signal;
    this.#startedAt = owner.startedAt;
    this.#startStateDigest = owner.startStateDigest;
    this.#profileFingerprint = owner.profileFingerprint;
    this.#stopCapture = owner.observations.onProtectedRecord((record) => {
      if (this.#finalized || record.status !== 'complete' || record.result.kind === 'snapshot') return;
      verifyTrustedObservationWitnessV1(record);
      if (record.testSpecId !== this.#source.testSpecId ||
          record.explorationAttemptId !== this.#current.attemptId ||
          record.sessionId !== this.#current.sessionId ||
          record.profileFingerprint !== this.#profileFingerprint ||
          !same(record.executionProfileRef, this.#source.executionProfileRef))
        throw new Error('Observation capture owner mismatch');
      if (this.#current.currentObservedPathDigest() !== this.currentStateDigest)
        throw new Error('Observation captured before successful path reached current state');
      this.#captures.set(record.observationId, {
        record: structuredClone(record), actionOrdinal: this.#current.successfulActions.length,
        pathPosition: this.#path.length, pathStateDigest: this.currentStateDigest,
        currentAtCapture: true,
      });
    });
  }

  get currentStateDigest(): string {
    return this.#path.at(-1)?.postStateDigest ?? this.#startStateDigest;
  }

  #append(input: SuccessfulPathRecordV2, binding?: ExplorationTargetBindingV1): void {
    if (this.#finalized || this.#signal.aborted || this.#completionState() !== 'running')
      throw new Error('V3 assembly is no longer active');
    const effect = input.preStateDigest === input.postStateDigest ? 'state_unchanged' : 'state_changed';
    if (input.observedEffect !== undefined && input.observedEffect !== effect)
      throw new Error('Observed effect contradicts protected state digests');
    const record = SuccessfulPathRecordV2Schema.parse({ ...input,
      sequence: this.#path.length + 1, observedEffect: effect });
    if (record.preStateDigest !== this.currentStateDigest)
      throw new Error('Successful path state chain mismatch');
    if (binding) {
      if (!('bindingId' in record) || record.bindingId !== binding.bindingId ||
          binding.testSpecId !== this.#source.testSpecId ||
          binding.explorationAttemptId !== this.#current.attemptId ||
          binding.sessionId !== this.#current.sessionId ||
          binding.profileFingerprint !== this.#profileFingerprint ||
          !same(binding.executionProfileRef, this.#source.executionProfileRef) ||
          binding.originStepId !== record.originStepId ||
          binding.operation !== (record.type === 'state_observed' ? 'wait_for' : record.type))
        throw new Error('V3 action binding correlation mismatch');
      const captured = this.#current.traceBinding(binding);
      if (captured.frameOwnership.kind === 'unproven')
        throw new Error('V3 action frame ownership unproven');
      this.#bindings.push(captured);
    } else if ('bindingId' in record && record.bindingId)
      throw new Error('Targeted record lacks protected action fact');
    this.#path.push(structuredClone(record));
  }

  appendCurrentStateAction(fact: CurrentStateActionFact,
    reason?: 'expose_target' | 'reach_state'): void {
    if (!['click', 'fill', 'select_option'].includes(fact.record.type))
      throw new Error('Unsupported action journal fact');
    const journalFact = this.#current.successfulActions[this.#actions.length];
    if (!journalFact || !same({ binding: journalFact.binding, record: journalFact.record },
      { binding: fact.binding, record: fact.record }) ||
        (fact.record.source === 'discoveredPrerequisite') !== (reason !== undefined))
      throw new Error('Action is absent from protected current-state journal');
    let actionProof: SuccessfulExplorationTraceV4['actionIdentityProofs'][number] | undefined;
    if (fact.record.source === 'authored') {
      const authored = this.#source.steps.find((step) => step.id === fact.record.originStepId);
      if (!authored || (authored.type !== 'click' && authored.type !== 'fill' &&
          authored.type !== 'select_option') || !authored.actionTargetIntent)
        throw new Error('Authored action has no requested target identity');
      const witness = this.#current.traceActionIdentityWitness(fact.binding);
      if (!journalFact.identityWitness || !same(journalFact.identityWitness, witness) ||
          !same(witness.requestedIntent, authored.actionTargetIntent) ||
          witness.operation !== fact.record.type || witness.sourceStepId !== authored.id ||
          witness.selectedRef !== fact.binding.selectedRef ||
          witness.stateDigest !== fact.record.preStateDigest)
        throw new Error('Protected action journal identity mismatch');
      actionProof = { recordId: fact.record.recordId,
        requestedIntent: structuredClone(authored.actionTargetIntent),
        selectedWitness: witness };
    } else if (journalFact.identityWitness)
      throw new Error('Prerequisite claimed authored target identity');
    this.#append({ ...fact.record, ...(reason ? { prerequisiteReasonCode: reason } : {}) } as
      SuccessfulPathRecordV2, fact.binding);
    if (actionProof) this.#actionProofs.push(actionProof);
    this.#actions.push(structuredClone({ binding: fact.binding, record: fact.record }));
  }

  /** Navigation/wait/legacy assertion records follow the existing protected v2 path. */
  async appendObservedRecord(input: SuccessfulPathRecordV2,
    binding?: ExplorationTargetBindingV1): Promise<void> {
    if (['click', 'fill', 'select_option'].includes(input.type))
      throw new Error('Mutation requires protected current-state journal');
    const observed = await this.#current.verifyObservedPathState(input.postStateDigest);
    if (input.type === 'navigate' && input.url !== observed.url)
      throw new Error('Navigation URL differs from protected browser state');
    if (input.observationDigest !== observed.snapshotDigest)
      throw new Error('Observed record snapshot witness differs from protected browser state');
    this.#append(input, binding);
  }

  /** Attach only a completed WP3A strategy whose latest operand is current now. */
  async appendVerificationGoal(goalStepId: string): Promise<SuccessfulVerificationRecordV3> {
    if (this.#finalized || this.#signal.aborted || this.#completionState() !== 'running' ||
        this.#usedGoals.has(goalStepId)) throw new Error('Goal cannot be appended');
    const goal = this.#source.steps.find((step) => step.id === goalStepId);
    if (!goal || goal.type !== 'verification_goal') throw new Error('Unknown VerificationGoal');
    const matches = this.#journal().filter((strategy) => strategy.goalStepId === goalStepId);
    if (matches.length !== 1) throw new Error('Goal lacks one successful strategy');
    const strategy = parseSuccessfulVerificationStrategyV1(matches[0]);
    if (strategy.testSpecId !== this.#source.testSpecId ||
        strategy.explorationAttemptId !== this.#current.attemptId ||
        strategy.sessionId !== this.#current.sessionId ||
        strategy.actionOrdinal !== this.#current.successfulActions.length)
      throw new Error('Strategy owner or action ordinal mismatch');
    const ids = strategy.observationIds;
    const records: TrustedObservationResultV1[] = [];
    for (const id of ids) {
      const capture = this.#captures.get(id);
      const runtime = this.#observations.protectedRecord(id);
      if (!capture || !runtime || !same(runtime, capture.record))
        throw new Error('Strategy references an unowned observation');
      verifyTrustedObservationWitnessV1(runtime);
      records.push(runtime);
    }
    const latest = records.at(-1)!;
    await this.#current.verifyObservedPathState(this.currentStateDigest);
    if (!(await this.#observations.currentEvidence(latest)) ||
        this.#captures.get(latest.observationId)?.pathPosition !== this.#path.length ||
        this.#captures.get(latest.observationId)?.pathStateDigest !== this.currentStateDigest)
      throw new Error('Latest verification evidence is stale');
    const temporal = strategy.comparison.kind === 'transition' ? {
      earlierObservationId: strategy.comparison.earlierObservationId,
      laterObservationId: strategy.comparison.laterObservationId,
      transitionRecordIds: this.#path.slice(this.#captures.get(ids[0]!)!.pathPosition)
        .filter((entry) => entry.preStateDigest !== entry.postStateDigest)
        .map((entry) => entry.recordId),
    } : undefined;
    const record = SuccessfulVerificationRecordV3Schema.parse({
      type: 'verification_goal', recordId: `record-${randomUUID()}`,
      sequence: this.#path.length + 1, source: 'authored', originStepId: goal.id,
      goalStepId: goal.id, goalDigest: hash(goal),
      preStateDigest: this.currentStateDigest, postStateDigest: this.currentStateDigest,
      strategyDigest: strategy.strategyDigest, actionOrdinal: strategy.actionOrdinal,
      observationIds: ids, observations: records, comparison: strategy.comparison,
      evaluated: strategy.evaluated, conclusion: strategy.conclusion,
      ...(temporal ? { temporal } : {}),
    });
    this.#freshGoals.set(goalStepId, latest.observationId);
    this.#path.push(record);
    this.#usedGoals.add(goalStepId);
    return structuredClone(record);
  }

  finalize(input: { finishedAt: string; successfulTraceId?: string }): AssembledSuccessfulTraceV4 {
    if (this.#finalized || this.#signal.aborted || this.#completionState() !== 'running')
      throw new Error('Cancelled, budget-exhausted, failed, or finalized path');
    const actionJournal = this.#current.successfulActions;
    if (this.#actions.length !== actionJournal.length ||
        this.#actions.some((fact, index) => !same(fact, {
          binding: actionJournal[index]?.binding, record: actionJournal[index]?.record })))
      throw new Error('Protected action journal is not fully represented');
    const strategies = this.#journal().map(parseSuccessfulVerificationStrategyV1);
    if (strategies.length !== this.#usedGoals.size ||
        strategies.some((strategy) => !this.#usedGoals.has(strategy.goalStepId)))
      throw new Error('Successful verification journal is not fully represented');
    const traceId = input.successfulTraceId ?? `trace-${randomUUID()}`;
    const owner = { testSpecId: this.#source.testSpecId,
      explorationAttemptId: this.#current.attemptId,
      executionProfileRef: this.#source.executionProfileRef,
      profileFingerprint: this.#profileFingerprint };
    const attempt = parseExplorationAttemptV3({ attemptVersion: '3', ...owner,
      status: 'path_established', successfulTraceId: traceId,
      startedAt: this.#startedAt, finishedAt: input.finishedAt }, this.#source);
    const traceInput = { traceVersion: '4', successfulTraceId: traceId, ...owner,
      sessionId: this.#current.sessionId,
      startStateDigest: this.#startStateDigest, finalStateDigest: this.currentStateDigest,
      startedAt: this.#startedAt, finishedAt: input.finishedAt,
      bindings: this.#bindings, successfulPath: this.#path,
      actionIdentityProofs: this.#actionProofs,
      completedOriginStepIds: this.#source.steps.map((step) => step.id) };
    const capture: ProtectedTraceCaptureBundleV4 = ProtectedTraceCaptureBundleV4Schema.parse({
      captureVersion: '1', testSpecId: this.#source.testSpecId,
      explorationAttemptId: this.#current.attemptId, successfulTraceId: traceId,
      sessionId: this.#current.sessionId, profileFingerprint: this.#profileFingerprint,
      observations: [...this.#captures.values()].filter((entry) =>
        strategies.some((strategy) => strategy.observationIds.includes(entry.record.observationId))),
      strategies, currentAtGoal: [...this.#freshGoals].map(([goalStepId, observationId]) =>
        ({ goalStepId, observationId })),
      actionWitnesses: this.#actionProofs.map((proof) => proof.selectedWitness),
    });
    const preliminary = { ...traceInput } as SuccessfulExplorationTraceV4;
    const source = parseProtectedTraceCaptureBundleV4(capture, preliminary).source;
    const trace = parseSuccessfulExplorationTraceV4(traceInput, this.#source, attempt, source);
    this.#finalized = true;
    this.#stopCapture();
    return new AssembledSuccessfulTraceV4(assemblyToken, attempt, trace, capture);
  }
}
