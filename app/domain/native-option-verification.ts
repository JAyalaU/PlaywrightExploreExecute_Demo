import { z } from 'zod';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { ExecutionProfileRefSchema } from './schema.js';
import { NativeOptionVerificationGoalV2Schema } from './native-option-verification-goal.js';
import { DeterministicVerificationAssertionV1Schema } from './goal-directed-compiler.js';

const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const NativeOptionFrameSchema=z.union([z.strictObject({kind:z.literal('main')}),z.strictObject({kind:z.literal('nested'),anchors:z.array(z.strictObject({kind:z.enum(['title','testId']),value:z.string().min(1).max(512),exact:z.literal(true)})).min(1).max(8)})]);
export const NativeOptionPredicateSchema=z.strictObject({domain:z.literal('all_current_page_frames'),frameLimit:z.literal(8),candidateLimit:z.literal(80),optionLimit:z.literal(80),controlConstraints:NativeOptionVerificationGoalV2Schema.shape.claim.shape.controlConstraints});
export const NativeOptionFactSchema=z.strictObject({label:z.string().max(1024),text:z.string().max(1024),value:z.string().max(1024),disabled:z.boolean(),selected:z.boolean(),owned:z.literal(true)});
export const NativeLabelOwnershipSchema=z.strictObject({controlId:z.string().max(512).nullable(),sources:z.array(z.strictObject({sourceId:z.string().max(512).nullable(),kind:z.enum(['native_for','native_wrapped','aria_labelledby']),forId:z.string().max(512).nullable(),idRefs:z.array(z.string().min(1).max(512)).max(16),owned:z.literal(true)})).max(16)});
export const NativeOptionProofSchema=z.strictObject({kind:z.literal('native_owned_option_state'),candidateComplete:z.literal(true),candidateCount:z.literal(1),optionsComplete:z.literal(true),optionCount:z.number().int().min(1).max(80),labelMatchCount:z.literal(1),valueMatchCount:z.literal(1),predicate:NativeOptionPredicateSchema,frame:NativeOptionFrameSchema,controlId:id,optionId:id,labelSourceIds:z.array(id).max(128),labelOwnershipDigest:digest,labelOwnership:NativeLabelOwnershipSchema.nullable(),options:z.array(NativeOptionFactSchema).min(1).max(80),optionLabel:z.string().min(1).max(1024),optionValue:z.string().max(1024),selected:z.boolean()});
const owner={observationVersion:z.literal('2'),observationId:id,testSpecId:id,explorationAttemptId:id,sessionId:id,pageId:id,executionProfileRef:ExecutionProfileRefSchema,profileFingerprint:digest,stateDigest:digest,stateEpoch:z.number().int().nonnegative(),mutationEpoch:z.number().int().nonnegative(),observedAt:z.iso.datetime(),goalStepId:id,admissionDigest:digest,claimDigest:digest};
export const NativeOptionObservationV2Schema=z.union([z.strictObject({...owner,status:z.literal('complete'),result:NativeOptionProofSchema,witnessDigest:digest}),z.strictObject({...owner,status:z.literal('error'),complete:z.literal(false),reason:z.enum(['NO_MATCH','NON_UNIQUE','OPTION_ABSENT','OPTION_NON_UNIQUE','VALUE_NON_UNIQUE','RESULT_LIMIT','UNSUPPORTED_CONTROL','UNPROVEN_FRAME','STALE_STATE','QUERY_UNEVALUABLE']),witnessDigest:digest})]);
export type NativeOptionObservationV2=z.infer<typeof NativeOptionObservationV2Schema>;
export const NativeOptionComparisonV2Schema=z.strictObject({comparisonVersion:z.literal('2'),kind:z.literal('native_owned_option_selected'),observationId:id,expectedSelected:z.boolean()});
export const NativeOptionStrategyV2Schema=z.strictObject({strategyVersion:z.literal('2'),goalStepId:id,goalDigest:digest,claimDigest:digest,admissionDigest:digest,observationIds:z.array(id).length(1),observations:z.array(NativeOptionObservationV2Schema).length(1),comparison:NativeOptionComparisonV2Schema,evaluated:z.boolean(),conclusion:z.enum(['satisfied','unsatisfied']),testSpecId:id,explorationAttemptId:id,sessionId:id,pageId:id,actionOrdinal:z.number().int().nonnegative(),strategyDigest:digest});
export type NativeOptionStrategyV2=z.infer<typeof NativeOptionStrategyV2Schema>;
export const NativeOptionVerificationRecordV5Schema=z.strictObject({type:z.literal('verification_goal'),verificationVersion:z.literal('2'),recordId:id,sequence:z.number().int().positive(),source:z.literal('authored'),originStepId:id,goalStepId:id,goalDigest:digest,preStateDigest:digest,postStateDigest:digest,strategyDigest:digest,actionOrdinal:z.number().int().nonnegative(),observationIds:z.array(id).length(1),observations:z.array(NativeOptionObservationV2Schema).length(1),comparison:NativeOptionComparisonV2Schema,evaluated:z.boolean(),conclusion:z.enum(['satisfied','unsatisfied']),strategy:NativeOptionStrategyV2Schema});
export const NativeOptionAssertionV2Schema=z.strictObject({assertionVersion:z.literal('2'),kind:z.literal('native_owned_option_selected'),sourceStrategyDigest:digest,sourceClaimDigest:digest,controlPredicate:NativeOptionPredicateSchema,optionLabel:z.string().min(1).max(1024),expectedSelected:z.boolean(),frame:NativeOptionFrameSchema,compiledOptionValue:z.string().max(1024),compiledLabelOwnershipDigest:digest,mappingPolicy:z.literal('require_fresh_mapping_equal_compiled_argument')});
export type NativeOptionAssertionV2=z.infer<typeof NativeOptionAssertionV2Schema>;
export const DeferredVerificationAssertionSchema=z.union([DeterministicVerificationAssertionV1Schema,NativeOptionAssertionV2Schema]);
export type DeferredVerificationAssertion=z.infer<typeof DeferredVerificationAssertionSchema>;
export const nativeOptionPredicate=(goal:z.infer<typeof NativeOptionVerificationGoalV2Schema>)=>NativeOptionPredicateSchema.parse({domain:'all_current_page_frames',frameLimit:8,candidateLimit:80,optionLimit:80,controlConstraints:goal.claim.controlConstraints});
export function validateNativeOptionProof(input:unknown){const p=NativeOptionProofSchema.parse(input),m=p.options.filter(v=>v.label===p.optionLabel),l=p.labelOwnership;
 if(p.controlId===p.optionId||new Set(p.labelSourceIds).size!==p.labelSourceIds.length||p.labelSourceIds.includes(p.controlId)||p.labelSourceIds.includes(p.optionId)||hash(l)!==p.labelOwnershipDigest||p.optionCount!==p.options.length||m.length!==1||m[0]!.value!==p.optionValue||m[0]!.selected!==p.selected||p.options.filter(v=>v.value===p.optionValue).length!==1||
   p.predicate.controlConstraints.some(c=>c.kind==='label')!==!!l||!l&&p.labelSourceIds.length!==0||l&&(!l.sources.length||l.sources.length!==p.labelSourceIds.length||l.sources.some(s=>s.kind==='native_for'?s.forId===null||s.forId!==l.controlId||s.idRefs.length!==0:s.kind==='native_wrapped'?s.forId!==null||s.idRefs.length!==0:s.sourceId===null||!s.idRefs.includes(s.sourceId))))throw new Error('INVALID_NATIVE_OPTION_MAPPING');
 return p;
}
export function parseNativeOptionObservationV2(input:unknown):NativeOptionObservationV2{
 const o=NativeOptionObservationV2Schema.parse(input),{witnessDigest,...data}=o;
 if(hash(data)!==witnessDigest)throw new Error('INVALID_NATIVE_OPTION_OBSERVATION');
 if(o.status==='complete')validateNativeOptionProof(o.result);
 return o;
}
export function parseNativeOptionStrategyV2(input:unknown):NativeOptionStrategyV2{
 const s=NativeOptionStrategyV2Schema.parse(input),{strategyDigest,...data}=s,o=parseNativeOptionObservationV2(s.observations[0]);
 if(hash(data)!==strategyDigest||o.status!=='complete'||s.observationIds[0]!==o.observationId||s.comparison.observationId!==o.observationId||s.evaluated!==(o.result.selected===s.comparison.expectedSelected)||s.conclusion!==(s.evaluated?'satisfied':'unsatisfied')||s.goalStepId!==o.goalStepId||s.claimDigest!==o.claimDigest||s.admissionDigest!==o.admissionDigest||s.sessionId!==o.sessionId||s.pageId!==o.pageId||s.testSpecId!==o.testSpecId||s.explorationAttemptId!==o.explorationAttemptId)throw new Error('INVALID_NATIVE_OPTION_STRATEGY');
 return s;
}
export function nativeOptionAssertion(s:NativeOptionStrategyV2,o:NativeOptionObservationV2):NativeOptionAssertionV2{
 parseNativeOptionStrategyV2(s);parseNativeOptionObservationV2(o);if(o.status!=='complete'||o.goalStepId!==s.goalStepId||o.claimDigest!==s.claimDigest)throw new Error('INVALID_NATIVE_OPTION_PROJECTION');
 return NativeOptionAssertionV2Schema.parse({assertionVersion:'2',kind:'native_owned_option_selected',sourceStrategyDigest:s.strategyDigest,sourceClaimDigest:s.claimDigest,controlPredicate:o.result.predicate,optionLabel:o.result.optionLabel,expectedSelected:s.comparison.expectedSelected,frame:o.result.frame,compiledOptionValue:o.result.optionValue,compiledLabelOwnershipDigest:o.result.labelOwnershipDigest,mappingPolicy:'require_fresh_mapping_equal_compiled_argument'});
}
