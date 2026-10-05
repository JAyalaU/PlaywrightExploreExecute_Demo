import { expect,test } from '@playwright/test';
import type { McpExplorationSession } from '../app/exploration/mcp.js';
import { probeVerificationObservation,type PrivateObservationProbe } from '../app/exploration/verification-observation-diagnostics.js';

function fixture(){
  let closed=false,contextClosed=false,url='https://example.test/dropdown?credential=private#fragment';
  let page={isClosed:()=>closed,url:()=>url};
  const pages=()=>contextClosed?[]:[page];
  const session={browserSession:{context:{pages},get isClosed(){return contextClosed;}}} as unknown as McpExplorationSession;
  return {session,closePage:()=>{closed=true;},closeContext:()=>{contextClosed=true;},
    replacePage:()=>{page={isClosed:()=>false,url:()=>url};},setUrl:(value:string)=>{url=value;}};
}

test('bounded private successful URL observation records browser facts and cannot affect result',async()=>{
  const f=fixture(),records:PrivateObservationProbe[]=[];
  const value=await probeVerificationObservation(f.session,'current_url',async()=>({status:'complete' as const}),
    record=>{records.push(record);throw new Error('Diagnostic callback failure');});
  expect(value.status).toBe('complete');expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({observationKind:'current_url',outcome:'complete',pageCountBefore:1,pageCountAfter:1,
    selectedPageBefore:'open',selectedPageAfter:'open',currentUrlBefore:'https://example.test/dropdown',
    currentUrlAfter:'https://example.test/dropdown',elapsedMs:expect.any(Number)});
  expect(Date.parse(records[0]!.finishedAt)).toBeGreaterThanOrEqual(Date.parse(records[0]!.startedAt));
  expect(JSON.stringify(records)).not.toMatch(/credential|private|fragment|Diagnostic callback failure/);
});

for(const [name,error,mutate,expected] of [
  ['timeout',Object.assign(new Error('raw timeout secret'),{name:'TimeoutError'}),()=>{},'OBSERVATION_TIMEOUT'],
  ['closed page',new Error('Target page has been closed'),(f:ReturnType<typeof fixture>)=>f.closePage(),'PAGE_CLOSED'],
  ['closed context',new Error('Browser context has been closed'),(f:ReturnType<typeof fixture>)=>f.closeContext(),'CONTEXT_CLOSED'],
  ['detached frame',new Error('Frame was detached from page'),()=>{},'FRAME_DETACHED'],
  ['navigation transition',new Error('Navigation in progress'),()=>{},'NAVIGATION_IN_PROGRESS'],
  ['generic browser error',new Error('Unrestricted browser secret'),()=>{},'BROWSER_FAILURE'],
  ['non-error value','untrusted payload',()=>{},'OBSERVATION_UNAVAILABLE'],
] as const)test(`private observation distinguishes ${name} without changing thrown failure`,async()=>{
  const f=fixture(),records:PrivateObservationProbe[]=[];
  await expect(probeVerificationObservation(f.session,'current_url',async()=>{mutate(f);throw error;},
    record=>records.push(record))).rejects.toBe(error);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({observationKind:'current_url',outcome:'threw',internalReason:expected});
  expect(JSON.stringify(records)).not.toMatch(/secret|untrusted payload|credential|private|fragment/);
});

test('page replacement and navigation revision are observed without a second browser read',async()=>{
  const f=fixture(),records:PrivateObservationProbe[]=[];let revision=0;
  await probeVerificationObservation(f.session,'current_url',async()=>{f.replacePage();revision++;return{status:'complete' as const};},
    record=>records.push(record),()=>revision);
  expect(records[0]).toMatchObject({pageReplaced:true,navigationObserved:true,outcome:'complete'});
});

test('typed observation error remains distinct from a thrown browser exception',async()=>{
  const f=fixture(),records:PrivateObservationProbe[]=[];
  await probeVerificationObservation(f.session,'native_owned_option_state',async()=>({status:'error' as const,reason:'OPTION_ABSENT'}),
    record=>records.push(record));
  expect(records[0]).toMatchObject({observationKind:'native_owned_option_state',outcome:'observation_error',internalReason:'OPTION_ABSENT'});
  expect(records[0]?.exceptionName).toBeUndefined();
});

test('bearer-like URL path and embedded URL credentials are omitted',async()=>{
  const f=fixture(),records:PrivateObservationProbe[]=[];
  f.setUrl('https://example.test/token/abcdefghijklmnopqrstuvwxyz0123456789');
  await probeVerificationObservation(f.session,'current_url',async()=>({status:'complete' as const}),record=>records.push(record));
  expect(records[0]?.currentUrlBefore).toBeUndefined();expect(records[0]?.currentUrlAfter).toBeUndefined();
  f.setUrl('https://user:password@example.test/dropdown');
  await probeVerificationObservation(f.session,'current_url',async()=>({status:'complete' as const}),record=>records.push(record));
  expect(records[1]?.currentUrlBefore).toBeUndefined();expect(records[1]?.currentUrlAfter).toBeUndefined();
  expect(JSON.stringify(records)).not.toMatch(/abcdefghijklmnopqrstuvwxyz|password/);
});
