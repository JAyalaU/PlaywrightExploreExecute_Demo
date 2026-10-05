import type { Page } from '@playwright/test';
import type { DeferredVerificationObservationAttemptV1 } from '../domain/deferred-verification-diagnostic.js';
import { diagnosticText } from '../domain/deferred-verification-diagnostic.js';
import type { McpExplorationSession } from './mcp.js';

export type PrivateObservationProbe = Omit<DeferredVerificationObservationAttemptV1,'attemptVersion'|'stepId'|'strategy'>;
type Snapshot = { page?:Page; pageCount?:number; selectedPage:'open'|'closed'|'absent'|'unknown'; currentUrl?:string };
function safeObservedUrl(value:string):string|undefined {
  const bounded=diagnosticText(value);
  if(!bounded)return undefined;
  try { const parsed=new URL(bounded);
    // Page paths can themselves contain bearer-like values. Omit those URLs entirely.
    if(parsed.pathname.split('/').some(segment=>segment.length>64||/[A-Za-z0-9]{24,}/.test(segment)))return undefined;
    return bounded;
  } catch {return undefined;}
}
function snapshot(session:McpExplorationSession):Snapshot {
  try { const pages=session.browserSession.context.pages(),page=pages[0];
    const currentUrl=page&&!page.isClosed()?safeObservedUrl(page.url()):undefined;
    return {...(page?{page}:{}),pageCount:Math.min(1000,pages.length),selectedPage:!page?'absent':page.isClosed()?'closed':'open',
      ...(currentUrl?{currentUrl}:{})};
  } catch {return {selectedPage:'unknown'};}
}
const reasons=new Set<NonNullable<PrivateObservationProbe['internalReason']>>([
  'OBSERVATION_TIMEOUT','PAGE_CLOSED','CONTEXT_CLOSED','FRAME_DETACHED','NAVIGATION_IN_PROGRESS','BROWSER_FAILURE',
  'OBSERVATION_UNAVAILABLE','STALE_STATE','RESULT_LIMIT','QUERY_UNEVALUABLE','INVALID_SCOPE','NO_MATCH','NON_UNIQUE',
  'UNSUPPORTED_PROPERTY','OPTION_ABSENT','OPTION_NON_UNIQUE','VALUE_NON_UNIQUE','UNSUPPORTED_CONTROL','UNPROVEN_FRAME']);
function reason(error:unknown,after:Snapshot,session:McpExplorationSession):PrivateObservationProbe['internalReason'] {
  if(session.browserSession.isClosed)return 'CONTEXT_CLOSED';
  const message=error instanceof Error?error.message:'';
  if(/context.*closed/i.test(message))return 'CONTEXT_CLOSED';
  if(after.selectedPage==='closed'||after.selectedPage==='absent')return 'PAGE_CLOSED';
  const typed=error&&typeof error==='object'&&'browserFailureCause'in error?error.browserFailureCause:
    error&&typeof error==='object'&&'reason'in error?error.reason:undefined;
  if(typeof typed==='string'&&reasons.has(typed as NonNullable<PrivateObservationProbe['internalReason']>))
    return typed as PrivateObservationProbe['internalReason'];
  if(error instanceof Error){
    if(error.name==='TimeoutError')return 'OBSERVATION_TIMEOUT';
    if(/frame was detached|detached frame/i.test(message))return 'FRAME_DETACHED';
    if(/navigation.*(in progress|interrupted)|navigating/i.test(message))return 'NAVIGATION_IN_PROGRESS';
    if(/page.*closed/i.test(message))return 'PAGE_CLOSED';
    return 'BROWSER_FAILURE';
  }
  return 'OBSERVATION_UNAVAILABLE';
}
function exceptionName(error:unknown):PrivateObservationProbe['exceptionName'] {
  const name=error instanceof Error?(error.name==='Error'&&error.constructor.name!=='Error'?error.constructor.name:error.name):'Unknown';
  return ['Error','TimeoutError','ActionCandidateGroundingError','ObservationFailure','NativeOptionReadError','TargetClosedError'].includes(name)
    ?name as PrivateObservationProbe['exceptionName']:'Unknown';
}
/** Synchronous browser facts around the existing observation call; diagnostic callback cannot change its outcome. */
export async function probeVerificationObservation<T extends {status:'complete'|'error';reason?:string}>(
  session:McpExplorationSession,observationKind:PrivateObservationProbe['observationKind'],
  perform:()=>Promise<T>,emit:(probe:PrivateObservationProbe)=>void,navigationRevision?:()=>number):Promise<T> {
  const startedAt=new Date().toISOString(),tick=performance.now(),before=snapshot(session),revision=navigationRevision?.();
  let outcome:PrivateObservationProbe['outcome']='threw',failure:unknown,returnedReason:string|undefined;
  try {const result=await perform();outcome=result.status==='complete'?'complete':'observation_error';
    if(result.status==='error')returnedReason=result.reason;return result;
  } catch(error) {failure=error;throw error;}
  finally {const after=snapshot(session),typedReason=outcome==='threw'?reason(failure,after,session):
    returnedReason&&reasons.has(returnedReason as NonNullable<PrivateObservationProbe['internalReason']>)
      ?returnedReason as PrivateObservationProbe['internalReason']:outcome==='observation_error'?'OBSERVATION_UNAVAILABLE':undefined;
    const probe:PrivateObservationProbe={observationKind,startedAt,finishedAt:new Date().toISOString(),
      elapsedMs:Math.max(0,Math.min(86_400_000,Math.round(performance.now()-tick))),
      selectedPageBefore:before.selectedPage,selectedPageAfter:after.selectedPage,
      ...(before.pageCount!==undefined?{pageCountBefore:before.pageCount}:{}),
      ...(after.pageCount!==undefined?{pageCountAfter:after.pageCount}:{}),
      ...(before.currentUrl?{currentUrlBefore:before.currentUrl}:{}),...(after.currentUrl?{currentUrlAfter:after.currentUrl}:{}),
      ...(before.page&&before.page!==after.page?{pageReplaced:true}:{}),
      ...(revision!==undefined?{navigationObserved:navigationRevision?.()!==revision}:{}),outcome,
      ...(outcome==='threw'?{exceptionName:exceptionName(failure)}:{}),...(typedReason?{internalReason:typedReason}:{})};
    try {emit(probe);} catch { /* Diagnostics have no execution authority. */ }
  }
}
