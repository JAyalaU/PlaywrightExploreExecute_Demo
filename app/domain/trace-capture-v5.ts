import { z } from 'zod';
import { SuccessfulVerificationStrategyV1Schema, parseSuccessfulVerificationStrategyV1 } from './successful-verification-strategy.js';
import { PreparedActionGroundingV1Schema } from './action-grounding-strategy.js';
import { ActionGroundingWitnessV1Schema, ActionExecutionAttemptV1Schema, ActionPostEffectV1Schema, ActionGroundingRetirementV1Schema, parseActionGroundingWitnessV1 } from './action-grounding-execution.js';
import { TrustedObservationResultV1Schema, parseTrustedObservationWitnessV1 } from './observation-contracts.js';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { parseSuccessfulExplorationTraceV5, SuccessfulExplorationTraceV5Schema, type SuccessfulExplorationTraceV5 } from './agentic-trace-v5.js';
import type { ProtectedTraceObservationSourceV3 } from './agentic-trace-v3.js';
import {NativeOptionObservationV2Schema,NativeOptionStrategyV2Schema,parseNativeOptionObservationV2,parseNativeOptionStrategyV2} from './native-option-verification.js';
import type {ProtectedNativeVerificationSourceV5} from './agentic-trace-v5.js';
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const requireFact = (value: boolean, message: string): void => { if (!value) throw new Error(message); };
export const ProtectedTraceCaptureBundleV5Schema = z.strictObject({ captureVersion: z.literal('5'),
  successfulTraceId: id, testSpecId: id, explorationAttemptId: id, sessionId: id, profileFingerprint: digest,
  actions: z.array(z.strictObject({ recordId: id, witness: ActionGroundingWitnessV1Schema,
    finalCheck: PreparedActionGroundingV1Schema, execution: ActionExecutionAttemptV1Schema,
    postEffect: ActionPostEffectV1Schema, retirement: ActionGroundingRetirementV1Schema, mappingDigest: digest })).max(100),
  observations: z.array(z.strictObject({ record: TrustedObservationResultV1Schema,
    actionOrdinal: z.number().int().nonnegative(), pathPosition: z.number().int().nonnegative(),
    pathStateDigest: digest, currentAtCapture: z.literal(true) })).max(80),
  strategies: z.array(SuccessfulVerificationStrategyV1Schema).max(100),
  currentAtGoal: z.array(z.strictObject({ goalStepId: id, observationId: id })).max(100),
  nativeObservations:z.array(z.strictObject({record:NativeOptionObservationV2Schema,actionOrdinal:z.number().int().nonnegative(),pathPosition:z.number().int().nonnegative(),pathStateDigest:digest,currentAtCapture:z.literal(true)})).max(80).optional(),
  nativeStrategies:z.array(NativeOptionStrategyV2Schema).max(100).optional(),
});
export type ProtectedTraceCaptureBundleV5 = z.infer<typeof ProtectedTraceCaptureBundleV5Schema>;

/** Integrity helper only: a fabricated bundle creates no protected authority. */
export function parseProtectedTraceCaptureBundleV5(input: unknown, traceInput: unknown): {
  trace: SuccessfulExplorationTraceV5; capture: ProtectedTraceCaptureBundleV5 } {
  const capture = ProtectedTraceCaptureBundleV5Schema.parse(input);
  const preliminary = SuccessfulExplorationTraceV5Schema.parse(traceInput);
  requireFact(capture.successfulTraceId === preliminary.successfulTraceId && capture.testSpecId === preliminary.testSpecId &&
    capture.explorationAttemptId === preliminary.explorationAttemptId && capture.sessionId === preliminary.sessionId &&
    capture.profileFingerprint === preliminary.profileFingerprint, 'V5 protected capture owner mismatch');
  const observations = new Map(capture.observations.map((c) => [c.record.observationId, c]));
  const strategies = new Map(capture.strategies.map((s) => [s.goalStepId, parseSuccessfulVerificationStrategyV1(s)]));
  const freshness = new Map(capture.currentAtGoal.map((g) => [g.goalStepId, g.observationId]));
  const actionRecords = preliminary.successfulPath.filter((r) => r.type === 'action_goal');
  const verificationRecords = preliminary.successfulPath.filter((r):r is Extract<typeof r,{type:'verification_goal'}> & {verificationVersion?:never} => r.type === 'verification_goal' && !('verificationVersion' in r));
  const nativeRecords=preliminary.successfulPath.filter(r=>r.type==='verification_goal'&&'verificationVersion'in r);
  const nativeObservations=new Map((capture.nativeObservations??[]).map(c=>[c.record.observationId,c]));
  const nativeStrategies=new Map((capture.nativeStrategies??[]).map(s=>[s.goalStepId,parseNativeOptionStrategyV2(s)]));
  requireFact(nativeRecords.length===nativeStrategies.size&&nativeStrategies.size===(capture.nativeStrategies??[]).length&&nativeRecords.length===nativeObservations.size&&nativeObservations.size===(capture.nativeObservations??[]).length&&nativeRecords.every(r=>nativeStrategies.has(r.goalStepId)&&nativeObservations.has(r.observationIds[0]!)&&freshness.get(r.goalStepId)===r.observationIds[0]),'V5 native capture missing/abandoned facts');
  const expectedObservations = new Set(verificationRecords.flatMap((r) => r.observationIds));
  requireFact(observations.size === capture.observations.length && strategies.size === capture.strategies.length &&
    freshness.size === capture.currentAtGoal.length && strategies.size === verificationRecords.length &&
    freshness.size === verificationRecords.length+nativeRecords.length && observations.size === expectedObservations.size &&
    [...observations.keys()].every((o) => expectedObservations.has(o)) &&
    verificationRecords.every((r) => strategies.has(r.goalStepId) && freshness.get(r.goalStepId) === r.observationIds.at(-1)) &&
    capture.actions.length === actionRecords.length && new Set(capture.actions.map((a) => a.recordId)).size === actionRecords.length,
    'V5 missing/abandoned protected facts');
  for (const record of actionRecords) {
    const captured = capture.actions.find((a) => a.recordId === record.recordId);
    const witness = parseActionGroundingWitnessV1(record.witness);
    requireFact(!!captured && same(captured.witness, witness) && same(captured.finalCheck, witness.finalCheck) &&
      same(captured.execution, witness.execution) && same(captured.postEffect, witness.postEffect) &&
      same(captured.retirement, record.retirement) &&
      captured.mappingDigest === witness.finalCheck.mappingDigest, 'V5 execution private readback mismatch');
  }
  for (const value of observations.values()) parseTrustedObservationWitnessV1(value.record);
  for(const value of nativeObservations.values())parseNativeOptionObservationV2(value.record);
  const source: ProtectedTraceObservationSourceV3 & ProtectedNativeVerificationSourceV5 = {
    readNativeObservation(observationId,goalId){const record=nativeObservations.get(observationId);return record?{...structuredClone(record),currentAtGoal:freshness.get(goalId)===observationId}:undefined;},
    readNativeStrategy(goalId){const strategy=nativeStrategies.get(goalId);return strategy&&structuredClone(strategy);},
    readObservation(observationId, goalId) { const record = observations.get(observationId);
      return record ? { ...structuredClone(record), currentAtGoal: freshness.get(goalId) === observationId } : undefined; },
    readStrategy(goalId) { const strategy = strategies.get(goalId); return strategy ? structuredClone(strategy) : undefined; },
  };
  return { trace: parseSuccessfulExplorationTraceV5(traceInput, source), capture };
}
