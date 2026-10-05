import { ProtectedTraceCaptureBundleV5Schema, parseProtectedTraceCaptureBundleV5, type ProtectedTraceCaptureBundleV5 } from '../domain/trace-capture-v5.js';
import { createHash, randomUUID } from 'node:crypto';
import { ActionCandidateGroundingSessionV1 } from './action-candidate-grounding.js';
import { TrustedObservationSessionV1 } from './trusted-observation.js';
import { GoalDirectedVerificationControllerV1 } from '../interpretation/verification-strategy.js';
import { requireTrustedSemanticAdmissionV2, validateSemanticAdmissionReadbackV2, buildActionObligationHandoffV2,
  type TrustedSemanticAdmissionV2 } from '../domain/action-semantic-admission.js';
import { requireTrustedGroundingMappingV1 } from '../domain/action-grounding-strategy.js';
import { parseActionGroundingWitnessV1 } from '../domain/action-grounding-execution.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { type SuccessfulExplorationTraceV5, type SuccessfulPathRecordV5,
  type TraceStateV5, TraceStateV5Schema } from '../domain/agentic-trace-v5.js';
import { successfulTraceDigestV5 } from '../domain/agentic-trace-v5.js';
import { SuccessfulVerificationRecordV3Schema } from '../domain/agentic-trace-v3.js';
import { NativeOptionObservationSessionV2 } from './native-option-observation.js';
import { NativeOptionVerificationControllerV2 } from '../interpretation/native-option-verification-controller.js';
import {NativeOptionVerificationRecordV5Schema,type NativeOptionObservationV2} from '../domain/native-option-verification.js';

const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const requireFact = (value: boolean, message: string): void => { if (!value) throw new Error(message); };
export { ProtectedTraceCaptureBundleV5Schema, parseProtectedTraceCaptureBundleV5 } from '../domain/trace-capture-v5.js';
export type { ProtectedTraceCaptureBundleV5 } from '../domain/trace-capture-v5.js';

const assembled = new WeakSet<object>(), token = Symbol('trace-v5-assembly');
export class AssembledSuccessfulTraceV5 {
  readonly #artifact;
  constructor(authority: symbol, artifact: { trace: SuccessfulExplorationTraceV5; capture: ProtectedTraceCaptureBundleV5 }) {
    if (authority !== token) throw new Error('V5 protected assembly authority required');
    this.#artifact = structuredClone(artifact); assembled.add(this);
  }
  protectedArtifact() { return structuredClone(this.#artifact); }
}
export function requireAssembledSuccessfulTraceV5(input: AssembledSuccessfulTraceV5) {
  if (!assembled.has(input)) throw new Error('Untrusted v5 assembler output');
  return AssembledSuccessfulTraceV5.prototype.protectedArtifact.call(input);
}

type State = Awaited<ReturnType<ActionCandidateGroundingSessionV1['protectedTraceState']>>;
function statePoint(state: Pick<State, 'pageId' | 'stateDigest' | 'stateEpoch' | 'mutationEpoch'>,
  sessionId: string): TraceStateV5 {
  return TraceStateV5Schema.parse({ sessionId, pageId: state.pageId, stateDigest: state.stateDigest,
    stateEpoch: state.stateEpoch, mutationEpoch: state.mutationEpoch });
}
const assemblerToken = Symbol('trace-v5-owner');
export class SuccessfulTraceAssemblerV5 {
  readonly #runtime;
  readonly #admission;
  readonly #owner;
  readonly #observations;
  readonly #verification;
  readonly #signal;
  readonly #nativeObservations;
  readonly #nativeVerification;
  readonly #nativeCaptures=new Map<string,NonNullable<ProtectedTraceCaptureBundleV5['nativeObservations']>[number]>();
  readonly #nativeStrategies:NonNullable<ProtectedTraceCaptureBundleV5['nativeStrategies']>=[];
  readonly #stopNativeCapture;
  readonly #startedAt = new Date().toISOString();
  readonly #path: SuccessfulPathRecordV5[] = [];
  readonly #captures = new Map<string, ProtectedTraceCaptureBundleV5['observations'][number]>();
  readonly #strategies: ProtectedTraceCaptureBundleV5['strategies'] = [];
  readonly #actions: ProtectedTraceCaptureBundleV5['actions'] = [];
  readonly #fresh: ProtectedTraceCaptureBundleV5['currentAtGoal'] = [];
  readonly #stopCapture;
  #start: TraceStateV5;
  #current: TraceStateV5;
  #pendingGenericAction: number | undefined;
  #finalized = false;

  #resumeGenericAction(observation: { sessionId: string; pageId: string;
    stateDigest: string; stateEpoch: number; mutationEpoch: number; observedAt: string },
    reference: { observationId: string } | { nextActionWitnessId: string }): void {
    if (this.#pendingGenericAction === undefined) return;
    const index = this.#pendingGenericAction, record = this.#path[index];
    requireFact(record?.type === 'action_goal' && record.witness.postEffect.effect.kind === 'generic_activation' &&
      observation.sessionId === this.#owner.sessionId &&
      Date.parse(observation.observedAt) >= Date.parse(record.witness.execution.finishedAt) &&
      observation.stateEpoch > this.#current.stateEpoch && observation.mutationEpoch > this.#current.mutationEpoch,
      'V5 generic click continuation is not a later protected observation');
    if (!record || record.type !== 'action_goal') throw new Error('V5 generic action missing');
    const after = { sessionId: observation.sessionId, pageId: observation.pageId,
      stateDigest: observation.stateDigest, stateEpoch: observation.stateEpoch, mutationEpoch: observation.mutationEpoch };
    this.#path[index] = { ...record, postStateDigest: after.stateDigest,
      continuation: { ...reference, after } };
    this.#current = after;
    this.#pendingGenericAction = undefined;
  }

  /** Use create: start and owner fields are never caller-authored provenance. */
  private constructor(authority: symbol, runtime: ActionCandidateGroundingSessionV1, admission: TrustedSemanticAdmissionV2,
    initial: State, observations?: TrustedObservationSessionV1, verification?: GoalDirectedVerificationControllerV1, signal?: AbortSignal,nativeObservations?:NativeOptionObservationSessionV2,nativeVerification?:NativeOptionVerificationControllerV2) {
    if (authority !== assemblerToken) throw new Error('Protected v5 owner required');
    this.#runtime = runtime; this.#admission = admission;
    this.#owner = ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(runtime);
    requireFact(this.#owner.admission === admission, 'V5 admission runtime owner mismatch');
    this.#start = this.#current = statePoint(initial, this.#owner.sessionId);
    this.#observations = observations; this.#verification = verification; this.#signal = signal;
    this.#nativeObservations=nativeObservations;this.#nativeVerification=nativeVerification;
    this.#stopNativeCapture=nativeObservations?NativeOptionObservationSessionV2.prototype.onProtectedRecord.call(nativeObservations,(record)=>{
      if(this.#finalized||record.status!=='complete')return;
      this.#resumeGenericAction(record, { observationId: record.observationId });
      requireFact(record.sessionId===this.#owner.sessionId&&record.pageId===this.#current.pageId&&record.stateDigest===this.#current.stateDigest&&record.stateEpoch===this.#current.stateEpoch&&record.mutationEpoch===this.#current.mutationEpoch&&record.testSpecId===admission.spec.testSpecId&&record.explorationAttemptId===this.#owner.attemptId&&ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(runtime).length===this.#actions.length,'Native capture outside committed state');
      this.#nativeCaptures.set(record.observationId,{record,actionOrdinal:this.#actions.length,pathPosition:this.#path.length,pathStateDigest:this.#current.stateDigest,currentAtCapture:true});
    }):()=>{};
    this.#stopCapture = observations ? TrustedObservationSessionV1.prototype.onProtectedRecord.call(observations, (record) => {
      if (this.#finalized || record.status !== 'complete' || record.result.kind === 'snapshot') return;
      this.#resumeGenericAction(record, { observationId: record.observationId });
      requireFact(record.sessionId === this.#owner.sessionId && record.pageId === this.#current.pageId &&
        record.testSpecId === admission.spec.testSpecId && record.explorationAttemptId === this.#owner.attemptId &&
        record.stateDigest === this.#current.stateDigest && record.stateEpoch === this.#current.stateEpoch &&
        record.mutationEpoch === this.#current.mutationEpoch &&
        ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(runtime).length === this.#actions.length,
        'V5 observation outside committed protected state');
      this.#captures.set(record.observationId, { record, actionOrdinal: this.#actions.length,
        pathPosition: this.#path.length, pathStateDigest: this.#current.stateDigest, currentAtCapture: true });
    }) : () => {};
  }
  static async create(input: { runtime: ActionCandidateGroundingSessionV1; admission: TrustedSemanticAdmissionV2;
    observations?: TrustedObservationSessionV1; verification?: GoalDirectedVerificationControllerV1; signal?: AbortSignal;nativeObservations?:NativeOptionObservationSessionV2;nativeVerification?:NativeOptionVerificationControllerV2;
    aroundInitialObservation?: (read: () => Promise<void>) => Promise<void> }): Promise<SuccessfulTraceAssemblerV5> {
    requireTrustedSemanticAdmissionV2(input.admission);
    const owner = ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(input.runtime);
    requireFact(owner.admission === input.admission && !!input.observations === !!input.verification, 'V5 trace owner mismatch');
    if (input.observations) TrustedObservationSessionV1.prototype.protectedDeferredOwner.call(input.observations, input.runtime);
    if (input.verification) GoalDirectedVerificationControllerV1.prototype.protectedDeferredStrategy.call(input.verification, input.runtime, '__owner', input.observations);
    requireFact(!!input.nativeObservations===!!input.nativeVerification,'Native verifier owner pair required');
    if(input.nativeObservations)NativeOptionObservationSessionV2.prototype.owner.call(input.nativeObservations,input.runtime);
    if(input.nativeVerification)NativeOptionVerificationControllerV2.prototype.protectedStrategy.call(input.nativeVerification,input.runtime,'__owner');
    const initial = await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(input.runtime, input.aroundInitialObservation);
    requireFact(initial.page.url() === input.admission.spec.startState.url, 'V5 source start URL differs from protected state');
    requireFact(!ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(input.runtime).length,
      'V5 assembly must capture the successful path from its beginning');
    return new SuccessfulTraceAssemblerV5(assemblerToken, input.runtime, input.admission, initial,
      input.observations, input.verification, input.signal,input.nativeObservations,input.nativeVerification);
  }
  #active(): void {
    requireFact(!this.#finalized && !this.#signal?.aborted, 'V5 assembly completed/cancelled');
    ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(this.#runtime);
  }
  #step(type: 'action_goal' | 'verification_goal' | 'navigate', goalId: string) {
    this.#active(); const step = this.#admission.spec.steps[this.#path.length];
    requireFact(!!step && step.type === type && step.id === goalId, 'V5 authored goal order mismatch');
    return step!;
  }
  appendActionGroundingWitness(input: unknown): void {
    this.#active(); const witness = parseActionGroundingWitnessV1(input, this.#admission);
    this.#resumeGenericAction({ ...witness.postEffect.before, observedAt: witness.preparation.observedAt },
      { nextActionWitnessId: witness.witnessId });
    this.#step('action_goal', witness.preparation.goalId);
    const runtime = this.#runtime, journal = ActionCandidateGroundingSessionV1.prototype;
    const selected = journal.protectedSuccessfulGroundingWitnesses.call(runtime)[this.#actions.length];
    const readback = journal.protectedActionGroundingWitness.call(runtime, witness.witnessId);
    const mapping = journal.protectedGroundingMapping.call(runtime, witness.preparation.strategyId);
    const retirement = journal.protectedActionGroundingRetirement.call(runtime, witness.witnessId);
    requireFact(!!selected && same(selected, witness) && same(readback, witness) && !!mapping, 'V5 untrusted or abandoned witness');
    requireTrustedGroundingMappingV1(mapping!, this.#admission);
    const generic = witness.postEffect.effect.kind === 'generic_activation';
    requireFact(mapping!.mappingDigest === witness.preparation.mappingDigest && same(mapping!.correspondence, witness.preparation.correspondence) &&
      same(journal.protectedActionGroundingFinalCheck.call(runtime, witness.execution.executionId), witness.finalCheck) &&
      same(journal.protectedActionExecution.call(runtime, witness.execution.executionId), witness.execution) &&
      same(journal.protectedActionPostEffect.call(runtime, witness.postEffect.observationId), witness.postEffect) &&
      (generic ? !retirement : !!retirement),
      'V5 private finalcheck/execution/post/mapping readback mismatch');
    const { frameId: _beforeFrame, ...before } = witness.postEffect.before;
    const preceding = this.#path.at(-1);
    const urlFact = preceding?.type === 'verification_goal' && !('verificationVersion' in preceding)
      ? preceding.observations.at(-1) : undefined;
    const refreshed = !same(this.#current, before);
    requireFact(!refreshed || this.#admission.spec.semanticMode === 'poc_v1' &&
      urlFact?.status === 'complete' && urlFact.request.kind === 'current_url' &&
      urlFact.result.kind === 'url' && before.sessionId === this.#current.sessionId &&
      before.pageId === this.#current.pageId &&
      before.stateEpoch > this.#current.stateEpoch && before.mutationEpoch >= this.#current.mutationEpoch &&
      Date.parse(witness.preparation.observedAt) >= Date.parse(urlFact.observedAt),
      'V5 action state chain mismatch');
    const after = generic ? before : (() => { const { frameId: _afterFrame, ...state } = retirement!.after; return state; })();
    const record: SuccessfulPathRecordV5 = { type: 'action_goal', source: 'authored', recordId: `record-${randomUUID()}`,
      sequence: this.#path.length + 1, originStepId: witness.preparation.goalId,
      preStateDigest: this.#current.stateDigest, postStateDigest: after.stateDigest, witness,
      ...(refreshed && urlFact ? { stateRefresh: { fromObservationId: urlFact.observationId, after: before } } : {}),
      ...(retirement ? { retirement } : {}) };
    this.#actions.push({ recordId: record.recordId, witness, finalCheck: witness.finalCheck,
      execution: witness.execution, postEffect: witness.postEffect, ...(retirement ? { retirement } : {}), mappingDigest: mapping!.mappingDigest });
    this.#path.push(record); this.#current = after;
    if (generic) this.#pendingGenericAction = this.#path.length - 1;
  }
  /** Existing navigation is evidenced by fresh protected URL/state, never model text. */
  async appendObservedNavigation(stepId: string): Promise<void> {
    const step = this.#step('navigate', stepId);
    requireFact(step.type === 'navigate', 'V5 navigation source required');
    const state = await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime);
    requireFact(step.type === 'navigate' && state.page.url() === step.url, 'V5 authored navigation URL mismatch');
    const after = statePoint(state, this.#owner.sessionId);
    requireFact(after.stateEpoch > this.#current.stateEpoch && after.mutationEpoch > this.#current.mutationEpoch,
      'V5 navigation lacks renewed protected state');
    this.#path.push({ type: 'navigate', recordId: `record-${randomUUID()}`, sequence: this.#path.length + 1,
      source: 'authored', originStepId: step.id, preStateDigest: this.#current.stateDigest, postStateDigest: after.stateDigest,
      url: state.page.url(), before: this.#current, after, observedAt: new Date().toISOString() });
    this.#current = after;
  }
  async appendVerificationGoal(goalId: string): Promise<void> {
    const step = this.#step('verification_goal', goalId);
    if('verificationVersion' in step){
      requireFact(!!this.#nativeObservations&&!!this.#nativeVerification,'Native verification journal required');
      const strategy=NativeOptionVerificationControllerV2.prototype.protectedStrategy.call(this.#nativeVerification!,this.#runtime,goalId);
      requireFact(!!strategy&&strategy.actionOrdinal===this.#actions.length,'Native successful strategy required');
      const observation=NativeOptionObservationSessionV2.prototype.protectedRecord.call(this.#nativeObservations!,strategy!.observationIds[0]!);
      const captured=this.#nativeCaptures.get(strategy!.observationIds[0]!);
      requireFact(!!observation&&!!captured&&same(observation,captured.record)&&!!await NativeOptionObservationSessionV2.prototype.currentEvidence.call(this.#nativeObservations!,observation)&&captured.pathPosition===this.#path.length,'Native strategy stale/untrusted');
      const record=NativeOptionVerificationRecordV5Schema.parse({verificationVersion:'2',type:'verification_goal',recordId:`record-${randomUUID()}`,sequence:this.#path.length+1,source:'authored',originStepId:goalId,goalStepId:goalId,goalDigest:hash(step),preStateDigest:this.#current.stateDigest,postStateDigest:this.#current.stateDigest,strategyDigest:strategy!.strategyDigest,actionOrdinal:strategy!.actionOrdinal,observationIds:strategy!.observationIds,observations:[observation],comparison:strategy!.comparison,evaluated:strategy!.evaluated,conclusion:strategy!.conclusion,strategy});
      this.#path.push(record);this.#nativeStrategies.push(strategy!);this.#fresh.push({goalStepId:goalId,observationId:observation!.observationId});return;
    }
    requireFact(!!this.#observations && !!this.#verification && step.type === 'verification_goal', 'V5 successful verification owner required');
    const strategy = GoalDirectedVerificationControllerV1.prototype.protectedDeferredStrategy.call(this.#verification!, this.#runtime, goalId);
    requireFact(!!strategy && strategy.actionOrdinal === this.#actions.length, 'V5 completed verification strategy required');
    const observations = strategy!.observationIds.map((id) => {
      const captured = this.#captures.get(id);
      const read = TrustedObservationSessionV1.prototype.protectedRecord.call(this.#observations!, id);
      requireFact(!!captured && same(read, captured.record), 'V5 verification private observation readback mismatch');
      return captured!.record;
    });
    const latest = observations.at(-1)!;
    requireFact(!!await TrustedObservationSessionV1.prototype.currentEvidence.call(this.#observations!, latest) &&
      this.#captures.get(latest.observationId)?.pathPosition === this.#path.length && latest.stateDigest === this.#current.stateDigest,
      'V5 verification evidence stale at completion');
    const temporal = strategy!.comparison.kind === 'transition' ? {
      earlierObservationId: strategy!.comparison.earlierObservationId, laterObservationId: strategy!.comparison.laterObservationId,
      transitionRecordIds: this.#path.slice(this.#captures.get(observations[0]!.observationId)!.pathPosition)
        .filter((r) => r.preStateDigest !== r.postStateDigest).map((r) => r.recordId) } : undefined;
    const record = SuccessfulVerificationRecordV3Schema.parse({ type: 'verification_goal', recordId: `record-${randomUUID()}`,
      sequence: this.#path.length + 1, source: 'authored', originStepId: goalId, goalStepId: goalId,
      goalDigest: createHash('sha256').update(JSON.stringify(step)).digest('hex'),
      preStateDigest: this.#current.stateDigest, postStateDigest: this.#current.stateDigest,
      strategyDigest: strategy!.strategyDigest, actionOrdinal: strategy!.actionOrdinal, observationIds: strategy!.observationIds,
      observations, comparison: strategy!.comparison, evaluated: strategy!.evaluated, conclusion: strategy!.conclusion,
      ...(temporal ? { temporal } : {}) });
    this.#path.push(record); this.#strategies.push(strategy!); this.#fresh.push({ goalStepId: goalId, observationId: latest.observationId });
  }
  async finalize(): Promise<AssembledSuccessfulTraceV5> {
    this.#active();
    const last = this.#path.at(-1);
    const lastUrl = last?.type === 'verification_goal' && !('verificationVersion' in last) &&
      last.observations.at(-1)?.request.kind === 'current_url' && this.#admission.spec.semanticMode === 'poc_v1';
    const current = lastUrl
      ? ActionCandidateGroundingSessionV1.prototype.protectedCurrentUrlState.call(this.#runtime)
      : await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime);
    requireFact(this.#pendingGenericAction === undefined && this.#path.length === this.#admission.spec.steps.length && same(statePoint(current, this.#owner.sessionId), this.#current) &&
      same(ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(this.#runtime), this.#actions.map((a) => a.witness)),
      'V5 omitted/abandoned successful path or final state drift');
    validateSemanticAdmissionReadbackV2(this.#admission.record, this.#admission.spec, this.#admission);
    const finishedAt = new Date().toISOString(), successfulTraceId = `trace-${randomUUID()}`;
    const data = { traceVersion: '5', successfulTraceId, testSpecId: this.#admission.spec.testSpecId,
      explorationAttemptId: this.#owner.attemptId, sessionId: this.#owner.sessionId,
      executionProfileRef: this.#admission.spec.executionProfileRef, profileFingerprint: this.#owner.profileFingerprint,
      source: this.#admission.spec, semanticAdmission: this.#admission.record, obligationHandoff: buildActionObligationHandoffV2(this.#admission),
      startState: this.#start, finalState: this.#current, startStateDigest: this.#start.stateDigest, finalStateDigest: this.#current.stateDigest,
      startedAt: this.#startedAt, finishedAt, successfulPath: this.#path, completedOriginStepIds: this.#admission.spec.steps.map((s) => s.id) };
    const capture = ProtectedTraceCaptureBundleV5Schema.parse({ captureVersion: '5', successfulTraceId,
      testSpecId: data.testSpecId, explorationAttemptId: data.explorationAttemptId, sessionId: data.sessionId,
      profileFingerprint: data.profileFingerprint, actions: this.#actions,
      observations: [...this.#captures.values()].filter((v) => this.#strategies.some((s) => s.observationIds.includes(v.record.observationId))),
      strategies: this.#strategies, currentAtGoal: this.#fresh });
    if(this.#nativeStrategies.length){capture.nativeStrategies=this.#nativeStrategies;capture.nativeObservations=[...this.#nativeCaptures.values()].filter(v=>this.#nativeStrategies.some(s=>s.observationIds.includes(v.record.observationId)));}
    const artifact = parseProtectedTraceCaptureBundleV5(capture, { ...data, traceDigest: successfulTraceDigestV5(data) });
    this.#finalized = true; this.#stopCapture();this.#stopNativeCapture(); return new AssembledSuccessfulTraceV5(token, artifact);
  }
}
