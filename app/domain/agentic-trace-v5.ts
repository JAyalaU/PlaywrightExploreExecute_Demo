import { z } from 'zod';
import { createHash } from 'node:crypto';
import { TestSpecV6V2Schema, parseTestSpecV6V2 } from './test-spec-v6-v2.js';
import { SemanticAdmissionRecordV2Schema, canonicalSemanticProjectionV2, TrustedSemanticSourceV2Schema,
  ActionObligationHandoffV2Schema,NATIVE_OPTION_ADMISSION_VERSIONS_V2,
  POC_SEMANTIC_ADMISSION_VERSIONS_V2,
  PREVIOUS_NATIVE_OPTION_P5_ADMISSION_VERSIONS_V2,
  PREVIOUS_NATIVE_OPTION_P6_ADMISSION_VERSIONS_V2 } from './action-semantic-admission.js';
import { semanticAdmissionDigestV2 as sourceHash } from './action-semantic-admission.js';
import { ActionGroundingWitnessV1Schema, parseActionGroundingWitnessV1 } from './action-grounding-execution.js';
import { ActionGroundingRetirementV1Schema, parseActionGroundingRetirementV1 } from './action-grounding-execution.js';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { SuccessfulVerificationRecordV3Schema, validateSuccessfulVerificationRecordV3,
  type ProtectedTraceObservationSourceV3 } from './agentic-trace-v3.js';
import { ExecutionProfileRefSchema, ApprovedAbsoluteUrlSchema } from './schema.js';
import { NativeOptionVerificationRecordV5Schema,parseNativeOptionStrategyV2,parseNativeOptionObservationV2,nativeOptionPredicate,type NativeOptionStrategyV2,type NativeOptionObservationV2 } from './native-option-verification.js';
import { NativeOptionVerificationGoalV2Schema } from './native-option-verification-goal.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TraceStateV5Schema = z.strictObject({ sessionId: id, pageId: id, stateDigest: digest,
  stateEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative() });
export type TraceStateV5 = z.infer<typeof TraceStateV5Schema>;
const base = { recordId: id, sequence: z.number().int().positive(), source: z.literal('authored'),
  originStepId: id, preStateDigest: digest, postStateDigest: digest };
export const SuccessfulActionGroundingRecordV5Schema = z.strictObject({ ...base,
  type: z.literal('action_goal'), witness: ActionGroundingWitnessV1Schema, retirement: ActionGroundingRetirementV1Schema.optional(),
  // A navigating PoC click is delivered before the next step observes its new document.
  continuation: z.union([
    z.strictObject({ observationId: id, after: TraceStateV5Schema }),
    z.strictObject({ nextActionWitnessId: id, after: TraceStateV5Schema }),
  ]).optional() });
export const SuccessfulNavigationRecordV5Schema = z.strictObject({ ...base, type: z.literal('navigate'),
  url: ApprovedAbsoluteUrlSchema, before: TraceStateV5Schema, after: TraceStateV5Schema, observedAt: z.iso.datetime() });
export const SuccessfulPathRecordV5Schema = z.union([
  SuccessfulActionGroundingRecordV5Schema, SuccessfulNavigationRecordV5Schema, SuccessfulVerificationRecordV3Schema, NativeOptionVerificationRecordV5Schema,
]);
export const SuccessfulExplorationTraceV5Schema = z.strictObject({
  traceVersion: z.literal('5'), successfulTraceId: id, testSpecId: id, explorationAttemptId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest, sessionId: id,
  source: TestSpecV6V2Schema, semanticAdmission: SemanticAdmissionRecordV2Schema,
  obligationHandoff: ActionObligationHandoffV2Schema,
  startState: TraceStateV5Schema, finalState: TraceStateV5Schema, startStateDigest: digest, finalStateDigest: digest,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  successfulPath: z.array(SuccessfulPathRecordV5Schema).min(1).max(100),
  completedOriginStepIds: z.array(id).min(1).max(100), traceDigest: digest,
});
export type SuccessfulExplorationTraceV5 = z.infer<typeof SuccessfulExplorationTraceV5Schema>;
export type SuccessfulPathRecordV5 = z.infer<typeof SuccessfulPathRecordV5Schema>;
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const requireFact = (value: boolean, message: string): void => { if (!value) throw new Error(message); };
const legacyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const successfulTraceDigestV5 = sourceHash;
export interface ProtectedNativeVerificationSourceV5 {
 readNativeObservation?(id:string,goalId:string):{record:NativeOptionObservationV2;actionOrdinal:number;pathPosition:number;pathStateDigest:string;currentAtCapture:boolean;currentAtGoal:boolean}|undefined;
 readNativeStrategy?(goalId:string):NativeOptionStrategyV2|undefined;
}

/** Mechanical integrity only. This parser cannot confer semantic, runtime or stored origin. */
export function parseSuccessfulExplorationTraceV5(input: unknown,
  verificationSource: ProtectedTraceObservationSourceV3 & ProtectedNativeVerificationSourceV5): SuccessfulExplorationTraceV5 {
  const trace = SuccessfulExplorationTraceV5Schema.parse(input);
  const source = parseTestSpecV6V2(trace.source), admission = trace.semanticAdmission;
  requireFact((source.semanticMode === 'poc_v1') === same(admission.versions,POC_SEMANTIC_ADMISSION_VERSIONS_V2),
    'V5 semantic admission mode mismatch');
  requireFact(!source.steps.some(s=>'verificationVersion'in s)||
    same(admission.versions,POC_SEMANTIC_ADMISSION_VERSIONS_V2)||
    same(admission.versions,NATIVE_OPTION_ADMISSION_VERSIONS_V2)||
    same(admission.versions,PREVIOUS_NATIVE_OPTION_P6_ADMISSION_VERSIONS_V2)||
    same(admission.versions,PREVIOUS_NATIVE_OPTION_P5_ADMISSION_VERSIONS_V2),'V5 native admission version mismatch');
  const { traceDigest, ...data } = trace;
  const trustedSource = TrustedSemanticSourceV2Schema.parse({ testSpecId: source.testSpecId,
    sourceInstruction: source.sourceInstruction, executionProfileRef: source.executionProfileRef, startState: source.startState });
  const handoff = { handoffVersion: '2', testSpecId: source.testSpecId, sourceDigest: admission.sourceDigest,
    admissionDigest: sourceHash(admission), acceptedTestSpecDigest: admission.acceptedTestSpecDigest,
    acceptedAccountingObligationDigest: admission.acceptedAccountingObligationDigest,
    goals: source.steps.filter((s) => s.type === 'action_goal').map((s) => ({ goalId: s.id, obligationIds: s.obligations.map((o) => o.id) })) };
  requireFact(successfulTraceDigestV5(data) === traceDigest && sourceHash(source) === admission.acceptedTestSpecDigest &&
    sourceHash(source.sourceInstruction) === admission.sourceDigest && sourceHash(trustedSource) === admission.trustedMetadataDigest &&
    sourceHash(canonicalSemanticProjectionV2(source)) === admission.acceptedAccountingObligationDigest && same(handoff, trace.obligationHandoff),
    'V5 source/admission/accounting linkage mismatch');
  requireFact(!source.instructionAccounting.some((s) => s.classification === 'unresolved') &&
    !source.steps.some((s) => s.type === 'action_goal' && s.sourceAccounting.some((a) => a.classification === 'unresolved')),
    'V5 unresolved source cannot enter successful trace');
  requireFact(trace.testSpecId === source.testSpecId && same(trace.executionProfileRef, source.executionProfileRef) &&
    trace.startState.sessionId === trace.sessionId && trace.finalState.sessionId === trace.sessionId &&
    trace.startState.stateDigest === trace.startStateDigest && trace.finalState.stateDigest === trace.finalStateDigest &&
    Date.parse(trace.startedAt) <= Date.parse(trace.finishedAt) &&
    same(trace.completedOriginStepIds, source.steps.map((s) => s.id)) && trace.successfulPath.length === source.steps.length &&
    new Set(trace.successfulPath.map((r) => r.recordId)).size === trace.successfulPath.length,
    'V5 trace owner/order/bounds mismatch');
  let current = trace.startState;
  let actions = 0;
  const executions = new Set<string>(), witnessIds = new Set<string>(), strategies = new Set<string>();
  for (const [index, record] of trace.successfulPath.entries()) {
    const step = source.steps[index]!;
    requireFact(record.sequence === index + 1 && record.source === 'authored' && record.originStepId === step.id &&
      record.type === step.type && record.preStateDigest === current.stateDigest, 'V5 ordered source/state chain mismatch');
    if (record.type === 'action_goal' && step.type === 'action_goal') {
      const witness = parseActionGroundingWitnessV1(record.witness,
        { source, semanticAdmission: admission }), pre = witness.finalCheck,
        parent = pre.candidateObservation, execution = witness.execution, post = witness.postEffect,
        generic = post.effect.kind === 'generic_activation',
        retirement = record.retirement ? parseActionGroundingRetirementV1(record.retirement) : undefined;
      const continuation = record.continuation;
      const following = trace.successfulPath[index + 1];
      const actionAfter = generic ? continuation?.after : retirement?.after;
      requireFact(parent.status === 'complete' && parent.testSpecId === trace.testSpecId &&
        parent.explorationAttemptId === trace.explorationAttemptId && parent.sessionId === trace.sessionId &&
        parent.profileFingerprint === trace.profileFingerprint && same(parent.executionProfileRef, trace.executionProfileRef) &&
        same(parent.request.handoff, trace.obligationHandoff) && same(pre.sourceGoal, step) &&
        pre.sourceInstruction === source.sourceInstruction && pre.admissionDigest === sourceHash(admission) &&
        same(witness.preparation.sourceGoal, step) && record.preStateDigest === post.before.stateDigest &&
        (generic ? !retirement && !!continuation && !!actionAfter && continuation.after.sessionId === trace.sessionId &&
          continuation.after.stateEpoch > post.before.stateEpoch && continuation.after.mutationEpoch > post.before.mutationEpoch &&
          (following?.type === 'verification_goal' && 'observationId' in continuation &&
            following.observationIds.includes(continuation.observationId) &&
            following.observations.some(o => o.observationId === continuation.observationId &&
              same(continuation.after, { sessionId: o.sessionId, pageId: o.pageId, stateDigest: o.stateDigest,
                stateEpoch: o.stateEpoch, mutationEpoch: o.mutationEpoch })) ||
          following?.type === 'action_goal' && 'nextActionWitnessId' in continuation &&
            following.witness.witnessId === continuation.nextActionWitnessId &&
            same(continuation.after, { sessionId: following.witness.postEffect.before.sessionId,
              pageId: following.witness.postEffect.before.pageId,
              stateDigest: following.witness.postEffect.before.stateDigest,
              stateEpoch: following.witness.postEffect.before.stateEpoch,
              mutationEpoch: following.witness.postEffect.before.mutationEpoch })) :
          !!retirement && !continuation && retirement.witnessId === witness.witnessId && retirement.postEffectDigest === post.witnessDigest &&
          same(retirement.before, post.after) && Date.parse(retirement.observedAt) >= Date.parse(execution.finishedAt) &&
          Date.parse(retirement.observedAt) <= Date.parse(trace.finishedAt)) &&
        record.postStateDigest === actionAfter?.stateDigest &&
        same(current, { sessionId: post.before.sessionId, pageId: post.before.pageId, stateDigest: post.before.stateDigest,
          stateEpoch: post.before.stateEpoch, mutationEpoch: post.before.mutationEpoch }) &&
        Date.parse(witness.preparation.observedAt) >= Date.parse(trace.startedAt) &&
        Date.parse(execution.finishedAt) <= Date.parse(trace.finishedAt) &&
        !executions.has(execution.executionId) && !witnessIds.has(witness.witnessId) && !strategies.has(pre.strategyId),
        'V5 successful action source/argument/frame/execution correspondence mismatch');
      executions.add(execution.executionId); witnessIds.add(witness.witnessId); strategies.add(pre.strategyId);
      if (!actionAfter) throw new Error('V5 action continuation missing');
      current = { sessionId: actionAfter.sessionId, pageId: actionAfter.pageId, stateDigest: actionAfter.stateDigest,
        stateEpoch: actionAfter.stateEpoch, mutationEpoch: actionAfter.mutationEpoch }; actions++;
    } else if (record.type === 'navigate' && step.type === 'navigate') {
      requireFact(record.url === step.url && same(record.before, current) && record.after.sessionId === trace.sessionId &&
        record.after.pageId === current.pageId && record.after.stateDigest === record.postStateDigest &&
        record.after.stateEpoch > current.stateEpoch && record.after.mutationEpoch > current.mutationEpoch &&
        Date.parse(record.observedAt) >= Date.parse(trace.startedAt) && Date.parse(record.observedAt) <= Date.parse(trace.finishedAt),
        'V5 navigation provenance mismatch');
      current = record.after;
    } else if (record.type === 'verification_goal' && step.type === 'verification_goal') {
      if ('verificationVersion' in record) {
        const goal=NativeOptionVerificationGoalV2Schema.parse(step),strategy=parseNativeOptionStrategyV2(record.strategy),observation=parseNativeOptionObservationV2(record.observations[0]);
        const captured=verificationSource.readNativeObservation?.(observation.observationId,goal.id),protectedStrategy=verificationSource.readNativeStrategy?.(goal.id);
        requireFact(observation.status==='complete'&&!!captured&&!!protectedStrategy&&same(captured.record,observation)&&same(protectedStrategy,strategy)&&
          captured.currentAtCapture&&captured.currentAtGoal&&captured.pathPosition===index&&captured.actionOrdinal===actions&&captured.pathStateDigest===current.stateDigest&&
          record.goalDigest===hash(goal)&&strategy.goalDigest===hash(goal)&&strategy.claimDigest===hash(goal.claim)&&strategy.admissionDigest===sourceHash(admission)&&
          same(record.observationIds,strategy.observationIds)&&same(record.observations,strategy.observations)&&same(record.comparison,strategy.comparison)&&
          record.strategyDigest===strategy.strategyDigest&&record.evaluated===strategy.evaluated&&record.conclusion===strategy.conclusion&&record.actionOrdinal===actions&&
          record.goalStepId===goal.id&&record.postStateDigest===current.stateDigest&&observation.testSpecId===trace.testSpecId&&observation.explorationAttemptId===trace.explorationAttemptId&&observation.sessionId===trace.sessionId&&observation.profileFingerprint===trace.profileFingerprint&&same(observation.executionProfileRef,trace.executionProfileRef)&&
          observation.status==='complete'&&same(observation.result.predicate,nativeOptionPredicate(goal))&&observation.result.optionLabel===goal.claim.optionLabel&&record.comparison.expectedSelected===goal.claim.expectedSelected&&
          same(current,{sessionId:observation.sessionId,pageId:observation.pageId,stateDigest:observation.stateDigest,stateEpoch:observation.stateEpoch,mutationEpoch:observation.mutationEpoch})&&Date.parse(observation.observedAt)>=Date.parse(trace.startedAt)&&Date.parse(observation.observedAt)<=Date.parse(trace.finishedAt),
          'V5 native verification source/capture/state correspondence mismatch');
        continue;
      }
      requireFact(!('verificationVersion' in step),'V5 native source cannot use historical strategy');
      requireFact(record.postStateDigest === current.stateDigest && record.actionOrdinal === actions &&
        record.goalDigest === legacyHash(step), 'V5 verification ordering mismatch');
      if (step.dependsOnStepId) requireFact(source.steps.slice(0, index).some((s) => s.id === step.dependsOnStepId),
        'V5 verification prerequisite order mismatch');
      validateSuccessfulVerificationRecordV3(record, step, trace, trace, verificationSource, trace.successfulPath.slice(0, index));
      const latest = record.observations.at(-1)!;
      requireFact(latest.pageId === current.pageId && latest.stateDigest === current.stateDigest &&
        latest.stateEpoch === current.stateEpoch && latest.mutationEpoch === current.mutationEpoch,
        'V5 verification state domain mismatch');
    }
  }
  requireFact(same(current, trace.finalState), 'V5 final state mismatch');
  return trace;
}
