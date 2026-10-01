import { randomUUID } from 'node:crypto';
import {
  parseExplorationAttemptV3, parseSuccessfulExplorationTraceV1,
  parseSuccessfulExplorationTraceV2, parseTestSpec,
  SuccessfulPathRecordV1Schema, SuccessfulPathRecordV2Schema,
  type ExplorationAttemptV3, type ExplorationTargetBindingV1,
  type SuccessfulExplorationTraceV1, type SuccessfulExplorationTraceV2,
  type SuccessfulPathRecordV1, type SuccessfulPathRecordV2, type TraceBindingV2,
} from '../domain/index.js';

export type CurrentStateActionFact = Readonly<{
  binding: ExplorationTargetBindingV1; record: SuccessfulPathRecordV1;
}>;

/** Private assembly boundary. M7 will supply observed non-target records and the complete WP2A journal. */
export class SuccessfulTraceAssembler {
  readonly #source;
  readonly #attemptId: string;
  readonly #profileFingerprint: string;
  readonly #sessionId: string;
  readonly #startedAt: string;
  readonly #startStateDigest: string;
  readonly #actionJournal: () => readonly CurrentStateActionFact[];
  readonly #traceVersion: '1' | '2';
  readonly #traceBinding: ((binding: ExplorationTargetBindingV1) => TraceBindingV2) | undefined;
  readonly #path: (SuccessfulPathRecordV1 | SuccessfulPathRecordV2)[] = [];
  readonly #bindings: (ExplorationTargetBindingV1 | TraceBindingV2)[] = [];
  readonly #actions: CurrentStateActionFact[] = [];
  #finalized = false;

  get currentStateDigest(): string {
    return this.#path.at(-1)?.postStateDigest ?? this.#startStateDigest;
  }

  constructor(sourceInput: unknown, owner: {
    explorationAttemptId: string; profileFingerprint: string; sessionId: string;
    startedAt: string; startStateDigest: string;
    actionJournal: () => readonly CurrentStateActionFact[];
    traceVersion?: '1' | '2';
    traceBinding?: (binding: ExplorationTargetBindingV1) => TraceBindingV2;
  }) {
    this.#source = parseTestSpec(sourceInput);
    this.#attemptId = owner.explorationAttemptId;
    this.#profileFingerprint = owner.profileFingerprint;
    this.#sessionId = owner.sessionId;
    this.#startedAt = owner.startedAt;
    this.#startStateDigest = owner.startStateDigest;
    this.#actionJournal = owner.actionJournal;
    this.#traceVersion = owner.traceVersion ?? '1';
    this.#traceBinding = owner.traceBinding;
    if (this.#traceVersion === '2' && !this.#traceBinding)
      throw new Error('V2 assembly requires protected frame capture');
  }

  #append(input: SuccessfulPathRecordV1 | SuccessfulPathRecordV2,
    binding?: ExplorationTargetBindingV1): void {
    if (this.#finalized) throw new Error('Successful trace already finalized');
    const effect = input.preStateDigest === input.postStateDigest ? 'state_unchanged' : 'state_changed';
    if (input.observedEffect !== undefined && input.observedEffect !== effect)
      throw new Error('Observed effect contradicts protected state digests');
    const record = (this.#traceVersion === '2' ? SuccessfulPathRecordV2Schema :
      SuccessfulPathRecordV1Schema).parse({ ...input, observedEffect: effect });
    if (record.sequence !== this.#path.length + 1 ||
      record.preStateDigest !== (this.#path.at(-1)?.postStateDigest ?? this.#startStateDigest))
      throw new Error('Successful path ordering or state chain mismatch');
    if (binding) {
      if (!('bindingId' in record) || record.bindingId !== binding.bindingId ||
        binding.testSpecId !== this.#source.testSpecId || binding.explorationAttemptId !== this.#attemptId ||
        binding.sessionId !== this.#sessionId || binding.profileFingerprint !== this.#profileFingerprint ||
        JSON.stringify(binding.executionProfileRef) !== JSON.stringify(this.#source.executionProfileRef) ||
        binding.originStepId !== record.originStepId ||
        binding.operation !== (input.type === 'state_observed' ? 'wait_for' : record.type))
        throw new Error('Current-state action binding correlation mismatch');
      const captured = this.#traceVersion === '2' ? this.#traceBinding!(binding) : binding;
      if (this.#traceVersion === '2' && !('frameOwnership' in captured))
        throw new Error('V2 binding lacks protected frame provenance');
      this.#bindings.push(structuredClone(captured));
    } else if ('bindingId' in record && record.bindingId) {
      throw new Error('Targeted successful record requires a validated current-state action fact');
    }
    this.#path.push(structuredClone(record));
  }

  /** Append only facts returned by WP2A, never a model-authored action claim. */
  appendCurrentStateAction(fact: CurrentStateActionFact,
    prerequisiteReasonCode?: 'expose_target' | 'reach_state'): void {
    if (!['click', 'fill', 'select_option'].includes(fact.record.type))
      throw new Error('WP2A journal contains an unsupported action');
    if ((fact.record.source === 'discoveredPrerequisite') !== (prerequisiteReasonCode !== undefined))
      throw new Error('Discovered prerequisite reason linkage mismatch');
    // WP2A sequences its mutation journal independently. Navigation, waits,
    // and assertions occupy positions in the complete successful path.
    this.#append({ ...fact.record, sequence: this.#path.length + 1,
      ...(prerequisiteReasonCode ? { prerequisiteReasonCode } : {}) }, fact.binding);
    this.#actions.push(structuredClone(fact));
  }

  /** M7 supplies observed navigation, wait, and assertion facts from the protected session. */
  appendObservedRecord(input: SuccessfulPathRecordV1 | SuccessfulPathRecordV2,
    binding?: ExplorationTargetBindingV1): void {
    if (input.type === 'click' || input.type === 'fill' || input.type === 'select_option')
      throw new Error('Mutation requires the WP2A journal');
    this.#append(input, binding);
  }

  /** Attach only private evidence references; store finalization checks descriptor ownership. */
  attachEvidence(recordId: string, evidenceRefs: readonly string[]): void {
    if (this.#finalized) throw new Error('Successful trace already finalized');
    const index = this.#path.findIndex((record) => record.recordId === recordId);
    if (index < 0) throw new Error('Successful path record not found');
    this.#path[index] = (this.#traceVersion === '2' ? SuccessfulPathRecordV2Schema :
      SuccessfulPathRecordV1Schema).parse({
      ...this.#path[index], evidenceRefs: [...evidenceRefs],
    });
  }

  finalize(input: { finishedAt: string;
    successfulTraceId?: string }): { attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV1 } {
    if (this.#traceVersion !== '1') throw new Error('Use v2 finalization for v2 assembly');
    const bundle = this.#finalize(input);
    return { attempt: bundle.attempt, trace: bundle.trace as SuccessfulExplorationTraceV1 };
  }

  finalizeV2(input: { finishedAt: string;
    successfulTraceId?: string }): { attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV2 } {
    if (this.#traceVersion !== '2') throw new Error('Use v1 finalization for v1 assembly');
    const bundle = this.#finalize(input);
    return { attempt: bundle.attempt, trace: bundle.trace as SuccessfulExplorationTraceV2 };
  }

  #finalize(input: { finishedAt: string;
    successfulTraceId?: string }): { attempt: ExplorationAttemptV3;
      trace: SuccessfulExplorationTraceV1 | SuccessfulExplorationTraceV2 } {
    if (this.#finalized) throw new Error('Successful trace already finalized');
    const journal = this.#actionJournal();
    if (this.#actions.length !== journal.length || this.#actions.some((fact, index) =>
      JSON.stringify(fact.binding) !== JSON.stringify(journal[index]?.binding) ||
      JSON.stringify(fact.record) !== JSON.stringify(journal[index]?.record)))
      throw new Error('Performed WP2A mutation missing from successful path');
    const traceId = input.successfulTraceId ?? `trace-${randomUUID()}`;
    const owner = { testSpecId: this.#source.testSpecId, explorationAttemptId: this.#attemptId,
      executionProfileRef: this.#source.executionProfileRef, profileFingerprint: this.#profileFingerprint };
    const attempt = parseExplorationAttemptV3({ attemptVersion: '3', ...owner,
      status: 'path_established', successfulTraceId: traceId,
      startedAt: this.#startedAt, finishedAt: input.finishedAt }, this.#source);
    if (this.#traceVersion === '2' && this.#bindings.some((binding) =>
      !('frameOwnership' in binding) || binding.frameOwnership.kind === 'unproven'))
      throw new Error('Required target frame ownership is unproven');
    const rawTrace = { traceVersion: this.#traceVersion, successfulTraceId: traceId,
      ...owner, sessionId: this.#sessionId, startStateDigest: this.#startStateDigest,
      finalStateDigest: this.#path.at(-1)?.postStateDigest ?? this.#startStateDigest,
      startedAt: this.#startedAt, finishedAt: input.finishedAt,
      bindings: this.#bindings, successfulPath: this.#path,
      completedOriginStepIds: this.#source.steps.map((step) => step.id) };
    const trace = this.#traceVersion === '2' ?
      parseSuccessfulExplorationTraceV2(rawTrace, this.#source, attempt) :
      parseSuccessfulExplorationTraceV1(rawTrace, this.#source, attempt);
    this.#finalized = true;
    return { attempt: structuredClone(attempt), trace: structuredClone(trace) };
  }
}
