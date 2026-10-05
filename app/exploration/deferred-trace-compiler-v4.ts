import { randomUUID } from 'node:crypto';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { CompilerAttemptV4Schema, ResolvedTestSpecV9Schema, parseCompilerAttemptV4, parseResolvedTestSpecV9,
  durableDeferredFrame, type CompilerAttemptV4, type ResolvedTestSpecV9, type DeferredCompilerReasonV4 } from '../domain/deferred-action-compiler.js';
import { assertionFromStrategyV1, type DeterministicVerificationAssertionV1 } from '../domain/goal-directed-compiler.js';
import type { TrustedObservationResultV1 } from '../domain/observation-contracts.js';
import { requireTrustedSuccessfulTraceReadbackV5, type TrustedSuccessfulTraceReadbackV5 } from '../evidence/trace-store-v5.js';
import { ProtectedContextFactory, assertEquivalentEffectiveProfile } from '../profile/index.js';
import { McpExplorationSession, MCP_VERSION } from './mcp.js';
import { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } from './action-candidate-grounding.js';
import { TrustedObservationSessionV1 } from './trusted-observation.js';
import { evaluateDeferredAssertionV1 as evaluation } from '../domain/deferred-action-compiler.js';
import type { TraceStateV5 } from '../domain/agentic-trace-v5.js';

import {NativeOptionObservationSessionV2} from './native-option-observation.js';
import {nativeOptionAssertion} from '../domain/native-option-verification.js';
const issued=new WeakSet<object>(),token=Symbol('deferred-compiler-v4');
const id=(prefix:string)=>`${prefix}-${randomUUID()}`;
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
export class TrustedDeferredCompilationV4 {
  readonly #artifact: {compiler:CompilerAttemptV4;resolved?:ResolvedTestSpecV9};
  constructor(authority:symbol,artifact:{compiler:CompilerAttemptV4;resolved?:ResolvedTestSpecV9}) {
    if(authority!==token)throw new Error('Protected fresh compiler origin required');
    this.#artifact=structuredClone(artifact);issued.add(this);
  }
  protectedArtifact(){return structuredClone(this.#artifact);}
}
export function requireTrustedDeferredCompilationV4(value:TrustedDeferredCompilationV4){
  if(!issued.has(value))throw new Error('Untrusted compiler v4 origin');
  return TrustedDeferredCompilationV4.prototype.protectedArtifact.call(value);
}
class Stop extends Error {constructor(readonly reason:DeferredCompilerReasonV4){super(reason);}}
function reasonFor(error:ActionCandidateGroundingError):DeferredCompilerReasonV4 {
  if(error.reason==='NON_UNIQUE')return 'NON_UNIQUE_MATCH';
  if(['OPTION_ABSENT','OPTION_NON_UNIQUE','VALUE_NON_UNIQUE','OPTION_DISABLED'].includes(error.reason))return 'OPTION_MAPPING_MISMATCH';
  if(['RESULT_LIMIT','QUERY_UNEVALUABLE'].includes(error.reason))return 'INCOMPLETE_EVIDENCE';
  if(error.reason==='UNPROVEN_FRAME')return 'FRAME_MISMATCH';
  if(error.reason==='STALE_STATE')return 'STALE_EVIDENCE';
  if(['PENDING_OBLIGATIONS','UNSUPPORTED_MAPPING','UNSUPPORTED_OPERATION','UNSUPPORTED_CONTROL'].includes(error.reason))return 'UNSUPPORTED_REPRESENTATION';
  if(error.reason==='NO_CANDIDATES')return 'TARGET_MISMATCH';
  if(['OBLIGATION_MAPPING_MISMATCH','INVALID_REQUEST'].includes(error.reason))return 'SOURCE_CORRESPONDENCE';
  if(['UNTRUSTED_EVIDENCE','SELECTED_REF_NOT_MEMBER'].includes(error.reason))return 'STALE_EVIDENCE';
  return 'ENVIRONMENT_FAILURE';
}
function requestFor(a:DeterministicVerificationAssertionV1){return a.kind==='url'?{kind:'current_url' as const}:a.kind==='semantic_count'?{kind:'semantic_query' as const,query:a.query}:{kind:'target_property' as const,query:a.query,property:a.property};}
type ObservationDiagnostic = NonNullable<CompilerAttemptV4['verificationObservationDiagnostics']>[number];
type BrowserSnapshot = Pick<ObservationDiagnostic,'selectedPageBefore'|'pageCountBefore'|'currentUrlBefore'>;
function safeDiagnosticUrl(value:string):string|undefined {
  try { const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return undefined;
    return `${url.origin}${url.pathname}`.slice(0,512);
  }catch{return undefined;}
}
function browserSnapshot(session:McpExplorationSession):BrowserSnapshot {
  try {const pages=session.browserSession.context.pages(),page=pages[0];
    return{pageCountBefore:Math.min(pages.length,1000),selectedPageBefore:!page?'absent':page.isClosed()?'closed':'open',
      ...(!page||page.isClosed()?{}:{currentUrlBefore:safeDiagnosticUrl(page.url())})};
  }catch{return{selectedPageBefore:'unknown'};}
}
function diagnosticExceptionName(error:unknown):ObservationDiagnostic['exceptionName'] {
  if(error instanceof Error&&error.constructor.name==='ObservationFailure')return 'ObservationFailure';
  const name=error instanceof Error?error.name:'Unknown';
  return ['Error','TimeoutError','ActionCandidateGroundingError','ObservationFailure','TargetClosedError'].includes(name)
    ?name as ObservationDiagnostic['exceptionName']:'Unknown';
}
function diagnosticReason(error:unknown,snapshot:BrowserSnapshot,session:McpExplorationSession):ObservationDiagnostic['internalReason'] {
  if(session.browserSession.isClosed)return 'CONTEXT_CLOSED';
  if(error instanceof Error&&/context.*closed/i.test(error.message))return 'CONTEXT_CLOSED';
  if(snapshot.selectedPageBefore==='closed'||snapshot.selectedPageBefore==='absent')return 'PAGE_CLOSED';
  if(error instanceof Error&&error.constructor.name==='ObservationFailure'){
    const candidate=(error as Error&{reason?:unknown}).reason;
    if(typeof candidate==='string'&&['INVALID_SCOPE','STALE_STATE','BROWSER_FAILURE','QUERY_UNEVALUABLE',
      'RESULT_LIMIT','NO_MATCH','NON_UNIQUE','UNSUPPORTED_PROPERTY'].includes(candidate))
      return candidate as ObservationDiagnostic['internalReason'];
  }
  if(error instanceof ActionCandidateGroundingError){
    if(error.browserFailureCause)return error.browserFailureCause;
    if(['STALE_STATE','RESULT_LIMIT','QUERY_UNEVALUABLE'].includes(error.reason))return error.reason as ObservationDiagnostic['internalReason'];
    return 'BROWSER_FAILURE';
  }
  if(error instanceof Error){
    if(error.name==='TimeoutError')return 'OBSERVATION_TIMEOUT';
    // Playwright messages are inspected only in memory; unrestricted messages are never persisted.
    if(/frame was detached|detached frame/i.test(error.message))return 'FRAME_DETACHED';
    if(/navigation.*(in progress|interrupted)|navigating/i.test(error.message))return 'NAVIGATION_IN_PROGRESS';
    if(/context.*closed/i.test(error.message))return 'CONTEXT_CLOSED';
    if(/page.*closed/i.test(error.message))return 'PAGE_CLOSED';
  }
  return 'OBSERVATION_UNAVAILABLE';
}
/** No model calls, legacy compilers, locator copying, or authored-language interpretation. */
export async function compileDeferredSuccessfulTraceV5(factory:ProtectedContextFactory,readback:TrustedSuccessfulTraceReadbackV5):Promise<{
  kind:'compiled'|'compilation_stop'|'compilation_unsupported';compiler:CompilerAttemptV4;resolved?:ResolvedTestSpecV9;artifact:TrustedDeferredCompilationV4}> {
  const {trace}=requireTrustedSuccessfulTraceReadbackV5(readback),source=trace.source;
  const compilerAttemptId=id('compiler'),resolvedSpecId=id('resolved'),startedAt=new Date(Math.max(Date.now(),Date.parse(trace.finishedAt))).toISOString(),deadline=Date.now()+120_000;
  const checks:CompilerAttemptV4['checks']=[],freshActions:CompilerAttemptV4['freshActions']=[],freshVerifications:CompilerAttemptV4['freshVerifications']=[],freshNavigations:CompilerAttemptV4['freshNavigations']=[],steps:ResolvedTestSpecV9['executionSteps']=[];
  const executionStops:CompilerAttemptV4['executionStops']=[],verificationObservationDiagnostics:NonNullable<CompilerAttemptV4['verificationObservationDiagnostics']>=[];
  let freshStartState:TraceStateV5|undefined,freshFinalState:TraceStateV5|undefined;
  let session:McpExplorationSession|undefined,runtime:ActionCandidateGroundingSessionV1|undefined,reason:DeferredCompilerReasonV4|undefined,active=trace.successfulPath[0]!.recordId,cleanup:'verified'|'unverified'='verified',observationThrew=false;
  const mark=(kind:CompilerAttemptV4['checks'][number]['kind'],passed:boolean,why:DeferredCompilerReasonV4,evidence?:unknown)=>{
    checks.push({traceRecordId:active,kind,passed,...(evidence?{evidenceDigest:hash(evidence)}:{})});if(!passed)throw new Stop(why);
  };
  const currentDeadline=()=>{if(Date.now()>deadline)throw new Stop('INCOMPLETE_EVIDENCE');};
  try {
    const profile=factory.catalog.resolve(source.executionProfileRef);
    mark('profile',profile.fingerprint===trace.profileFingerprint,'PROFILE_MISMATCH');
    session=await McpExplorationSession.open(factory,source.executionProfileRef,profile,compilerAttemptId);
    assertEquivalentEffectiveProfile(profile,session.browserSession.effectiveProfile);
    mark('profile',session.browserSession.effectiveProfile.fingerprint===trace.profileFingerprint,'PROFILE_MISMATCH');
    if(source.startState.url!=='about:blank')await session.navigate(source.startState.url);else await session.snapshot();
    const fresh=ActionCandidateGroundingSessionV1.forFreshCompiler(session,readback,compilerAttemptId);runtime=fresh.runtime;
    const observer=new TrustedObservationSessionV1(session,runtime);
    const nativeObserver=new NativeOptionObservationSessionV2(session,runtime);
    const point=async():Promise<TraceStateV5>=>{const state=await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(runtime!);return{sessionId:runtime!.sessionId,pageId:state.pageId,stateDigest:state.stateDigest,stateEpoch:state.stateEpoch,mutationEpoch:state.mutationEpoch};};
    freshStartState=await point();
    for(const record of trace.successfulPath){
      active=record.recordId;currentDeadline();
      const sourceStep=source.steps.find(s=>s.id===record.originStepId);
      mark('source',!!sourceStep&&sourceStep.type===record.type,'SOURCE_CORRESPONDENCE',sourceStep);
      const base={id:id('step'),traceRecordId:record.recordId,originStepId:record.originStepId,source:'authored' as const};
      if(record.type==='navigate'){
        const before=await point();
        await session.navigate(record.url);runtime.invalidate();
        mark('order',session.browserSession.context.pages().length===1&&session.browserSession.context.pages()[0]!.url()===new URL(record.url).href,'TARGET_MISMATCH');
        freshNavigations.push({traceRecordId:record.recordId,url:record.url,before,after:await point(),observedAt:new Date().toISOString()});
        steps.push({...base,type:'navigate',url:record.url});continue;
      }
      if(record.type==='verification_goal'){
        if('verificationVersion'in record){
          const start=new Date(),tick=performance.now(),before=browserSnapshot(session),diagnosticBase={diagnosticVersion:'1' as const,
            traceRecordId:record.recordId,compilerStepId:base.id,originStepId:record.originStepId,stage:'verification_observation' as const,
            assertionKind:'native_owned_option_selected' as const,observationKind:'native_owned_option_state' as const};
          let observed:Awaited<ReturnType<typeof nativeObserver.observe>>;
          try{observed=await nativeObserver.observe(record.goalStepId);}
          catch(error){observationThrew=true;const after=browserSnapshot(session);verificationObservationDiagnostics.push({...diagnosticBase,startedAt:start.toISOString(),finishedAt:new Date().toISOString(),
            elapsedMs:Math.min(86_400_000,Math.max(0,Math.round(performance.now()-tick))),pageCountBefore:before.pageCountBefore,pageCountAfter:after.pageCountBefore,
            selectedPageBefore:before.selectedPageBefore,selectedPageAfter:after.selectedPageBefore,currentUrlBefore:before.currentUrlBefore,currentUrlAfter:after.currentUrlBefore,
            outcome:'threw',exceptionName:diagnosticExceptionName(error),internalReason:diagnosticReason(error,after,session)});throw error;}
          const after=browserSnapshot(session);verificationObservationDiagnostics.push({...diagnosticBase,startedAt:start.toISOString(),finishedAt:new Date().toISOString(),
            elapsedMs:Math.min(86_400_000,Math.max(0,Math.round(performance.now()-tick))),pageCountBefore:before.pageCountBefore,pageCountAfter:after.pageCountBefore,
            selectedPageBefore:before.selectedPageBefore,selectedPageAfter:after.selectedPageBefore,currentUrlBefore:before.currentUrlBefore,currentUrlAfter:after.currentUrlBefore,
            outcome:observed.status==='complete'?'complete':'observation_error',...(observed.status==='error'?{internalReason:observed.reason}:{})});
          mark('verification',observed.status==='complete'&&!!await nativeObserver.currentEvidence(observed),'INCOMPLETE_EVIDENCE');
          if(observed.status!=='complete')throw new Stop('INCOMPLETE_EVIDENCE');
          const original=record.observations[0];mark('verification',original?.status==='complete'&&same(observed.result.frame,original.result.frame),'FRAME_MISMATCH');
          mark('verification',original?.status==='complete'&&observed.result.labelOwnershipDigest===original.result.labelOwnershipDigest,'LABEL_ASSOCIATION_MISMATCH');
          const assertion=nativeOptionAssertion(record.strategy,observed);
          mark('verification',(observed.result.selected===assertion.expectedSelected)===record.evaluated,'POST_EFFECT_UNPROVEN',observed);
          freshVerifications.push({traceRecordId:record.recordId,observation:observed});
          steps.push({...base,type:'verification_goal',goalStepId:record.goalStepId,assertion});mark('order',true,'SOURCE_CORRESPONDENCE');continue;
        }
        const assertion=assertionFromStrategyV1(record);mark('verification',!!assertion,'UNSUPPORTED_VERIFICATION');
        const request=requestFor(assertion!),start=new Date(),tick=performance.now(),before=browserSnapshot(session),diagnosticBase={diagnosticVersion:'1' as const,
          traceRecordId:record.recordId,compilerStepId:base.id,originStepId:record.originStepId,stage:'verification_observation' as const,
          assertionKind:assertion!.kind,observationKind:request.kind};
        let observed:TrustedObservationResultV1;
        try{observed=await observer.observe(request);}
        catch(error){observationThrew=true;const after=browserSnapshot(session);verificationObservationDiagnostics.push({...diagnosticBase,startedAt:start.toISOString(),finishedAt:new Date().toISOString(),
          elapsedMs:Math.min(86_400_000,Math.max(0,Math.round(performance.now()-tick))),pageCountBefore:before.pageCountBefore,pageCountAfter:after.pageCountBefore,
          selectedPageBefore:before.selectedPageBefore,selectedPageAfter:after.selectedPageBefore,currentUrlBefore:before.currentUrlBefore,currentUrlAfter:after.currentUrlBefore,
          outcome:'threw',exceptionName:diagnosticExceptionName(error),internalReason:diagnosticReason(error,after,session)});throw error;}
        const after=browserSnapshot(session);verificationObservationDiagnostics.push({...diagnosticBase,startedAt:start.toISOString(),finishedAt:new Date().toISOString(),
          elapsedMs:Math.min(86_400_000,Math.max(0,Math.round(performance.now()-tick))),pageCountBefore:before.pageCountBefore,pageCountAfter:after.pageCountBefore,
          selectedPageBefore:before.selectedPageBefore,selectedPageAfter:after.selectedPageBefore,currentUrlBefore:before.currentUrlBefore,currentUrlAfter:after.currentUrlBefore,
          outcome:observed.status==='complete'?'complete':'observation_error',...(observed.status==='error'?{internalReason:observed.reason}:{})});
        mark('verification',observed.status==='complete'&&!!await observer.currentEvidence(observed),'INCOMPLETE_EVIDENCE');
        mark('verification',evaluation(assertion!,observed)===record.evaluated,'POST_EFFECT_UNPROVEN',observed);
        freshVerifications.push({traceRecordId:record.recordId,observation:observed});
        steps.push({...base,type:'verification_goal',goalStepId:record.goalStepId,assertion:assertion!});
        mark('order',true,'SOURCE_CORRESPONDENCE');continue;
      }
      const original=record.witness.finalCheck,mapping=fresh.mappings.get(original.goalId)!;
      mark('source',!!mapping&&same(mapping.correspondence,original.correspondence),'SOURCE_CORRESPONDENCE',mapping.correspondence);
      // Complete broad authored domain first. Options never narrow an ambiguous control set.
      const candidate=await runtime.query(original.candidateObservation.request,deadline);
      mark('predicate',candidate.status==='complete','INCOMPLETE_EVIDENCE',candidate);
      const prepared=await runtime.prepareGrounding(candidate,mapping,original.operation,deadline);
      const selected=prepared.candidateObservation.status==='complete'&&prepared.candidateObservation.candidates.find(c=>c.selectedRef===prepared.selectedRef&&c.frameId===prepared.frameId);
      const prior=original.candidateObservation.status==='complete'&&original.candidateObservation.candidates.find(c=>c.selectedRef===original.selectedRef&&c.frameId===original.frameId);
      mark('frame',!!selected&&!!prior&&same(durableDeferredFrame(selected.frame),durableDeferredFrame(prior.frame)),'FRAME_MISMATCH');
      mark('predicate',prepared.argument?.authoredText===original.argument?.authoredText&&prepared.operation===original.operation,'SOURCE_CORRESPONDENCE');
      const result=await runtime.executePreparedGrounding(prepared,deadline);
      if(result.status!=='succeeded')executionStops.push({traceRecordId:record.recordId,execution:result.execution});
      const executionStop:DeferredCompilerReasonV4=result.status==='succeeded'?'POST_EFFECT_UNPROVEN':result.execution.reason.startsWith('UNSUPPORTED_')?
        (prepared.operation==='click'?'UNSUPPORTED_ACTIVATION':'UNSUPPORTED_REPRESENTATION'):result.execution.reason==='STALE_STATE'?'STALE_EVIDENCE':result.execution.reason==='QUERY_UNEVALUABLE'?'INCOMPLETE_EVIDENCE':result.execution.reason==='BROWSER_FAILURE'?'ENVIRONMENT_FAILURE':'POST_EFFECT_UNPROVEN';
      mark('execution',result.status==='succeeded',executionStop);
      if(result.status!=='succeeded')throw new Stop('POST_EFFECT_UNPROVEN');
      const witness=ActionCandidateGroundingSessionV1.prototype.protectedActionGroundingWitness.call(runtime,result.witness.witnessId);
      mark('execution',!!witness&&same(witness,result.witness),'POST_EFFECT_UNPROVEN',witness);
      const originalEffect=record.witness.postEffect.effect,freshEffect=result.witness.postEffect.effect;
      mark('execution',freshEffect.kind===originalEffect.kind&&
        (freshEffect.kind!=='generic_activation'||originalEffect.kind==='generic_activation'&&freshEffect.role===originalEffect.role),
        'POST_EFFECT_UNPROVEN');
      const retirement=ActionCandidateGroundingSessionV1.prototype.protectedActionGroundingRetirement.call(runtime,result.witness.witnessId);
      const generic = freshEffect.kind === 'generic_activation';
      mark('execution',generic ? !retirement : !!retirement,'POST_EFFECT_UNPROVEN',retirement);
      if(!generic && !retirement)throw new Stop('POST_EFFECT_UNPROVEN');
      freshActions.push({traceRecordId:record.recordId,witness:result.witness,...(retirement ? {retirement} : {})});
      const pre=result.witness.finalCheck,effect=result.witness.postEffect.effect;
      if(!selected)throw new Stop('FRAME_MISMATCH');
      const guard={guardVersion:'1' as const,domain:'all_current_page_frames' as const,candidateLimit:80 as const,frameLimit:8 as const,optionLimit:80 as const,
        sourceGoal:pre.sourceGoal,correspondence:pre.correspondence,request:pre.candidateObservation.request,predicate:pre.candidateObservation.predicate,mappingDigest:pre.mappingDigest,
        frame:durableDeferredFrame(selected!.frame),completeRequired:true as const,eligibleCount:1 as const,nativeEffect:effect.kind,
        nativeControl:effect.kind==='entered_text'?effect.nativeControl:effect.kind==='native_choice'?'select' as const:effect.kind==='native_activation'?effect.nativeInputType:effect.role,
        labelMode:'proven_native_label_or_aria_labelledby' as const,optionMode:'exact_owned_authored_label_unique_value' as const,
        argumentPolicy:'require_fresh_mapping_equal_compiled_argument' as const};
      steps.push({...base,type:'action_goal',operation:pre.operation,guard,...(pre.argument?{authoredArgument:pre.argument.authoredText,executableArgument:pre.argument.executableValue}:{})});
      mark('order',true,'SOURCE_CORRESPONDENCE');
    }
    const finalRecord=trace.successfulPath.at(-1);
    const finalUrl=source.semanticMode==='poc_v1'&&finalRecord?.type==='verification_goal'&&
      !('verificationVersion'in finalRecord)&&finalRecord.observations.at(-1)?.request.kind==='current_url';
    if(finalUrl){
      const state=ActionCandidateGroundingSessionV1.prototype.protectedCurrentUrlState.call(runtime);
      freshFinalState={sessionId:runtime.sessionId,pageId:state.pageId,stateDigest:state.stateDigest,
        stateEpoch:state.stateEpoch,mutationEpoch:state.mutationEpoch};
    }else freshFinalState=await point();
  }catch(error){reason=error instanceof Stop?error.reason:observationThrew?
      error instanceof ActionCandidateGroundingError&&error.reason==='STALE_STATE'?'STALE_EVIDENCE':
      error instanceof ActionCandidateGroundingError&&error.reason==='RESULT_LIMIT'?'INCOMPLETE_EVIDENCE':'ENVIRONMENT_FAILURE':
      error instanceof ActionCandidateGroundingError?reasonFor(error):'ENVIRONMENT_FAILURE';
    checks.push({traceRecordId:active,kind:'predicate',passed:false});
  }finally{if(session)try{await session.close();}catch{cleanup='unverified';reason='CLEANUP_UNVERIFIED';}}
  checks.push({traceRecordId:active,kind:'cleanup',passed:cleanup==='verified'});
  const owner={testSpecId:trace.testSpecId,explorationAttemptId:trace.explorationAttemptId,successfulTraceId:trace.successfulTraceId,traceDigest:trace.traceDigest,
    executionProfileRef:trace.executionProfileRef,profileFingerprint:trace.profileFingerprint,compilerAttemptId};
  const compilerData=CompilerAttemptV4Schema.parse({compilerVersion:'4',...owner,startedAt,finishedAt:new Date(Math.max(Date.now(),Date.parse(startedAt))).toISOString(),
    ...(runtime?{freshSessionId:runtime.sessionId}:{}),...(freshStartState?{freshStartState}:{}),...(freshFinalState?{freshFinalState}:{}),cleanup,checks,freshActions,executionStops,freshVerifications,freshNavigations,verificationObservationDiagnostics,
    result:reason?{status:'rejected',reasonCode:reason,failedTraceRecordId:active}:{status:'accepted',resolvedSpecId},attemptDigest:'0'.repeat(64)});
  const {attemptDigest:_ad,...orderedCompiler}=compilerData;
  const finalIntegrityStop=()=>{
    // Final acceptance and actual invocation accounting are separate. Validate each
    // captured proof independently: a later chain failure cannot erase a valid effect,
    // while invalid evidence must never survive in an authenticated rejected attempt.
    const rejectedData={...orderedCompiler,freshActions:[],freshVerifications:[],freshNavigations:[],executionStops:[],
      checks:[...orderedCompiler.checks,{traceRecordId:active,kind:'source' as const,passed:false}],
      result:{status:'rejected' as const,reasonCode:'SOURCE_CORRESPONDENCE' as const,failedTraceRecordId:active}};
    const valid=<T>(key:'freshActions'|'freshVerifications'|'freshNavigations'|'executionStops',entries:readonly T[]):T[]=>{
      return entries.filter(entry=>{
        try{
          const {attemptDigest:_d,...data}=CompilerAttemptV4Schema.parse({...rejectedData,[key]:[entry],attemptDigest:'0'.repeat(64)});
          parseCompilerAttemptV4({...data,attemptDigest:hash(data)},trace);return true;
        }catch{return false;}
      });
    };
    const {attemptDigest:_d,...canonical}=CompilerAttemptV4Schema.parse({...rejectedData,
      freshActions:valid('freshActions',orderedCompiler.freshActions),freshVerifications:valid('freshVerifications',orderedCompiler.freshVerifications),
      freshNavigations:valid('freshNavigations',orderedCompiler.freshNavigations),executionStops:valid('executionStops',orderedCompiler.executionStops),attemptDigest:'0'.repeat(64)});
    const rejected=parseCompilerAttemptV4({...canonical,attemptDigest:hash(canonical)},trace),artifact=new TrustedDeferredCompilationV4(token,{compiler:rejected});
    return{kind:'compilation_stop' as const,compiler:rejected,artifact};
  };
  let compiler:CompilerAttemptV4;
  try{compiler=parseCompilerAttemptV4({...orderedCompiler,attemptDigest:hash(orderedCompiler)},trace);}catch{return finalIntegrityStop();}
  if(reason){const artifact=new TrustedDeferredCompilationV4(token,{compiler});return{kind:reason.startsWith('UNSUPPORTED_')?'compilation_unsupported':'compilation_stop',compiler,artifact};}
  const resolvedData=ResolvedTestSpecV9Schema.parse({schemaVersion:'9',sourceSchemaVersion:'6',sourceContractVersion:'2',...owner,resolvedSpecId,
    admissionDigest:trace.obligationHandoff.admissionDigest,runtimeVersions:{playwright:session!.browserSession.versions.playwright,mcp:MCP_VERSION,compiler:'4',guard:'1'},executionSteps:steps,resolvedDigest:'0'.repeat(64)});
  const {resolvedDigest:_rd,...orderedResolved}=resolvedData;
  let resolved:ResolvedTestSpecV9;
  try{resolved=parseResolvedTestSpecV9({...orderedResolved,resolvedDigest:hash(orderedResolved)},trace,compiler);}catch{return finalIntegrityStop();}
  const artifact=new TrustedDeferredCompilationV4(token,{compiler,resolved});return{kind:'compiled',compiler,resolved,artifact};
}
