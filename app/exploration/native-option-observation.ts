import {semanticAdmissionDigestV2} from '../domain/action-semantic-admission.js';
import { randomUUID } from 'node:crypto';
import type { McpExplorationSession } from './mcp.js';
import { ActionCandidateGroundingSessionV1 } from './action-candidate-grounding.js';
import { NativeOptionObservationV2Schema,nativeOptionPredicate,parseNativeOptionObservationV2,type NativeOptionObservationV2 } from '../domain/native-option-verification.js';
import { readNativeOwnedOptionState,nativeOptionIdentityJournal,NativeOptionReadError,type NativeOptionReadDiagnostic } from '../browser-action/native-option-state.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { NativeOptionVerificationGoalV2Schema } from '../domain/native-option-verification-goal.js';
import { probeVerificationObservation,type PrivateObservationProbe } from './verification-observation-diagnostics.js';

/** Separate deferred-only journal. Parsing records never creates protected observation origin. */
export class NativeOptionObservationSessionV2{
 readonly #session:McpExplorationSession;readonly #runtime:ActionCandidateGroundingSessionV1;
 readonly #records=new Map<string,NativeOptionObservationV2>();readonly #listeners=new Set<(o:NativeOptionObservationV2)=>void>();readonly #identities=nativeOptionIdentityJournal();
 readonly #privateAttemptListeners=new Set<(probe:PrivateObservationProbe)=>void>();
 readonly #diagnostics=new Map<string,NativeOptionReadDiagnostic>();
 constructor(session:McpExplorationSession,runtime:ActionCandidateGroundingSessionV1){this.#session=session;this.#runtime=runtime;NativeOptionObservationSessionV2.prototype.owner.call(this,runtime);session.browserSession.onClosing(async()=>{await this.#identities.close();});}
 owner(runtime:ActionCandidateGroundingSessionV1){if(runtime!==this.#runtime)throw new Error('Native observer owner mismatch');return ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(runtime,this.#session);}
 onProtectedRecord(listener:(o:NativeOptionObservationV2)=>void){NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime);this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
 onPrivateObservationAttempt(listener:(probe:PrivateObservationProbe)=>void){this.#privateAttemptListeners.add(listener);return()=>this.#privateAttemptListeners.delete(listener);}
 protectedRecord(id:string){NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime);const value=this.#records.get(id);return value&&structuredClone(value);}
 protectedDiagnostic(goalId:string){NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime);const value=this.#diagnostics.get(goalId);return value&&structuredClone(value);}
 async currentEvidence(input:unknown){const parsed=NativeOptionObservationV2Schema.safeParse(input);if(!parsed.success||parsed.data.status!=='complete'||hash(this.#records.get(parsed.data.observationId))!==hash(parsed.data))return undefined;
  try{return await this.#session.withExclusiveGrounding(async()=>{const state=await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime);if(state.pageId!==parsed.data.pageId||state.stateDigest!==parsed.data.stateDigest||state.stateEpoch!==parsed.data.stateEpoch||state.mutationEpoch!==parsed.data.mutationEpoch)return undefined;
    const value=parsed.data;if(value.status!=='complete')return undefined;const deadline=Date.now()+15000;
    const renewed=await readNativeOwnedOptionState(state.page,value.result.predicate,value.result.optionLabel,()=>ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime).then(({page:_p,frames:_f,...s})=>s),()=>{NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime);if(Date.now()>deadline)throw new NativeOptionReadError('QUERY_UNEVALUABLE');},h=>this.#identities.identify(h),value.result.frame,value.result.optionValue);
    if(hash(renewed)!==hash(value.result))return undefined;return structuredClone(value);
  });}catch{return undefined;}}
 async observe(goalId:string){if(!this.#privateAttemptListeners.size)return this.#observe(goalId);
  return probeVerificationObservation(this.#session,'native_owned_option_state',()=>this.#observe(goalId),
   probe=>{for(const listener of this.#privateAttemptListeners)listener(probe);});}
 async #observe(goalId:string){const owner=NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime),goal=NativeOptionVerificationGoalV2Schema.parse(owner.admission.spec.steps.find(s=>s.id===goalId));
  if(this.#records.size>=80)throw new NativeOptionReadError('RESULT_LIMIT');
  return this.#session.withExclusiveGrounding(async()=>{const state=await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime),deadline=Date.now()+15000,bounded=()=>{NativeOptionObservationSessionV2.prototype.owner.call(this,this.#runtime);if(Date.now()>deadline)throw new NativeOptionReadError('QUERY_UNEVALUABLE');};
   const base={observationVersion:'2',observationId:`observation-${randomUUID()}`,testSpecId:owner.admission.spec.testSpecId,explorationAttemptId:owner.attemptId,sessionId:owner.sessionId,pageId:state.pageId,executionProfileRef:owner.admission.spec.executionProfileRef,profileFingerprint:owner.profileFingerprint,stateDigest:state.stateDigest,stateEpoch:state.stateEpoch,mutationEpoch:state.mutationEpoch,observedAt:new Date().toISOString(),goalStepId:goal.id,admissionDigest:semanticAdmissionDigestV2(owner.admission.record),claimDigest:hash(goal.claim)};
   const diagnostic:NativeOptionReadDiagnostic={};this.#diagnostics.set(goal.id,diagnostic);
   let outcome;try{const result=await readNativeOwnedOptionState(state.page,nativeOptionPredicate(goal),goal.claim.optionLabel,()=>ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#runtime).then(({page:_p,frames:_f,...s})=>s),bounded,h=>this.#identities.identify(h),undefined,undefined,undefined,diagnostic);outcome={status:'complete',result};}
   catch(e){outcome={status:'error',complete:false,reason:e instanceof NativeOptionReadError?e.reason:'QUERY_UNEVALUABLE'};}
   const data=NativeOptionObservationV2Schema.parse({...base,...outcome,observedAt:new Date().toISOString(),witnessDigest:'0'.repeat(64)}),{witnessDigest:_d,...canonical}=data,record=parseNativeOptionObservationV2({...canonical,witnessDigest:hash(canonical)});
   this.#records.set(record.observationId,record);for(const listener of this.#listeners)listener(structuredClone(record));return structuredClone(record);
  });}
}
