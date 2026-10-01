import { z } from 'zod';
import { ExecutionProfileRefSchema } from './schema.js';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { DeterministicVerificationAssertionV1Schema } from './goal-directed-compiler.js';
import {DeferredVerificationAssertionSchema,NativeOptionProofSchema,validateNativeOptionProof} from './native-option-verification.js';
const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const DeferredRunnerStopV9Schema=z.enum(['UNAUTHENTICATED_INPUT','PROFILE_MISMATCH','NON_UNIQUE_MATCH','TARGET_MISMATCH',
  'LABEL_ASSOCIATION_MISMATCH','OPTION_MAPPING_MISMATCH','FRAME_MISMATCH','INCOMPLETE_EVIDENCE','STALE_EVIDENCE',
  'UNSUPPORTED_CAPABILITY','VERIFICATION_UNEVALUABLE','ACTION_FAILED_PARTIAL_OR_UNKNOWN','POST_EFFECT_UNPROVEN',
  'ENVIRONMENT_FAILURE','CLEANUP_UNVERIFIED','STATE_CONTINUITY_MISMATCH','BUDGET_EXHAUSTED']);
export type DeferredRunnerStopV9=z.infer<typeof DeferredRunnerStopV9Schema>;
export const DeferredRunStateV9Schema=z.strictObject({sessionId:id,pageId:id,stateDigest:digest,stateEpoch:z.number().int().nonnegative(),mutationEpoch:z.number().int().nonnegative()});
export type DeferredRunStateV9=z.infer<typeof DeferredRunStateV9Schema>;
export const DeferredVerificationFactsV9Schema=z.strictObject({assertion:DeferredVerificationAssertionSchema,actual:z.union([z.boolean(),z.string().max(2048),z.number().int().nonnegative()]),evaluated:z.boolean()});
export type DeferredVerificationFactsV9=z.infer<typeof DeferredVerificationFactsV9Schema>;
export const DeferredEffectV9Schema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('entered_text'),nativeControl:z.enum(['input','textarea']),value:z.string().max(1024)}),
  z.strictObject({kind:z.literal('native_choice'),complete:z.literal(true),label:z.string().max(1024),value:z.string().max(1024),options:z.array(z.strictObject({label:z.string().max(1024),text:z.string().max(1024),value:z.string().max(1024),disabled:z.boolean(),selected:z.boolean(),owned:z.literal(true)})).max(80)}),
  z.strictObject({kind:z.literal('native_activation'),executionId:id,nativeInputType:z.enum(['checkbox','radio']),beforeChecked:z.boolean(),checked:z.boolean(),clicks:z.literal(1),targetOwned:z.literal(true)})]);
export const DeferredRunnerRecordV9Schema=z.strictObject({runnerVersion:z.literal('9'),executionRunId:id,startedAt:z.iso.datetime(),finishedAt:z.iso.datetime(),
  provenance:z.strictObject({testSpecId:id,resolvedSpecId:id,resolvedDigest:digest,compilerAttemptId:id,traceDigest:digest,admissionDigest:digest,
    executionProfileRef:ExecutionProfileRefSchema,profileFingerprint:digest,sessionId:id.optional()}).optional(),cleanup:z.enum(['verified','unverified']),
  startState:DeferredRunStateV9Schema.optional(),finalState:DeferredRunStateV9Schema.optional(),
  steps:z.array(z.strictObject({stepId:id,traceRecordId:id,originStepId:id,type:z.enum(['action_goal','navigate','verification_goal']),
    status:z.enum(['succeeded','assertion_passed','assertion_failed','stopped']),before:DeferredRunStateV9Schema,after:DeferredRunStateV9Schema,afterStateStatus:z.enum(['observed','unavailable']),
    predicateDigest:digest.optional(),operation:z.enum(['fill','select_option','click']).optional(),argument:z.string().max(1024).optional(),
    invocation:z.enum(['not_invoked','returned','threw']),mutationMayHaveOccurred:z.boolean(),effectDigest:digest.optional(),effect:DeferredEffectV9Schema.optional(),verification:DeferredVerificationFactsV9Schema.optional(),verificationProof:z.strictObject({proofVersion:z.literal('2'),proofId:id,sessionId:id,pageId:id,stateDigest:digest,stateEpoch:z.number().int().nonnegative(),mutationEpoch:z.number().int().nonnegative(),result:NativeOptionProofSchema,proofDigest:digest}).optional(),reasonCode:DeferredRunnerStopV9Schema.optional(),
    invokedAt:z.iso.datetime().optional(),returnedAt:z.iso.datetime().optional()})).max(100),
  result:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('completed'),assertions:z.number().int().nonnegative(),passed:z.boolean()}),
    z.strictObject({kind:z.literal('non_qa_stop'),reasonCode:DeferredRunnerStopV9Schema,failedStepId:id.optional()})]),recordDigest:digest});
export type DeferredRunnerRecordV9=z.infer<typeof DeferredRunnerRecordV9Schema>;
/** Serialization integrity only; successful parsing does not issue runner origin. */
export function parseDeferredRunnerRecordV9(input:unknown):DeferredRunnerRecordV9 {
  const r=DeferredRunnerRecordV9Schema.parse(input),{recordDigest,...data}=r;
  if(hash(data)!==recordDigest||Date.parse(r.finishedAt)<Date.parse(r.startedAt)||new Set(r.steps.map(s=>s.stepId)).size!==r.steps.length)throw new Error('INVALID_RUN_V9');
  if(new Set(r.steps.flatMap(s=>s.verificationProof?[s.verificationProof.proofId]:[])).size!==r.steps.filter(s=>s.verificationProof).length)throw new Error('DUPLICATE_NATIVE_PROOF');
  let current=r.startState;
  for(const s of r.steps){if(!current||hash(current)!==hash(s.before)||s.before.sessionId!==r.provenance?.sessionId||s.after.sessionId!==s.before.sessionId||
    s.after.pageId!==s.before.pageId||s.after.stateEpoch<s.before.stateEpoch||s.after.mutationEpoch<s.before.mutationEpoch||
    s.mutationMayHaveOccurred!==(s.invocation!=='not_invoked')||s.type==='action_goal'&&s.status==='succeeded'&&(!s.effectDigest||s.invocation!=='returned'||!s.predicateDigest)||
    s.status==='stopped'&&!s.reasonCode||s.status!=='stopped'&&s.afterStateStatus!=='observed'||s.effectDigest!==undefined&&(!s.effect||hash(s.effect)!==s.effectDigest)||s.effect!==undefined&&(s.status!=='succeeded'||s.type!=='action_goal')||
    s.type==='verification_goal'&&s.status!=='stopped'&&(!s.verification||s.verification.evaluated!==(s.status==='assertion_passed')))throw new Error('INVALID_RUN_STEP_V9');
    if(s.verification?.assertion.assertionVersion==='2'){
      const a=s.verification.assertion,p=s.verificationProof;
      if(!p||!['assertion_passed','assertion_failed'].includes(s.status)||s.type!=='verification_goal'||s.invocation!=='not_invoked'||p.sessionId!==s.before.sessionId||p.pageId!==s.before.pageId||p.stateDigest!==s.before.stateDigest||p.stateEpoch!==s.before.stateEpoch||p.mutationEpoch!==s.before.mutationEpoch||hash(s.before)!==hash(s.after))throw new Error('INVALID_NATIVE_VERIFICATION_PROOF_OWNER');
      validateNativeOptionProof(p.result);
      const {proofDigest,...data}=p,m=p.result.options.filter(o=>o.label===a.optionLabel);
      if(hash(data)!==proofDigest||hash(p.result.labelOwnership)!==p.result.labelOwnershipDigest||hash(p.result.predicate)!==hash(a.controlPredicate)||hash(p.result.frame)!==hash(a.frame)||p.result.optionLabel!==a.optionLabel||p.result.optionValue!==a.compiledOptionValue||p.result.labelOwnershipDigest!==a.compiledLabelOwnershipDigest||m.length!==1||p.result.options.filter(o=>o.value===a.compiledOptionValue).length!==1||p.result.optionCount!==p.result.options.length||m[0]!.value!==a.compiledOptionValue||m[0]!.selected!==p.result.selected||s.verification.actual!==p.result.selected||s.verification.evaluated!==(p.result.selected===a.expectedSelected))throw new Error('INVALID_NATIVE_VERIFICATION_PROOF');
    }else if(s.verificationProof)throw new Error('UNEXPECTED_NATIVE_VERIFICATION_PROOF');
    current=s.after;}
  if(r.result.kind==='completed'&&(!r.provenance||r.cleanup!=='verified'||!r.startState||!r.finalState||hash(current)!==hash(r.finalState)||
    r.steps.some(s=>s.status==='stopped')||r.result.assertions!==r.steps.filter(s=>s.type==='verification_goal').length||r.result.passed!==!r.steps.some(s=>s.status==='assertion_failed')))throw new Error('INCOMPLETE_RUN_V9');
  return r;
}
