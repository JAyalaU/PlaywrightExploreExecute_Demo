import { z } from 'zod';
import { ExecutionProfileRefSchema, ApprovedAbsoluteUrlSchema } from './schema.js';
import { ActionGoalV2Schema } from './action-goal-v2.js';
import { GroundingCorrespondenceV1Schema } from './action-grounding-strategy.js';
import { ActionCandidateRequestV1Schema, ActionCandidatePredicateV1Schema, candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { ActionGroundingWitnessV1Schema, parseActionGroundingWitnessV1 } from './action-grounding-execution.js';
import { ActionGroundingRetirementV1Schema, parseActionGroundingRetirementV1 } from './action-grounding-execution.js';
import { ActionExecutionAttemptV1Schema, parseActionExecutionAttemptV1 } from './action-grounding-execution.js';
import { DeterministicVerificationAssertionV1Schema, assertionFromStrategyV1, type DeterministicVerificationAssertionV1 } from './goal-directed-compiler.js';
import { TrustedObservationResultV1Schema, parseTrustedObservationWitnessV1, type TrustedObservationResultV1 } from './observation-contracts.js';
import { TraceStateV5Schema, type SuccessfulExplorationTraceV5 } from './agentic-trace-v5.js';

import {DeferredVerificationAssertionSchema,NativeOptionObservationV2Schema,parseNativeOptionObservationV2,nativeOptionAssertion,nativeOptionPredicate} from './native-option-verification.js';
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128), digest = z.string().regex(/^[a-f0-9]{64}$/);
const owner = { testSpecId: id, explorationAttemptId: id, successfulTraceId: id, traceDigest: digest,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest, compilerAttemptId: id };
export const DeferredCompilerReasonV4Schema = z.enum(['PROFILE_MISMATCH', 'SOURCE_CORRESPONDENCE', 'NON_UNIQUE_MATCH',
  'TARGET_MISMATCH', 'LABEL_ASSOCIATION_MISMATCH', 'OPTION_MAPPING_MISMATCH', 'FRAME_MISMATCH',
  'INCOMPLETE_EVIDENCE', 'STALE_EVIDENCE', 'UNSUPPORTED_REPRESENTATION', 'UNSUPPORTED_VERIFICATION',
  'UNSUPPORTED_ACTIVATION', 'POST_EFFECT_UNPROVEN', 'ENVIRONMENT_FAILURE', 'CLEANUP_UNVERIFIED']);
export type DeferredCompilerReasonV4 = z.infer<typeof DeferredCompilerReasonV4Schema>;
export const DurableDeferredFrameV1Schema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('main') }),
  z.strictObject({ kind: z.literal('nested'), anchors: z.array(z.strictObject({ kind: z.enum(['title', 'testId']),
    value: z.string().min(1).max(512), exact: z.literal(true) })).min(1).max(8) })]);
/** Entire predicate is re-evaluated across all frames BEFORE durable frame correspondence. */
export const DeferredActionGuardV1Schema = z.strictObject({ guardVersion: z.literal('1'),
  domain: z.literal('all_current_page_frames'), candidateLimit: z.literal(80), frameLimit: z.literal(8), optionLimit: z.literal(80),
  sourceGoal: ActionGoalV2Schema, correspondence: GroundingCorrespondenceV1Schema,
  request: ActionCandidateRequestV1Schema, predicate: ActionCandidatePredicateV1Schema, mappingDigest: digest,
  frame: DurableDeferredFrameV1Schema, completeRequired: z.literal(true), eligibleCount: z.literal(1),
  nativeEffect: z.enum(['entered_text', 'native_choice', 'native_activation']),
  nativeControl: z.enum(['input', 'textarea', 'select', 'checkbox', 'radio']),
  labelMode: z.literal('proven_native_label_or_aria_labelledby'),
  optionMode: z.literal('exact_owned_authored_label_unique_value'),
  argumentPolicy: z.literal('require_fresh_mapping_equal_compiled_argument') });
const step = { id, traceRecordId: id, originStepId: id, source: z.literal('authored') };
export const DeferredExecutionStepV9Schema = z.discriminatedUnion('type', [
  z.strictObject({ ...step, type: z.literal('action_goal'), operation: z.enum(['fill','select_option','click']),
    guard: DeferredActionGuardV1Schema, authoredArgument: z.string().max(1024).optional(), executableArgument: z.string().max(1024).optional() }),
  z.strictObject({ ...step, type: z.literal('navigate'), url: ApprovedAbsoluteUrlSchema }),
  z.strictObject({ ...step, type: z.literal('verification_goal'), goalStepId: id, assertion: DeferredVerificationAssertionSchema }),
]);
export const ResolvedTestSpecV9Schema = z.strictObject({ schemaVersion: z.literal('9'), sourceSchemaVersion: z.literal('6'),
  sourceContractVersion: z.literal('2'), ...owner, resolvedSpecId: id, admissionDigest: digest,
  runtimeVersions: z.strictObject({ playwright: z.string().min(1).max(128), mcp: z.string().min(1).max(128),
    compiler: z.literal('4'), guard: z.literal('1') }), executionSteps: z.array(DeferredExecutionStepV9Schema).min(1).max(100), resolvedDigest: digest });
export type ResolvedTestSpecV9 = z.infer<typeof ResolvedTestSpecV9Schema>;
export const CompilerAttemptV4Schema = z.strictObject({ compilerVersion: z.literal('4'), ...owner,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), freshSessionId: id.optional(), cleanup: z.enum(['verified','unverified']),
  checks: z.array(z.strictObject({ traceRecordId: id, kind: z.enum(['profile','source','predicate','frame','execution','verification','order','cleanup']),
    passed: z.boolean(), evidenceDigest: digest.optional() })).min(1).max(800),
  freshStartState: TraceStateV5Schema.optional(), freshFinalState: TraceStateV5Schema.optional(),
  // Validated successful invocation/effect accounting survives a later rejected result.
  // Only acceptance adds the complete ordered path/final-state requirements below.
  freshActions: z.array(z.strictObject({ traceRecordId: id, witness: ActionGroundingWitnessV1Schema, retirement: ActionGroundingRetirementV1Schema })).max(100),
  executionStops: z.array(z.strictObject({traceRecordId:id,execution:ActionExecutionAttemptV1Schema})).max(100),
  freshVerifications: z.array(z.strictObject({ traceRecordId: id, observation: z.union([TrustedObservationResultV1Schema,NativeOptionObservationV2Schema]) })).max(100),
  freshNavigations: z.array(z.strictObject({ traceRecordId:id,url:ApprovedAbsoluteUrlSchema,before:TraceStateV5Schema,after:TraceStateV5Schema,observedAt:z.iso.datetime() })).max(100),
  result: z.discriminatedUnion('status',[z.strictObject({ status: z.literal('accepted'), resolvedSpecId: id }),
    z.strictObject({ status: z.literal('rejected'), reasonCode: DeferredCompilerReasonV4Schema, failedTraceRecordId: id.optional() })]), attemptDigest: digest });
export type CompilerAttemptV4 = z.infer<typeof CompilerAttemptV4Schema>;
const same = (a: unknown,b: unknown) => hash(a) === hash(b);
export function evaluateDeferredAssertionV1(a:DeterministicVerificationAssertionV1,o:TrustedObservationResultV1):boolean|undefined {
  if(o.status!=='complete')return undefined;
  const r=o.result;
  if(a.kind==='semantic_count'&&r.kind==='matches')return a.operator==='equal'?r.count===a.expected:a.operator==='greater_than'?r.count>a.expected:a.operator==='at_least'?r.count>=a.expected:r.count<=a.expected;
  if(a.kind==='unique_boolean_property'&&r.kind==='property'&&r.property===a.property&&typeof r.value==='boolean')return r.value===a.expected;
  if(a.kind==='unique_string_property'&&r.kind==='property'&&r.property===a.property&&typeof r.value==='string')return a.operator==='equal'?r.value===a.expected:r.value.includes(a.expected);
  if(a.kind==='url'&&r.kind==='url'){if(a.operator==='equal')return r.value===new URL(a.expected).href;const p=new URL(a.expected.slice(0,-1)),u=new URL(r.value);return p.origin===u.origin&&u.pathname.startsWith(p.pathname);}
  return undefined;
}
export function durableDeferredFrame(frame: { kind: 'main' } | { kind: 'nested'; anchors: { kind:'title'|'testId'; value:string; exact:true }[] }) {
  return DurableDeferredFrameV1Schema.parse(frame.kind === 'main' ? frame : {kind:'nested',anchors:frame.anchors.map(({kind,value,exact})=>({kind,value,exact}))});
}
/** Serialized integrity only; these parsers confer no compiler/store origin. */
export function parseCompilerAttemptV4(input: unknown, trace: SuccessfulExplorationTraceV5): CompilerAttemptV4 {
  const a = CompilerAttemptV4Schema.parse(input), { attemptDigest,...data } = a;
  if (hash(data)!==attemptDigest || a.testSpecId!==trace.testSpecId || a.explorationAttemptId!==trace.explorationAttemptId ||
    a.successfulTraceId!==trace.successfulTraceId || a.traceDigest!==trace.traceDigest || a.profileFingerprint!==trace.profileFingerprint ||
    !same(a.executionProfileRef,trace.executionProfileRef) || Date.parse(a.finishedAt)<Date.parse(a.startedAt) ||
    Date.parse(a.startedAt)<Date.parse(trace.finishedAt) || a.checks.some(c=>!trace.successfulPath.some(r=>r.recordId===c.traceRecordId)) ||
    a.freshSessionId===trace.sessionId || new Set(a.freshActions.map(x=>x.traceRecordId)).size!==a.freshActions.length ||
    new Set(a.freshVerifications.map(x=>x.traceRecordId)).size!==a.freshVerifications.length ||
    new Set(a.freshNavigations.map(x=>x.traceRecordId)).size!==a.freshNavigations.length) throw new Error('INVALID_COMPILER_V4');
  for (const fresh of a.freshActions) {
    const w=parseActionGroundingWitnessV1(fresh.witness), original=trace.successfulPath.find(r=>r.recordId===fresh.traceRecordId);
    if (!original || original.type!=='action_goal' || !same(w.finalCheck.sourceGoal,original.witness.finalCheck.sourceGoal) ||
      !same(w.finalCheck.correspondence,original.witness.finalCheck.correspondence) || w.finalCheck.mappingDigest!==original.witness.finalCheck.mappingDigest ||
      w.finalCheck.operation!==original.witness.finalCheck.operation || w.execution.admissionDigest!==original.witness.execution.admissionDigest ||
      w.finalCheck.candidateObservation.sessionId!==a.freshSessionId || w.finalCheck.candidateObservation.explorationAttemptId!==a.compilerAttemptId ||
      w.finalCheck.candidateObservation.profileFingerprint!==a.profileFingerprint ||
      !same(w.finalCheck.candidateObservation.executionProfileRef,a.executionProfileRef) ||
      Date.parse(w.preparation.observedAt)<Date.parse(a.startedAt) || Date.parse(w.execution.finishedAt)>Date.parse(a.finishedAt) ||
      !same(durableDeferredFrame(w.finalCheck.candidateObservation.status==='complete' ? w.finalCheck.candidateObservation.candidates.find(c=>c.selectedRef===w.finalCheck.selectedRef && c.frameId===w.finalCheck.frameId)!.frame : {kind:'main'}),
        durableDeferredFrame(original.witness.finalCheck.candidateObservation.status==='complete' ? original.witness.finalCheck.candidateObservation.candidates.find(c=>c.selectedRef===original.witness.finalCheck.selectedRef && c.frameId===original.witness.finalCheck.frameId)!.frame : {kind:'main'}))) throw new Error('INVALID_COMPILER_ACTION_CORRESPONDENCE');
    const receipt=parseActionGroundingRetirementV1(fresh.retirement);
    if(receipt.witnessId!==w.witnessId || receipt.postEffectDigest!==w.postEffect.witnessDigest || !same(receipt.before,w.postEffect.after) ||
      Date.parse(receipt.observedAt)<Date.parse(w.execution.finishedAt)||Date.parse(receipt.observedAt)>Date.parse(a.finishedAt))throw new Error('INVALID_FRESH_RETIREMENT');
  }
  for(const fresh of a.freshVerifications){
    const original=trace.successfulPath.find(r=>r.recordId===fresh.traceRecordId);
    if(fresh.observation.observationVersion==='2'){
      const o=parseNativeOptionObservationV2(fresh.observation),goal=trace.source.steps.find(s=>s.id===original?.originStepId);
      if(!original||original.type!=='verification_goal'||!('verificationVersion'in original)||!goal||!('verificationVersion'in goal)||o.status!=='complete'||o.sessionId!==a.freshSessionId||o.explorationAttemptId!==a.compilerAttemptId||o.testSpecId!==a.testSpecId||o.profileFingerprint!==a.profileFingerprint||!same(o.executionProfileRef,a.executionProfileRef)||Date.parse(o.observedAt)<Date.parse(a.startedAt)||Date.parse(o.observedAt)>Date.parse(a.finishedAt)||o.goalStepId!==goal.id||o.claimDigest!==hash(goal.claim)||o.admissionDigest!==original.strategy.admissionDigest||!same(o.result.predicate,nativeOptionPredicate(goal))||o.result.optionLabel!==goal.claim.optionLabel||(!same(o.result.frame,original.observations[0]!.status==='complete'?original.observations[0]!.result.frame:undefined)||original.observations[0]!.status==='complete'&&o.result.labelOwnershipDigest!==original.observations[0]!.result.labelOwnershipDigest)||(o.result.selected===goal.claim.expectedSelected)!==original.evaluated)throw new Error('INVALID_FRESH_NATIVE_VERIFICATION');
      continue;
    }
    if(original?.type==='verification_goal'&&'verificationVersion'in original)throw new Error('NATIVE_VERIFICATION_CANNOT_USE_HISTORICAL_FACT');
    const o=parseTrustedObservationWitnessV1(fresh.observation);
    if(!original||original.type!=='verification_goal'||o.status!=='complete'||o.sessionId!==a.freshSessionId||o.explorationAttemptId!==a.compilerAttemptId||
      o.testSpecId!==a.testSpecId||o.profileFingerprint!==a.profileFingerprint||!same(o.executionProfileRef,a.executionProfileRef)||
      Date.parse(o.observedAt)<Date.parse(a.startedAt)||Date.parse(o.observedAt)>Date.parse(a.finishedAt))throw new Error('INVALID_FRESH_VERIFICATION');
    const assertion=assertionFromStrategyV1(original);
    const request=assertion?.kind==='url'?{kind:'current_url'}:assertion?.kind==='semantic_count'?{kind:'semantic_query',query:assertion.query}:
      assertion?{kind:'target_property',query:assertion.query,property:assertion.property}:undefined;
    const frame=o.frame.kind==='main'?{kind:'main'}:o.frame.kind==='nested'?{kind:'nested',anchors:o.frame.anchors.map(({kind,value,exact})=>({kind,value,exact}))}:undefined;
    const expectedFrame=assertion?.kind==='url'?{kind:'main'}:assertion?.query.frame;
    if(!assertion||!same(o.request,request)||!same(frame,expectedFrame)||evaluateDeferredAssertionV1(assertion,o)!==original.evaluated)throw new Error('INVALID_FRESH_VERIFICATION_CORRESPONDENCE');
  }
  for(const fresh of a.freshNavigations){const original=trace.successfulPath.find(r=>r.recordId===fresh.traceRecordId);
    if(!original||original.type!=='navigate'||fresh.url!==original.url||fresh.before.sessionId!==a.freshSessionId||fresh.after.sessionId!==a.freshSessionId||
      fresh.before.pageId!==fresh.after.pageId||fresh.after.stateEpoch<=fresh.before.stateEpoch||fresh.after.mutationEpoch<=fresh.before.mutationEpoch||
      Date.parse(fresh.observedAt)<Date.parse(a.startedAt)||Date.parse(fresh.observedAt)>Date.parse(a.finishedAt))throw new Error('INVALID_FRESH_NAVIGATION');}
  for(const stop of a.executionStops){const original=trace.successfulPath.find(r=>r.recordId===stop.traceRecordId),execution=parseActionExecutionAttemptV1(stop.execution);
    if(!original||original.type!=='action_goal'||execution.status==='succeeded'||execution.goalId!==original.originStepId||
      execution.admissionDigest!==original.witness.execution.admissionDigest||execution.mappingDigest!==original.witness.execution.mappingDigest||execution.operation!==original.witness.execution.operation||
      Date.parse(execution.startedAt)<Date.parse(a.startedAt)||Date.parse(execution.finishedAt)>Date.parse(a.finishedAt))throw new Error('INVALID_COMPILER_EXECUTION_STOP');}
  if (a.result.status==='accepted' && (!a.freshSessionId || a.cleanup!=='verified' || a.checks.some(c=>!c.passed) ||
    a.executionStops.length!==0 ||
    !a.freshStartState||!a.freshFinalState||!a.checks.some(c=>c.kind==='profile'&&c.passed)||!a.checks.some(c=>c.kind==='cleanup'&&c.passed)||
    a.freshActions.length!==trace.successfulPath.filter(r=>r.type==='action_goal').length ||
    a.freshVerifications.length!==trace.successfulPath.filter(r=>r.type==='verification_goal').length ||
    a.freshNavigations.length!==trace.successfulPath.filter(r=>r.type==='navigate').length ||
    !trace.successfulPath.every(r=>(r.type==='action_goal'?['source','predicate','frame','execution','order']:r.type==='verification_goal'?['source','verification','order']:['source','order']).every(k=>a.checks.some(c=>c.traceRecordId===r.recordId&&c.kind===k&&c.passed))))) throw new Error('INCOMPLETE_COMPILER_ACCEPTANCE');
  if(a.result.status==='accepted'){
    let current=a.freshStartState!;
    const point=(v:{sessionId:string;pageId:string;stateDigest:string;stateEpoch:number;mutationEpoch:number})=>({sessionId:v.sessionId,pageId:v.pageId,stateDigest:v.stateDigest,stateEpoch:v.stateEpoch,mutationEpoch:v.mutationEpoch});
    if(current.sessionId!==a.freshSessionId)throw new Error('INVALID_FRESH_START');
    for(const record of trace.successfulPath){
      if(record.type==='action_goal'){const f=a.freshActions.find(x=>x.traceRecordId===record.recordId)!;
        if(!same(current,point(f.witness.postEffect.before)))throw new Error('INVALID_FRESH_ACTION_ORDER');current=point(f.retirement.after);
      }else if(record.type==='navigate'){const f=a.freshNavigations.find(x=>x.traceRecordId===record.recordId)!;
        if(!same(current,f.before))throw new Error('INVALID_FRESH_NAVIGATION_ORDER');current=f.after;
      }else{const f=a.freshVerifications.find(x=>x.traceRecordId===record.recordId)!;
        if(!same(current,point(f.observation)))throw new Error('INVALID_FRESH_VERIFICATION_ORDER');}
    }
    if(!same(current,a.freshFinalState))throw new Error('INVALID_FRESH_FINAL_STATE');
  }
  return a;
}
export function parseResolvedTestSpecV9(input: unknown, trace: SuccessfulExplorationTraceV5, compiler: CompilerAttemptV4): ResolvedTestSpecV9 {
  const r=ResolvedTestSpecV9Schema.parse(input), {resolvedDigest,...data}=r;
  parseCompilerAttemptV4(compiler,trace);
  if (hash(data)!==resolvedDigest || compiler.result.status!=='accepted' || r.resolvedSpecId!==compiler.result.resolvedSpecId ||
    r.compilerAttemptId!==compiler.compilerAttemptId || r.testSpecId!==trace.testSpecId || r.explorationAttemptId!==trace.explorationAttemptId ||
    r.successfulTraceId!==trace.successfulTraceId || r.traceDigest!==trace.traceDigest || r.profileFingerprint!==trace.profileFingerprint ||
    !same(r.executionProfileRef,trace.executionProfileRef) || r.admissionDigest!==trace.obligationHandoff.admissionDigest || r.executionSteps.length!==trace.successfulPath.length) throw new Error('INVALID_RESOLVED_V9');
  for (const [i,s] of r.executionSteps.entries()) {
    const record=trace.successfulPath[i]!;
    if (s.traceRecordId!==record.recordId || s.originStepId!==record.originStepId || s.type!==record.type) throw new Error('INVALID_V9_ORDER');
    if (s.type==='navigate' && record.type==='navigate' && s.url!==record.url) throw new Error('INVALID_V9_NAVIGATION');
    if(s.type==='verification_goal'&&record.type==='verification_goal'){
      const fresh=compiler.freshVerifications.find(f=>f.traceRecordId===record.recordId)?.observation;
      const expected='verificationVersion'in record?(fresh?.observationVersion==='2'?nativeOptionAssertion(record.strategy,fresh):undefined):assertionFromStrategyV1(record);
      if(s.goalStepId!==record.goalStepId||!expected||!same(s.assertion,expected))throw new Error('INVALID_V9_VERIFICATION');
    }
    if (s.type==='action_goal' && record.type==='action_goal') {
      const fresh=compiler.freshActions.find(a=>a.traceRecordId===record.recordId)?.witness;
      if (!fresh) throw new Error('MISSING_FRESH_WITNESS');
      const p=fresh.finalCheck,candidate=p.candidateObservation.status==='complete'&&p.candidateObservation.candidates.find(c=>c.selectedRef===p.selectedRef&&c.frameId===p.frameId),effect=fresh.postEffect.effect;
      const control=effect.kind==='entered_text'?effect.nativeControl:effect.kind==='native_choice'?'select':effect.nativeInputType;
      if (!candidate || !same(s.guard.sourceGoal,p.sourceGoal) || !same(s.guard.correspondence,p.correspondence) || !same(s.guard.request,p.candidateObservation.request) ||
        !same(s.guard.predicate,p.candidateObservation.predicate) || s.guard.mappingDigest!==p.mappingDigest || !same(s.guard.frame,durableDeferredFrame(candidate.frame)) ||
        s.operation!==p.operation || s.authoredArgument!==p.argument?.authoredText || s.executableArgument!==p.argument?.executableValue ||
        s.guard.nativeEffect!==effect.kind || s.guard.nativeControl!==control) throw new Error('INVALID_V9_SOURCE_GUARD_ARGUMENT');
    }
  }
  if (new Set(r.executionSteps.map(s=>s.id)).size!==r.executionSteps.length) throw new Error('INVALID_V9_IDS');
  return r;
}
