import {semanticAdmissionDigestV2} from '../domain/action-semantic-admission.js';
import { z } from 'zod';
import { NativeOptionObservationSessionV2 } from '../exploration/native-option-observation.js';
import { NativeOptionVerificationGoalV2Schema,type NativeOptionVerificationGoalV2 } from '../domain/native-option-verification-goal.js';
import { NativeOptionComparisonV2Schema,NativeOptionStrategyV2Schema,nativeOptionPredicate,parseNativeOptionStrategyV2,type NativeOptionObservationV2,type NativeOptionStrategyV2 } from '../domain/native-option-verification.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { ActionCandidateGroundingSessionV1 } from '../exploration/action-candidate-grounding.js';
import { createOpenAIResponsesClient,type OpenAIResponsesConfig } from './openai-responses.js';
import { ModelCompletionFailure } from './model-failure.js';
import { NativeOptionDecisionV6Schema,normalizeNativeOptionDecisionWire,NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT } from './native-option-verification-wire.js';
export {NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT} from './native-option-verification-wire.js';
type NativeOptionModelFact={observationVersion:'2';observationId:string;status:'complete';result:{kind:'native_owned_option_state';selected:boolean}}|{observationVersion:'2';observationId:string;status:'error';reason:string};
export interface NativeOptionVerificationModelV6{complete(input:{systemInstruction:string;context:{decisionVersion:'6';goal:NativeOptionVerificationGoalV2;admissionDigest:string;claimDigest:string;observations:NativeOptionModelFact[];stepOrdinal:number;actionOrdinal:number};signal:AbortSignal}):Promise<string>}
export function createOpenAINativeOptionVerificationModelV6(config:OpenAIResponsesConfig):NativeOptionVerificationModelV6{const client=createOpenAIResponsesClient(config);return{async complete({systemInstruction,context,signal}){const r=await client.complete({systemInstruction,input:JSON.stringify(context),format:NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT,signal});if(r.kind==='failure')throw new ModelCompletionFailure(r.code);try{return normalizeNativeOptionDecisionWire(JSON.parse(r.output));}catch{throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID');}}};}
const instruction='Use the admitted native-owned-option selection claim unchanged. Choose its reviewed read-only native_owned_option_state observation by exact goal/admission/claim reference, then compare its native selected boolean to the admitted expectedSelected boolean. Return decisionVersion 6. No locators, discovered owner constraints, DOM values, source reinterpretation, or action-success evidence. An absent/ambiguous/incomplete observation is unresolved, never negative truth.';
export interface NativeOptionVerificationEvaluationV2 { conclusion:'satisfied'|'unsatisfied'|'unresolved'|'unsupported';
 strategy?:NativeOptionStrategyV2; reason?:string; comparisonAttempted?:boolean;
 decisionKind?:'observe'|'conclude'; decisionTurn?:number;
 stop?:{category:string;code:string}; }
export class NativeOptionVerificationControllerV2{
 readonly #observations:NativeOptionObservationSessionV2;readonly #runtime:ActionCandidateGroundingSessionV1;readonly #model:NativeOptionVerificationModelV6;
 readonly #strategies=new Map<string,NativeOptionStrategyV2>();
 constructor(observations:NativeOptionObservationSessionV2,runtime:ActionCandidateGroundingSessionV1,model:NativeOptionVerificationModelV6){this.#observations=observations;this.#runtime=runtime;this.#model=model;NativeOptionObservationSessionV2.prototype.owner.call(observations,runtime);}
 protectedStrategy(runtime:ActionCandidateGroundingSessionV1,goalId:string){if(runtime!==this.#runtime)throw new Error('Native verification owner mismatch');NativeOptionObservationSessionV2.prototype.owner.call(this.#observations,runtime);const s=this.#strategies.get(goalId);return s&&structuredClone(s);}
 async #evaluatePoc(goal:NativeOptionVerificationGoalV2,signal?:AbortSignal):Promise<NativeOptionVerificationEvaluationV2>{
  const owner=NativeOptionObservationSessionV2.prototype.owner.call(this.#observations,this.#runtime);
  const witnesses=ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(this.#runtime);
  const dependency=goal.dependsOnStepId?owner.admission.spec.steps.find(step=>step.id===goal.dependsOnStepId):undefined;
  if(dependency?.type==='action_goal'&&!witnesses.some(witness=>witness.preparation.goalId===dependency.id))
   return{conclusion:'unresolved',reason:'DEPENDENCY_UNFULFILLED',comparisonAttempted:false};
  if(signal?.aborted)return{conclusion:'unresolved',reason:'CANCELLED',comparisonAttempted:false,
   stop:{category:'environment',code:'CANCELLED'}};
  const actionOrdinal=witnesses.length,admissionDigest=semanticAdmissionDigestV2(owner.admission.record),claimDigest=hash(goal.claim);
  try{
   const observation=await NativeOptionObservationSessionV2.prototype.observe.call(this.#observations,goal.id);
   if(signal?.aborted)return{conclusion:'unresolved',reason:'CANCELLED',comparisonAttempted:false,
    stop:{category:'environment',code:'CANCELLED'}};
   if(observation.status==='error')return{conclusion:observation.reason==='UNSUPPORTED_CONTROL'?'unsupported':'unresolved',
    reason:observation.reason,comparisonAttempted:false,decisionKind:'observe',decisionTurn:1,
    stop:{category:observation.reason==='UNSUPPORTED_CONTROL'?'unsupported':'unresolved',
     code:observation.reason==='NO_MATCH'?'NO_CANDIDATES':observation.reason}};
   if(observation.goalStepId!==goal.id||observation.testSpecId!==owner.admission.spec.testSpecId||
    observation.explorationAttemptId!==owner.attemptId||observation.sessionId!==owner.sessionId||
    observation.admissionDigest!==admissionDigest||observation.claimDigest!==claimDigest||
    observation.result.optionLabel!==goal.claim.optionLabel||
    hash(observation.result.predicate)!==hash(nativeOptionPredicate(goal)))
    return{conclusion:'unresolved',reason:'OBSERVATION_CLAIM_MISMATCH',comparisonAttempted:false};
   if(!await NativeOptionObservationSessionV2.prototype.currentEvidence.call(this.#observations,observation))
    return{conclusion:'unresolved',reason:'EVIDENCE_STALE',comparisonAttempted:false};
   const comparison=NativeOptionComparisonV2Schema.parse({comparisonVersion:'2',kind:'native_owned_option_selected',
    observationId:observation.observationId,expectedSelected:goal.claim.expectedSelected});
   const evaluated=observation.result.selected===comparison.expectedSelected;
   const draft=NativeOptionStrategyV2Schema.parse({strategyVersion:'2',goalStepId:goal.id,goalDigest:hash(goal),
    claimDigest,admissionDigest,observationIds:[observation.observationId],observations:[observation],comparison,
    evaluated,conclusion:evaluated?'satisfied':'unsatisfied',testSpecId:observation.testSpecId,
    explorationAttemptId:observation.explorationAttemptId,sessionId:observation.sessionId,pageId:observation.pageId,
    actionOrdinal,strategyDigest:'0'.repeat(64)});
   const{strategyDigest:_digest,...data}=draft,strategy=parseNativeOptionStrategyV2({...data,strategyDigest:hash(data)});
   this.#strategies.set(goal.id,strategy);
   return{conclusion:strategy.conclusion,strategy,comparisonAttempted:true,decisionKind:'conclude',decisionTurn:1};
  }catch{return{conclusion:'unresolved',reason:'VERIFICATION_UNRESOLVED',comparisonAttempted:false,
   stop:{category:'integrity',code:'VERIFICATION_UNRESOLVED'}};}
 }
 async evaluate(goalInput:unknown,stepOrdinal:number,signal?:AbortSignal):Promise<NativeOptionVerificationEvaluationV2>{const goal=NativeOptionVerificationGoalV2Schema.parse(goalInput),owner=NativeOptionObservationSessionV2.prototype.owner.call(this.#observations,this.#runtime);
  if(hash(goal)!==hash(owner.admission.spec.steps[stepOrdinal]))throw new Error('Native verification source/order mismatch');
  if(owner.admission.spec.semanticMode==='poc_v1')return this.#evaluatePoc(goal,signal);
  const observations:NativeOptionObservationV2[]=[],admissionDigest=semanticAdmissionDigestV2(owner.admission.record),claimDigest=hash(goal.claim),actionOrdinal=ActionCandidateGroundingSessionV1.prototype.protectedSuccessfulGroundingWitnesses.call(this.#runtime).length,abort=new AbortController(),onAbort=()=>abort.abort();signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)abort.abort();const timer=setTimeout(()=>abort.abort(),30000);
  let decisionKind:'observe'|'conclude'|undefined,decisionTurn:number|undefined,requestReason:string|undefined;
  const decisionMetadata=()=>({...(decisionKind?{decisionKind}:{}),...(decisionTurn?{decisionTurn}: {})});
  try{for(let turn=0;turn<4;turn++){decisionTurn=turn+1;decisionKind=undefined;if(abort.signal.aborted)return{conclusion:'unresolved' as const,reason:'PROVIDER_TIMEOUT',...decisionMetadata()};const output=await Promise.race([this.#model.complete({systemInstruction:instruction,context:{decisionVersion:'6',goal,admissionDigest,claimDigest,observations:observations.map(o=>o.status==='complete'?{observationVersion:'2' as const,observationId:o.observationId,status:'complete' as const,result:{kind:'native_owned_option_state' as const,selected:o.result.selected}}:{observationVersion:'2' as const,observationId:o.observationId,status:'error' as const,reason:o.reason}),stepOrdinal,actionOrdinal},signal:abort.signal}),new Promise<never>((_r,j)=>abort.signal.addEventListener('abort',()=>j(new Error('Native verification deadline')),{once:true}))]);if(output.length>4096)throw new Error('Native decision limit');const decision=NativeOptionDecisionV6Schema.parse(JSON.parse(output));decisionKind=decision.kind;
   if(decision.kind==='observe'){
    if(observations.length)requestReason='REPEAT_OBSERVE_REQUEST';
    else if(decision.request.goalStepId!==goal.id)requestReason='REQUEST_GOAL_MISMATCH';
    else if(decision.request.admissionDigest!==admissionDigest)requestReason='REQUEST_ADMISSION_MISMATCH';
    else if(decision.request.claimDigest!==claimDigest)requestReason='REQUEST_CLAIM_MISMATCH';
    if(requestReason)throw new Error('Native request source mismatch');
    const observed=await NativeOptionObservationSessionV2.prototype.observe.call(this.#observations,goal.id);observations.push(observed);if(observed.status==='error')return{conclusion:observed.reason==='UNSUPPORTED_CONTROL'?'unsupported' as const:'unresolved' as const,stop:{category:observed.reason==='UNSUPPORTED_CONTROL'?'unsupported':'unresolved',code:observed.reason==='NO_MATCH'?'NO_CANDIDATES':observed.reason},...decisionMetadata()};continue;}
   if(!['satisfied','unsatisfied'].includes(decision.conclusion))return{conclusion:decision.conclusion,reason:decision.conclusion==='unsupported'?'MODEL_UNSUPPORTED':'MODEL_UNRESOLVED',comparisonAttempted:!!decision.comparison,...decisionMetadata()};const o=observations[0],c=decision.comparison;
   if(!o)return{conclusion:'unresolved' as const,reason:'OBSERVATION_MISSING',comparisonAttempted:!!c,...decisionMetadata()};
   if(o.status!=='complete')return{conclusion:'unresolved' as const,reason:o.reason,comparisonAttempted:!!c,...decisionMetadata()};
   if(!c)return{conclusion:'unresolved' as const,reason:'COMPARISON_MISSING',comparisonAttempted:false,...decisionMetadata()};
   if(c.observationId!==o.observationId)return{conclusion:'unresolved' as const,reason:'COMPARISON_OBSERVATION_MISMATCH',comparisonAttempted:true,...decisionMetadata()};
   if(c.expectedSelected!==goal.claim.expectedSelected)return{conclusion:'unresolved' as const,reason:'COMPARISON_EXPECTED_MISMATCH',comparisonAttempted:true,...decisionMetadata()};
   if(!await NativeOptionObservationSessionV2.prototype.currentEvidence.call(this.#observations,o))return{conclusion:'unresolved' as const,reason:'EVIDENCE_STALE',comparisonAttempted:true,...decisionMetadata()};
   const evaluated=o.result.selected===c.expectedSelected;if(decision.conclusion!==(evaluated?'satisfied':'unsatisfied'))throw new Error('Native comparison mismatch');
   const draft=NativeOptionStrategyV2Schema.parse({strategyVersion:'2',goalStepId:goal.id,goalDigest:hash(goal),claimDigest,admissionDigest,observationIds:[o.observationId],observations:[o],comparison:c,evaluated,conclusion:decision.conclusion,testSpecId:o.testSpecId,explorationAttemptId:o.explorationAttemptId,sessionId:o.sessionId,pageId:o.pageId,actionOrdinal,strategyDigest:'0'.repeat(64)}),{strategyDigest:_d,...data}=draft,strategy=parseNativeOptionStrategyV2({...data,strategyDigest:hash(data)});this.#strategies.set(goal.id,strategy);return{conclusion:strategy.conclusion,strategy,comparisonAttempted:true,...decisionMetadata()};
  }return{conclusion:'unresolved' as const,reason:'DECISION_LIMIT',...decisionMetadata()};}catch(error){return{conclusion:'unresolved' as const,comparisonAttempted:error instanceof Error&&error.message==='Native comparison mismatch',reason:error instanceof ModelCompletionFailure?error.code:abort.signal.aborted?signal?.aborted?'CANCELLED':'PROVIDER_TIMEOUT':error instanceof SyntaxError?'INVALID_DECISION_JSON':error instanceof z.ZodError?'INVALID_DECISION_SCHEMA':error instanceof Error&&error.message==='Native comparison mismatch'?'CLAIM_CONTRADICTS_FACT':error instanceof Error&&error.message==='Native request source mismatch'?requestReason??'REQUEST_SOURCE_MISMATCH':'VERIFICATION_UNRESOLVED',...decisionMetadata(),stop:error instanceof ModelCompletionFailure?{category: ['PROVIDER_CONFIGURATION_ERROR','PROVIDER_INPUT_INVALID'].includes(error.code)?'environment':'provider',code:error.code}:abort.signal.aborted?{category:'environment',code:signal?.aborted?'CANCELLED':'PROVIDER_TIMEOUT'}:{category:'integrity',code:'VERIFICATION_UNRESOLVED'}};}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}}
}
