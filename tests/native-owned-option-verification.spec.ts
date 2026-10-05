import { expect, test } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { ProtectedContextFactory } from '../app/profile/index.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { runAgenticSubprocessAdapterV2 } from '../app/subprocess/agentic-entry.js';
import { parseSubprocessResponseV2, serializeSubprocessResponseV2 } from '../app/subprocess/protocol-v2.js';
import { projectStoredWorkflowReportV2 } from '../app/subprocess/workflow-report-projection-v2.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';
import { DeferredWorkflowStopStoreV1 } from '../app/evidence/deferred-workflow-store.js';
import { SuccessfulTraceV5Store } from '../app/evidence/trace-store-v5.js';
import { DeferredCompilerV4Store } from '../app/evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store } from '../app/evidence/deferred-replay-store-v9.js';
import { TrustedDeferredWorkflowStopV1 } from '../app/interpretation/deferred-action-production.js';
import { parseResultRecordV2 } from '../app/domain/agentic-result-v2.js';
import { ACTION_GROUNDING_RESPONSE_FORMAT, ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT } from '../app/interpretation/action-grounding-wire.js';
import { Readable } from 'node:stream';
import { choose } from './helpers/action-v2-fixtures.js';
import { forwardInstructionAccounting, unspannedStep } from './helpers/deferred-v3-wire.js';
import { fill, check, select, correspondence } from './helpers/deferred-v9-fixtures.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';

import {NativeOptionVerificationGoalV2Schema,type NativeOptionVerificationGoalV2} from '../app/domain/native-option-verification-goal.js';
import {executeVerificationAssertionV9} from '../app/runner/verification-v9.js';
import {parseDeferredRunnerRecordV9} from '../app/domain/deferred-action-runner.js';
import {candidateGroundingDigest as hash} from '../app/domain/action-candidate-grounding.js';
import {harness} from './helpers/deferred-v9-fixtures.js';
import {NativeOptionObservationSessionV2} from '../app/exploration/native-option-observation.js';
import {parseNativeOptionObservationV2,validateNativeOptionProof} from '../app/domain/native-option-verification.js';
import {requireTrustedDeferredReplayReadbackV1} from '../app/evidence/deferred-replay-store-v9.js';
import {NativeOptionVerificationControllerV2} from '../app/interpretation/native-option-verification-controller.js';
import {readNativeOwnedOptionState,nativeOptionIdentityJournal} from '../app/browser-action/native-option-state.js';
import {nativeOptionPredicate} from '../app/domain/native-option-verification.js';
import {parseProtectedTraceCaptureBundleV5} from '../app/domain/trace-capture-v5.js';
import {successfulTraceDigestV5} from '../app/domain/agentic-trace-v5.js';
import {semanticAdmissionDigestV2,POC_SEMANTIC_ADMISSION_VERSIONS_V2} from '../app/domain/action-semantic-admission.js';
test.describe.configure({mode:'serial'});
const gate='PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE';
async function fixture(html: string, authored: TestSpecV6V2['steps'] = [choose()],
  fixtureOptions: { preserveNavigation?: boolean; requestTargetUrl?: string; policyHost?: string; policyPort?: number } = {}) {
  let currentHtml = html;
  let fixtureRequests = 0;
  const server = http.createServer((_req, res) => { fixtureRequests++; res.setHeader('content-type', 'text/html'); res.end(currentHtml); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Port missing');
  const url = `http://127.0.0.1:${address.port}/`, root = await mkdtemp(path.join(tmpdir(), 'deferred-production-'));
  let offset = 0;
  if(authored[0]?.type==='navigate'&&!fixtureOptions.preserveNavigation){authored[0].url=url;authored[0].sourceText=`Go to ${url}.`;}
  const steps = structuredClone(authored).map((goal, i) => { if (i) offset++; goal.sourceInstructionSpan = { start: offset, end: offset + goal.sourceText.length }; offset += goal.sourceText.length; return goal; });
  const instructionAccounting = steps.flatMap((goal, i) => [
    ...(i ? [{ classification: 'neutral' as const, sourceSpan: { start: goal.sourceInstructionSpan.start - 1, end: goal.sourceInstructionSpan.start }, authoredText: ' ' }] : []),
    { classification: 'clause' as const, stepId: goal.id, sourceSpan: goal.sourceInstructionSpan, authoredText: goal.sourceText },
  ]);
  const config = { profiles: [{ id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' } }],
    networkPolicies: [{ id: 'local', version: '1', destinations: [{ host: fixtureOptions.policyHost ?? '127.0.0.1', ports: [fixtureOptions.policyPort ?? address.port], addresses: ['127.0.0.1'] }] }],
    evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false }, artifactRoot: root, retentionDays: 7 };
  const request = { taskText: steps.map(g => g.sourceText).join(' '), targetUrl: fixtureOptions.requestTargetUrl ?? url, executionProfileRef: { id: 'desktop', version: '1' } };
  const calls: { format: string; input: unknown }[] = [];
  let nativeProviderFailure=false;
  let overrideExtraction: ((response: unknown) => unknown) | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)), format = body.text.format.name as string;
    if(nativeProviderFailure&&format==='agentic_native_option_verification_decision_v6')return new Response(JSON.stringify({error:{message:'PRIVATE_PROVIDER_FAILURE'}}),{status:500});
    calls.push({ format, input: format.includes('interpretation') || format === 'qa_deferred_action_source_first_v6' ||
      format === 'qa_deferred_semantic_poc_primary_v1' ? body.input : JSON.parse(body.input) });
    let response: unknown;
    if (format === 'qa_deferred_semantic_poc_primary_v1') {
      response = { kind: 'extraction', steps: steps.map((step) => {
        if (step.type === 'navigate') return { id: step.id, type: 'navigate', url: step.url };
        if (step.type === 'action_goal') {
          const effect = step.obligations.find((item) => item.kind === 'effect');
          const operation = step.obligations.find((item) => item.kind === 'operation');
          const argument = step.obligations.find((item) => item.kind === 'argument');
          return { id: step.id, type: 'action_goal',
            effect: effect?.kind === 'effect' ? effect.effect : 'choose',
            explicitOperation: operation?.kind === 'operation' ? operation.operation : null,
            argument: argument?.kind === 'argument' ? { purpose: argument.purpose, value: argument.authoredText } : null,
            targetConstraints: step.obligations.flatMap((item) => item.kind === 'constraint' && item.subject.kind === 'target' ?
              [{ kind: item.constraint, value: item.authoredText, polarity: item.polarity }] : []),
            dependsOnStepId: null };
        }
        return 'verificationVersion' in step ? { id: step.id, type: 'verification_goal', verificationVersion: '2',
          optionLabel: step.claim.optionLabel, expectedSelected: step.claim.expectedSelected,
          controlConstraints: step.claim.controlConstraints.map(({ kind, text }) => ({ kind, text })),
          dependsOnStepId: step.dependsOnStepId ?? null } :
          { id: step.id, type: 'verification_goal', verificationVersion: null, instruction: step.instruction,
            subject: step.subject ?? null, intent: step.intent ?? null, dependsOnStepId: step.dependsOnStepId ?? null };
      }) };
    } else if (format === 'qa_deferred_semantic_poc_fidelity_v1') {
      response = { verdict: 'faithful', issues: [] };
    } else if (format === 'qa_deferred_action_interpretation_v10' || format === 'qa_deferred_action_source_first_v6') {
      const wire = steps.map(unspannedStep);
      const accounting = forwardInstructionAccounting(instructionAccounting);
      response = format === 'qa_deferred_action_interpretation_v10' ? { kind: 'extraction', steps: wire, instructionAccounting: accounting } :
        { kind: 'source_extraction', clauses: wire, instructionAccounting: accounting };
      if (overrideExtraction) response = overrideExtraction(response);
    } else if (format === 'qa_action_grounding_v5' || format === 'qa_action_grounding_source_first_v1') {
      const context = JSON.parse(body.input), goal = context.goal as ActionGoalV2;
      if (format === 'qa_action_grounding_source_first_v1') { expect(context).not.toHaveProperty('priorCandidate'); expect(context).not.toHaveProperty('lastReason'); expect(context).not.toHaveProperty('decision'); }
      const effect = goal.obligations.find(o => o.kind === 'effect');
      response = format === 'qa_action_grounding_v5' ? { decisionVersion: '5', kind: 'ground', goalId: goal.id,
        operation: effect?.kind === 'effect' && effect.effect === 'choose' ? 'select_option' : effect?.kind === 'effect' && effect.effect === 'enter_text' ? 'fill' : 'click', correspondence: correspondence(goal) } :
        { mappingExtractionVersion: '1', goalId: goal.id, correspondence: correspondence(goal) };
    } else if(format==='agentic_native_option_verification_decision_v6'){
      const context=JSON.parse(body.input),o=context.observations[0];
      response=o?o.status!=='complete'?{decisionVersion:'6',kind:'conclude',conclusion:'unresolved',comparison:null}:{decisionVersion:'6',kind:'conclude',conclusion:o.result.selected===context.goal.claim.expectedSelected?'satisfied':'unsatisfied',comparison:{comparisonVersion:'2',kind:'native_owned_option_selected',observationId:o.observationId,expectedSelected:context.goal.claim.expectedSelected}}:{decisionVersion:'6',kind:'observe',request:{kind:'native_owned_option_state',goalStepId:context.goal.id,admissionDigest:context.admissionDigest,claimDigest:context.claimDigest}};
    } else if (format === 'agentic_verification_decision_v4') {
      const context = JSON.parse(body.input), observation = context.observations.find((o: { request: { kind: string } }) => o.request.kind === 'semantic_query');
      response = observation ? { decisionVersion: '4', kind: 'conclude', conclusion: observation.result.count === 1 ? 'satisfied' : 'unsatisfied',
        comparison: { kind: 'count', operator: 'equal', observationId: observation.observationId, expected: 1 } } :
        { decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query', query: { role: 'dialog', name: 'Notice', within: null, frame: { kind: 'main' } } } };
    } else throw new Error('Unexpected legacy provider format');
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ response }) }] }] }), { status: 200 });
  };
  const oldGate = process.env[gate]; process.env[gate] = 'offline-review';
  return { root, url, config, request, calls, fixtureRequests: () => fixtureRequests, setHtml(value: string) { currentHtml = value; }, nativeFailure(){nativeProviderFailure=true;}, extractionOverride(value: (response: unknown) => unknown) { overrideExtraction = value; },
    run: (signal?: AbortSignal) => runAgenticSubprocessAdapterV2(Readable.from([JSON.stringify({ protocolVersion: '2', request })]),
      async () => config, { provider: { apiKey: () => 'MOCK_ONLY', fetchImpl } }, { workflowVersion: 'deferred-action-v1', ...(signal ? { signal } : {}) }),
    close: async () => { if (oldGate === undefined) delete process.env[gate]; else process.env[gate] = oldGate;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function selected(label='Option 1',expectedSelected=true,controlConstraints:NativeOptionVerificationGoalV2['claim']['controlConstraints']=[]):NativeOptionVerificationGoalV2{
 const text=`Verify that ${label} is ${expectedSelected?'':'not '}selected.`;
 return NativeOptionVerificationGoalV2Schema.parse({id:'verify',type:'verification_goal',verificationVersion:'2',instruction:text,sourceText:text,sourceInstructionSpan:{start:0,end:text.length},claim:{kind:'native_owned_option_selected',optionLabel:label,optionSourceSpan:{start:12,end:12+label.length},expectedSelected,controlConstraints}});
}
const options='<select><option value="placeholder">Pick</option><option value="runtime-one">Option 1</option><option value="runtime-two">Option 2</option></select>';
test('exact authored public live-gate source completes through a protected loopback-only fixture alias',async()=>{
 const publicUrl='https://the-internet.herokuapp.com/dropdown',task=`Go to ${publicUrl}. Select Option 1. Verify that Option 1 is selected.`,
  authored=[{id:'navigation',type:'navigate' as const,sourceText:`Go to ${publicUrl}.`,url:publicUrl,sourceInstructionSpan:{start:0,end:`Go to ${publicUrl}.`.length}},choose(),selected()],
  f=await fixture(options,authored,{preserveNavigation:true,requestTargetUrl:publicUrl,policyHost:'the-internet.herokuapp.com',policyPort:443});
 const originalOpen=ProtectedContextFactory.prototype.open,routed:string[]=[],denied:string[]=[],openedContexts:object[]=[],routedContexts:object[]=[];
 ProtectedContextFactory.prototype.open=async function(...args){
  const session=await originalOpen.apply(this,args);
  openedContexts.push(session.context);
  await session.context.route('**/*',async route=>{
   const request=route.request(),url=request.url();routed.push(url);routedContexts.push(session.context);
   if(url===publicUrl&&request.method()==='GET'){
    const response=await fetch(f.url);
    await route.fulfill({status:response.status,body:await response.text(),headers:{'content-type':'text/html'}});
   }else{denied.push(url);await route.abort('blockedbyclient');}
  });
  return session;
 };
 try{
  expect(f.request.taskText).toBe(task);
  expect(f.config.networkPolicies).toEqual([{id:'local',version:'1',destinations:[{host:'the-internet.herokuapp.com',ports:[443],addresses:['127.0.0.1']}]}]);
  expect(f.config).not.toHaveProperty('publicTargetApproval');
  const result=await f.run();expect(result.kind,JSON.stringify(result)).toBe('success');if(result.kind==='bridge_error')throw Error('bridge');
  expect(result.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');
  expect(result.context.result.executionRunIds).toHaveLength(2);
  expect(f.calls.slice(0,2).map(call=>call.format)).toEqual(['qa_deferred_semantic_poc_primary_v1','qa_deferred_semantic_poc_fidelity_v1']);
  expect(f.calls[0]!.input).toBe(task);
  expect(f.calls[1]!.input).toMatchObject({originalInstruction:task});
  const trace=await new SuccessfulTraceV5Store(f.root).readSuccessfulExplorationV5(result.context.result.testSpecId,result.context.result.explorationAttemptId!),data=trace.protectedArtifact().trace;
  expect(data.source.sourceInstruction).toBe(task);
  expect(data.semanticAdmission.sourceDigest).toBe(semanticAdmissionDigestV2(task));
  expect(data.semanticAdmission.versions).toMatchObject(POC_SEMANTIC_ADMISSION_VERSIONS_V2);
  expect(data.source.startState.url).toBe(publicUrl);
  const navigation=data.source.steps.find(step=>step.type==='navigate');
  expect(navigation).toMatchObject({type:'navigate',url:publicUrl,sourceText:`Go to ${publicUrl}`});
  expect(navigation?.sourceInstructionSpan).toEqual({start:0,end:task.length});
  expect(data.successfulPath.find(step=>step.type==='navigate')).toMatchObject({url:publicUrl});
  expect(openedContexts.length).toBeGreaterThanOrEqual(4);expect(new Set(openedContexts).size).toBe(openedContexts.length);
  expect(new Set(routedContexts).size).toBeGreaterThanOrEqual(4);
  expect(routed.length).toBeGreaterThan(0);expect(new Set(routed)).toEqual(new Set([publicUrl]));expect(denied).toEqual([]);
  expect(f.fixtureRequests()).toBeGreaterThan(0);
  const compiler=await new DeferredCompilerV4Store(f.root).readResolvedV9(result.context.result.testSpecId,result.context.result.compilerAttemptId!,trace),
   pair=await new DeferredReplayV9Store(f.root).readReplayV1(result.context.result.testSpecId,result.context.result.deferredReplay!.orchestrationId,compiler),
   replay=requireTrustedDeferredReplayReadbackV1(pair).record;
  expect(replay.agreement).toBe('agreed');expect(replay.runs).toHaveLength(2);expect(new Set(replay.runs.map(run=>run.executionRunId)).size).toBe(2);
  expect(new Set(replay.runs.map(run=>run.provenance?.sessionId)).size).toBe(2);
  for(const run of replay.runs){const assertion=run.steps.find(step=>step.type==='verification_goal')?.verification;expect(run.result.kind).toBe('completed');expect(run.cleanup).toBe('verified');expect(assertion).toMatchObject({actual:true,evaluated:true});}
 }finally{
  ProtectedContextFactory.prototype.open=originalOpen;await f.close();
 }
});
test('primary complete three-step path admits unnamed select and deterministic selected-state verification',async()=>{
 const f=await fixture(options,[{id:'navigation',type:'navigate',sourceText:'Go to http://127.0.0.1/.',url:'http://127.0.0.1/',sourceInstructionSpan:{start:0,end:25}},choose(),selected()]);try{
  const r=await f.run();expect(r.kind,JSON.stringify(r)).toBe('success');if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');expect(r.context.result.executionRunIds).toHaveLength(2);
  expect(f.calls.slice(0,2).map(c=>c.format)).toEqual(['qa_deferred_semantic_poc_primary_v1','qa_deferred_semantic_poc_fidelity_v1']);
  expect(f.calls[0]!.input).toBe(f.request.taskText);
  expect(f.calls[1]!.input).toMatchObject({originalInstruction:f.request.taskText});
  expect(f.calls.map(c=>c.format)).not.toContain('agentic_native_option_verification_decision_v6');
  const trace=await new SuccessfulTraceV5Store(f.root).readSuccessfulExplorationV5(r.context.result.testSpecId,r.context.result.explorationAttemptId!);const data=trace.protectedArtifact().trace;
  const goal=data.source.steps.find(g=>g.type==='action_goal');expect(goal?.type==='action_goal'&&goal.obligations.filter(o=>o.kind==='constraint')).toEqual([]);
  const native=data.successfulPath.find(p=>p.type==='verification_goal');expect(native&&'verificationVersion'in native).toBeTruthy();
  if(native?.type==='verification_goal'&&'verificationVersion'in native){expect(native.observations[0]?.status).toBe('complete');const o=native.observations[0]!;if(o.status==='complete'){expect(o.result.optionLabel).toBe('Option 1');expect(o.result.optionValue).toBe('runtime-one');expect(o.result.selected).toBe(true);}}
  const projection=await projectStoredWorkflowReportV2({reportProjectionVersion:'2',result:r},f.config);expect(projection.kind).toBe('available');for(const secret of ['Option 1','runtime-one','controlPredicate','selected','actual','expected','native-node'])expect(JSON.stringify(projection)).not.toContain(secret);await throughPython(f,r,projection);
 }finally{await f.close();}});
for(const [label,expected,actual] of [['Option 2',true,true],['Option 1',false,false],['Option 1',true,false],['Option 1',false,true]] as const)test(`native ${label} expected ${expected} actual ${actual}`,async()=>{
 const selectedValue=(label==='Option 1')===actual?'runtime-one':'runtime-two',html=options.replace(`value="${selectedValue}"`,`value="${selectedValue}" selected`),f=await fixture(html,[selected(label,expected)]);
 try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status).toBe(expected===actual?'QA_ASSERTION_PASSED':'QA_ASSERTION_FAILED');}finally{await f.close();}});
for(const [name,html]of [['absent control','<p>Option 1</p>'],['absent option','<select><option>Other</option></select>'],['two controls',options+options],['only one owns label',options+'<select><option>Other</option></select>'],['hidden extra',options+options.replace('<select>','<select hidden>')],['custom extra',options+'<div role="combobox">Other</div>'],['duplicate label',options.replace('</select>','<option value="another">Option 1</option></select>')],['duplicate value',options.replace('value="runtime-two"','value="runtime-one"')],['multiple select',options.replace('<select>','<select multiple>')],['truncated options',`<select>${Array.from({length:81},(_,i)=>`<option>${i?'Other'+i:'Option 1'}</option>`).join('')}</select>`],['cross-frame',options+'<iframe title="Other" srcdoc="<select><option>Other</option></select>"></iframe>']]as const)test(`negative assertion rejects ${name}`,async()=>{
 const f=await fixture(html,[selected('Option 1',false)]);try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.kind).toBe('typed_stop');expect(r.context.result.executionRunIds).toEqual([]);expect(r.context.result.terminal.stage).toBe('exploration');}finally{await f.close();}});
test('disabled native option is readable and native selected wins over contradictory ARIA',async()=>{
 const html=options.replace('<select>','<select disabled>').replace('value="runtime-one"','value="runtime-one" selected disabled aria-selected="false"');const f=await fixture(html,[selected()]);try{const r=await f.run();expect(r.kind,JSON.stringify(r)).toBe('success');}finally{await f.close();}});
function country(){const g=selected(),text='Verify that Option 1 is selected in Country.';return NativeOptionVerificationGoalV2Schema.parse({...g,instruction:text,sourceText:text,sourceInstructionSpan:{start:0,end:text.length},claim:{...g.claim,controlConstraints:[{kind:'label',text:'Country',sourceSpan:{start:text.indexOf('Country'),end:text.indexOf('Country')+7}}]}});}
for(const [name,html,goal,decision,reason,owners,optionsCount] of [
 ['selected',options.replace('value="runtime-one"','value="runtime-one" selected'),selected(),'true',undefined,1,1],
 ['unselected',options,selected(),'false',undefined,1,1],
 ['ambiguous owner',options+options,selected(),'unresolved','NON_UNIQUE',2,undefined],
 ['missing option','<select><option>Other</option></select>',selected(),'unresolved','OPTION_ABSENT',1,0],
 ['constraint mismatch',options,country(),'unresolved','NO_MATCH',0,undefined],
 ['unsupported control',options.replace('<select>','<select multiple>'),selected(),'unsupported','UNSUPPORTED_CONTROL',1,undefined],
] as const)test(`private native verification diagnostic: ${name}`,async()=>{
 const f=await fixture(html,[goal]);try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');const result=r.context.result;
  const store=new DeferredWorkflowStopStoreV1(f.root);
  const diagnostics=result.deferredStage?
   (await store.readPrivateAccounting(result.testSpecId)).verificationDiagnostics:
   await store.readVerificationDiagnostics(result.testSpecId,result.explorationAttemptId!,result.profileFingerprint);
  expect(diagnostics).toHaveLength(1);expect(diagnostics?.[0]).toMatchObject({stepId:'verify',verificationVersion:'2',
   claimKind:'native_owned_option_selected',expected:true,optionLabel:'Option 1',strategy:'native_owned_option',
   decision,ownerCandidateCount:owners,comparisonAttempted:decision==='true'||decision==='false',
   decisionKind:decision==='true'||decision==='false'?'conclude':'observe',
   decisionTurn:1,
   ...(decision==='true'||decision==='false'?{comparisonKind:'native_owned_option_selected',comparisonExpected:true}:{}),
   ...(reason?{reason}:{}),...(optionsCount===undefined?{}:{optionCandidateCount:optionsCount})});
  expect(diagnostics?.[0]?.observationAttempts).toEqual([expect.objectContaining({stepId:'verify',strategy:'native_owned_option',
   observationKind:'native_owned_option_state',outcome:decision==='true'||decision==='false'?'complete':'observation_error'})]);
  if(name==='constraint mismatch')expect(diagnostics?.[0]?.unresolvedConstraint).toBe('label:Country');
  if(decision==='true'||decision==='false')expect(diagnostics?.[0]).toMatchObject({observationKind:'native_owned_option_state',
   observed:decision==='true',optionSelected:decision==='true',optionValue:'runtime-one'});
  expect(result.cleanup).toBe('verified');
 }finally{await f.close();}
});
test('private ordinary VerificationGoal diagnostic records bounded observation and comparison',async()=>{
 const text='Verify that exactly one Notice dialog exists.';
 const goal:TestSpecV6V2['steps'][number]={id:'verify',type:'verification_goal',sourceText:text,instruction:text,
  sourceInstructionSpan:{start:0,end:text.length},subject:{role:'dialog',accessibleName:'Notice'},
  intent:{kind:'cardinality',comparison:'equal',count:1}};
 const f=await fixture('<div role="dialog" aria-label="Notice">Ready</div>',[goal]);
 try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');
  const result=r.context.result,diagnostics=await new DeferredWorkflowStopStoreV1(f.root)
   .readVerificationDiagnostics(result.testSpecId,result.explorationAttemptId!,result.profileFingerprint);
  expect(diagnostics).toEqual([expect.objectContaining({stepId:'verify',verificationVersion:'1',claimKind:'cardinality',
   subject:{role:'dialog',name:'Notice'},intentKind:'cardinality',strategy:'ordinary_model',
   observationKind:'matches',observed:1,comparisonKind:'count',comparisonExpected:1,decision:'true'})]);
 }finally{await f.close();}
});
test('admitted Country label proves unique owner without turning option into target name',async()=>{const f=await fixture('<label for="country">Country</label>'+options.replace('<select>','<select id="country">').replace('value="runtime-one"','value="runtime-one" selected')+options,[country()]);try{expect((await f.run()).kind).toBe('success');}finally{await f.close();}});
for(const kind of ['remap_compiler','remap_replay','selected_false','disagreement','frame_drift','label_drift']as const)test(`fresh mapping/state ${kind}`,async()=>{
 const html=options.replace('value="runtime-one"','value="runtime-one" selected'),goal=kind==='label_drift'?country():selected(),initial=kind==='label_drift'?'<label for="country">Country</label>'+html.replace('<select>','<select id="country">')+options:html,f=await fixture(initial,[goal]),original=ProtectedContextFactory.prototype.open;let opened=0;
 ProtectedContextFactory.prototype.open=async function(...args){const ordinal=++opened;if(kind==='remap_compiler'&&ordinal===2)f.setHtml(html.replace('runtime-one','fresh-value'));if(kind==='remap_replay'&&ordinal===3)f.setHtml(html.replace('runtime-one','drift-value'));if(kind==='selected_false'&&ordinal===3||kind==='disagreement'&&ordinal===4)f.setHtml(options);if(kind==='frame_drift'&&ordinal===2)f.setHtml(`<iframe title="New" srcdoc='${html}'></iframe>`);if(kind==='label_drift'&&ordinal===3)f.setHtml('<label for="other">Country</label>'+html.replace('<select>','<select id="country">')+options.replace('<select>','<select id="other">'));return original.apply(this,args);};
 try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status,JSON.stringify(r)).toBe(kind==='remap_compiler'?'QA_ASSERTION_PASSED':kind==='selected_false'?'QA_ASSERTION_FAILED':kind==='disagreement'?'REPRODUCIBILITY_FAILED':kind==='frame_drift'?'COMPILATION_FAILED':'REPLAY_EXECUTION_FAILED');}finally{ProtectedContextFactory.prototype.open=original;await f.close();}});
for(const change of ['control','option','selected','mapping']as const)test(`protected observation refuses fresh ${change} substitution`,async()=>{const r=await harness(options,[selected()]);try{const o=new NativeOptionObservationSessionV2(r.session,r.runtime),fact=await o.observe('verify');expect(fact.status).toBe('complete');expect(await o.currentEvidence(fact)).toBeTruthy();
 const forged=structuredClone(fact);if(forged.status!=='complete')throw Error('fact');forged.result.selected=!forged.result.selected;for(const v of forged.result.options)if(v.label==='Option 1')v.selected=forged.result.selected;const{witnessDigest:_d,...data}=forged;forged.witnessDigest=hash(data);expect(()=>parseNativeOptionObservationV2(forged)).not.toThrow();expect(await o.currentEvidence(forged)).toBeUndefined();
 await r.page.locator('select').evaluate((node,kind)=>{const s=node as HTMLSelectElement;if(kind==='control')s.replaceWith(s.cloneNode(true));if(kind==='option'){const o=s.options[1]!;o.replaceWith(o.cloneNode(true));}if(kind==='selected')s.options[1]!.selected=true;if(kind==='mapping')s.options[1]!.value='changed';},change);expect(await o.currentEvidence(fact)).toBeUndefined();
 }finally{await r.close();}});
test('utility-world native getters cannot be overridden by page-world option getters',async()=>{const html=options.replace('value="runtime-one"','value="runtime-one" selected')+`<script>Object.defineProperty(HTMLOptionElement.prototype,'selected',{get(){return false}});Object.defineProperty(HTMLOptionElement.prototype,'value',{get(){return 'forged'}});</script>`,f=await fixture(html,[selected()]);try{expect((await f.run()).kind).toBe('success');}finally{await f.close();}});
for(const kind of ['role','name']as const)test(`exact admitted ${kind} constraint narrows the complete domain`,async()=>{const text=`Verify that Option 1 is selected in ${kind==='role'?'combobox':'Named'}.`,g=selected();g.instruction=g.sourceText=text;g.sourceInstructionSpan={start:0,end:text.length};g.claim.controlConstraints=[{kind,text:kind==='role'?'combobox':'Named',sourceSpan:{start:36,end:text.length-1}}];const html=options.replace('<select>','<select aria-label="Named">').replace('value="runtime-one"','value="runtime-one" selected')+(kind==='role'?'<select multiple><option>Other</option></select>':options),f=await fixture(html,[g]);try{expect((await f.run()).kind).toBe('success');}finally{await f.close();}});
test('native replay proof is separately validated, authenticated and restart readable without MCP',async()=>{const f=await fixture(options,[choose(),selected()]);try{const r=await f.run();expect(r.kind).toBe('success');if(r.kind==='bridge_error')throw Error('bridge');const result=r.context.result,trace=await new SuccessfulTraceV5Store(f.root).readSuccessfulExplorationV5(result.testSpecId,result.explorationAttemptId!),v9=await new DeferredCompilerV4Store(f.root).readResolvedV9(result.testSpecId,result.compilerAttemptId!,trace),pair=await new DeferredReplayV9Store(f.root).readReplayV1(result.testSpecId,result.deferredReplay!.orchestrationId,v9),record=requireTrustedDeferredReplayReadbackV1(pair).record;
 const left=record.runs[0]!.steps.find(s=>s.type==='verification_goal')!,right=record.runs[1]!.steps.find(s=>s.type==='verification_goal')!;expect(left.verification!.actual).toBe(true);expect(left.verification).toEqual(right.verification);expect(left.verificationProof!.proofId).not.toBe(right.verificationProof!.proofId);expect(left.verificationProof!.result.controlId).not.toBe(right.verificationProof!.result.controlId);
 for(const mutation of ['owner','value','selected','stopped']as const){const run=structuredClone(record.runs[0]!),s=run.steps.find(s=>s.type==='verification_goal')!,proof=s.verificationProof!;if(mutation==='owner')proof.sessionId='foreign-session';if(mutation==='value')proof.result.options[1]!.value='substituted';if(mutation==='selected')proof.result.selected=false;if(mutation==='stopped'){s.status='stopped';s.reasonCode='VERIFICATION_UNEVALUABLE';}const{proofDigest:_p,...p}=proof;proof.proofDigest=hash(p);const{recordDigest:_r,...d}=run;run.recordDigest=hash(d);expect(()=>parseDeferredRunnerRecordV9(run)).toThrow();}
 const requestFile=path.join(f.root,'restart-request.json'),configFile=path.join(f.root,'restart-config.json');await writeFile(requestFile,JSON.stringify({reportProjectionVersion:'2',result:r}));await writeFile(configFile,JSON.stringify(f.config));
 const script=`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){if(s.includes('@playwright/mcp')||s.includes('@modelcontextprotocol/'))throw Error('blocked');const r=n(s,c);if(r.url.includes('/exploration/'))throw Error('blocked exploration');return r;}});const {readFile}=await import('node:fs/promises');const {projectStoredWorkflowReportV2}=await import('./dist/subprocess/workflow-report-projection-v2.js');console.log(JSON.stringify(await projectStoredWorkflowReportV2(JSON.parse(await readFile(process.argv[1],'utf8')),JSON.parse(await readFile(process.argv[2],'utf8')))));`;
 const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,requestFile,configFile],{cwd:process.cwd(),encoding:'utf8'});expect(JSON.parse(child.stdout).authoritativeQa).toBe('QA_ASSERTION_PASSED');
 const file=path.join(f.root,'deferred-replay-v9-result-v2',result.testSpecId,`${result.deferredReplay!.orchestrationId}.json`),envelope=JSON.parse(await readFile(file,'utf8'));envelope.record.runs[0].steps.at(-1).verificationProof.result.selected=false;await writeFile(file,JSON.stringify(envelope));await expect(new DeferredReplayV9Store(f.root).readReplayV1(result.testSpecId,result.deferredReplay!.orchestrationId,v9)).rejects.toThrow('authenticated');
 }finally{await f.close();}});
test('native decision cannot add discovered owner constraints or model executable values',async()=>{const r=await harness(options,[selected()]);try{const o=new NativeOptionObservationSessionV2(r.session,r.runtime),controller=new NativeOptionVerificationControllerV2(o,r.runtime,{complete:async({context})=>JSON.stringify({decisionVersion:'6',kind:'observe',request:{kind:'native_owned_option_state',goalStepId:'verify',admissionDigest:context.admissionDigest,claimDigest:context.claimDigest,value:'runtime-one',controlName:'Fabricated'}})});expect((await controller.evaluate(r.admission.spec.steps[0],0)).conclusion).toBe('unresolved');expect(controller.protectedStrategy(r.runtime,'verify')).toBeUndefined();}finally{await r.close();}});
for(const [variant,reason,turn] of [
 ['repeat','REPEAT_OBSERVE_REQUEST',2],['goal','REQUEST_GOAL_MISMATCH',1],
 ['admission','REQUEST_ADMISSION_MISMATCH',1],['claim','REQUEST_CLAIM_MISMATCH',1],
] as const)test(`native diagnostic distinguishes ${variant} observe request`,async()=>{
 const r=await harness(options,[selected()]);try{const observer=new NativeOptionObservationSessionV2(r.session,r.runtime);
  const controller=new NativeOptionVerificationControllerV2(observer,r.runtime,{complete:async({context})=>{
   const request={kind:'native_owned_option_state',goalStepId:context.goal.id,
    admissionDigest:context.admissionDigest,claimDigest:context.claimDigest};
   if(variant==='goal')request.goalStepId='other';
   if(variant==='admission')request.admissionDigest='0'.repeat(64);
   if(variant==='claim')request.claimDigest='0'.repeat(64);
   return JSON.stringify({decisionVersion:'6',kind:'observe',request});
  }});
  expect(await controller.evaluate(r.admission.spec.steps[0],0)).toMatchObject({conclusion:'unresolved',
   reason,decisionKind:'observe',decisionTurn:turn,
   stop:{category:'integrity',code:'VERIFICATION_UNRESOLVED'}});
  expect(controller.protectedStrategy(r.runtime,'verify')).toBeUndefined();
 }finally{await r.close();}
});
for(const [variant,html,optionLabel,expected] of [
 ['admission reference',options.replace('value="runtime-one"','value="runtime-one" selected'),'Option 1','satisfied'],
 ['claim reference',options,'Option 1','unsatisfied'],
 ['goal request and repeat',options.replace('value="runtime-one"','value="runtime-one" selected'),'Option 1','satisfied'],
] as const)test(`PoC native comparison uses admitted goal and fresh observation despite ${variant}`,async()=>{
 const r=await harness(html,[selected(optionLabel)],'poc_v1');try{
  const observer=new NativeOptionObservationSessionV2(r.session,r.runtime);
  let modelCalls=0;
  const controller=new NativeOptionVerificationControllerV2(observer,r.runtime,{complete:async()=>{
   modelCalls++;throw new Error('PoC must not consult duplicated model request references');
  }});
  const outcome=await controller.evaluate(r.admission.spec.steps[0],0);
  expect(outcome.conclusion).toBe(expected);
  expect(outcome.comparisonAttempted).toBe(true);
  expect(outcome.strategy?.comparison.expectedSelected).toBe(true);
  expect(outcome.strategy?.evaluated).toBe(expected==='satisfied');
  expect(modelCalls).toBe(0);
 }finally{await r.close();}
});
test('PoC native comparison refuses a changed step, dependency, or claim',async()=>{
 const r=await harness(options,[selected()],'poc_v1');try{
  const controller=new NativeOptionVerificationControllerV2(new NativeOptionObservationSessionV2(r.session,r.runtime),r.runtime,
   {complete:async()=>{throw new Error('Unexpected model call');}});
  const accepted=r.admission.spec.steps[0]!;
  for(const mutation of [
   {id:'other'},
   {dependsOnStepId:'other'},
   {claim:{...(accepted as NativeOptionVerificationGoalV2).claim,optionLabel:'Option 2'}},
   {claim:{...(accepted as NativeOptionVerificationGoalV2).claim,expectedSelected:false}},
  ])await expect(controller.evaluate({...accepted,...mutation},0)).rejects.toThrow('source/order mismatch');
 }finally{await r.close();}
});
for(const [label,html] of [
 ['missing option',options],
 ['duplicate option value',options.replace('value="runtime-two"','value="runtime-one"')],
] as const)test(`PoC native comparison stops on ${label} without comparing the wrong option`,async()=>{
 const r=await harness(html,[selected(label==='missing option'?'Option 3':'Option 1')],'poc_v1');try{
  const controller=new NativeOptionVerificationControllerV2(new NativeOptionObservationSessionV2(r.session,r.runtime),r.runtime,
   {complete:async()=>{throw new Error('Unexpected model call');}});
  const outcome=await controller.evaluate(r.admission.spec.steps[0],0);
  expect(outcome.conclusion).toBe('unresolved');
  expect(outcome.comparisonAttempted).toBe(false);
  expect(outcome.reason).toBe(label==='missing option'?'OPTION_ABSENT':'VALUE_NON_UNIQUE');
 }finally{await r.close();}
});
test('overridden observer methods cannot confer native strategy authority',async()=>{const r=await harness(options,[selected()]);try{const observer=new NativeOptionObservationSessionV2(r.session,r.runtime),fact=await observer.observe('verify');if(fact.status!=='complete')throw Error('fact');const forged=structuredClone(fact);if(forged.status!=='complete')throw Error('fact');forged.result.selected=true;forged.result.options[1]!.selected=true;const{witnessDigest:_d,...data}=forged;forged.witnessDigest=hash(data);observer.observe=async()=>forged;observer.currentEvidence=async()=>forged;
 const controller=new NativeOptionVerificationControllerV2(observer,r.runtime,{complete:async({context})=>{const o=context.observations[0];if(!o)return JSON.stringify({decisionVersion:'6',kind:'observe',request:{kind:'native_owned_option_state',goalStepId:'verify',admissionDigest:context.admissionDigest,claimDigest:context.claimDigest}});expect(o.status==='complete'&&o.result.selected).toBe(false);return JSON.stringify({decisionVersion:'6',kind:'conclude',conclusion:'unsatisfied',comparison:{comparisonVersion:'2',kind:'native_owned_option_selected',observationId:o.observationId,expectedSelected:true}});}});const result=await controller.evaluate(r.admission.spec.steps[0],0);expect(result.conclusion).toBe('unsatisfied');expect(result.strategy?.evaluated).toBe(false);expect(result.strategy?.observations[0]?.status==='complete'&&result.strategy.observations[0].result.selected).toBe(false);
 }finally{await r.close();}});
test('PoC native verification does not depend on a provider decision',async()=>{const f=await fixture(options.replace('value="runtime-one"','value="runtime-one" selected'),[selected()]);f.nativeFailure();try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status).toBe('QA_ASSERTION_PASSED');expect(f.calls.map(c=>c.format)).not.toContain('agentic_native_option_verification_decision_v6');}finally{await f.close();}});
test('neutral reader complete journal fact',async()=>{const r=await harness(options,[selected()]),ids=nativeOptionIdentityJournal();try{const value=await readNativeOwnedOptionState(r.page,nativeOptionPredicate(selected()),'Option 1',()=>r.runtime.protectedTraceState().then(({page:_p,frames:_f,...s})=>s),()=>{},h=>ids.identify(h));expect(value.selected).toBe(false);expect(value.labelOwnership).toBeNull();expect(value.labelSourceIds).toEqual([]);expect(()=>validateNativeOptionProof({...value,labelSourceIds:['fabricated-label-source']})).toThrow('INVALID_NATIVE_OPTION_MAPPING');}finally{await ids.close();await r.close();}});
for(const mode of ['wrapped','aria','multiple_labels']as const)test(`reviewed native label association ${mode}`,async()=>{
 let goal=country(),html=options.replace('value="runtime-one"','value="runtime-one" selected');
 if(mode==='wrapped')html='<label>Country'+html.replace('>Pick</option>',' label="Pick"></option>').replace('>Option 1</option>',' label="Option 1"></option>').replace('>Option 2</option>',' label="Option 2"></option>')+'</label>';
 if(mode==='aria')html='<span id="country">Country</span>'+html.replace('<select>','<select aria-labelledby="country">');
 if(mode==='multiple_labels'){const text='Verify that Option 1 is selected in Country Region.';goal=NativeOptionVerificationGoalV2Schema.parse({...goal,sourceText:text,instruction:text,sourceInstructionSpan:{start:0,end:text.length},claim:{...goal.claim,controlConstraints:[{kind:'label',text:'Country',sourceSpan:{start:36,end:43}},{kind:'label',text:'Region',sourceSpan:{start:44,end:50}}]}});html='<label for="choice">Country</label><label for="choice">Region</label>'+html.replace('<select>','<select id="choice">');}
 const f=await fixture(html,[goal]);try{const r=await f.run();expect(r.kind,JSON.stringify(r)).toBe('success');}finally{await f.close();}});
test('native trace/capture correspondence rejects altered claim and fresh proof with recomputed digests',async()=>{const f=await fixture(options,[choose(),selected()]);try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');const artifact=await new SuccessfulTraceV5Store(f.root).readSuccessfulExplorationV5(r.context.result.testSpecId,r.context.result.explorationAttemptId!),original=artifact.protectedArtifact();
 for(const kind of ['polarity','claim','observation','order']as const){const altered=structuredClone(original),record=altered.trace.successfulPath.find(s=>s.type==='verification_goal');if(!record||!('verificationVersion'in record))throw Error('native record');if(kind==='polarity')record.comparison.expectedSelected=false;if(kind==='claim')record.strategy.claimDigest='1'.repeat(64);if(kind==='observation')record.observations[0]!.sessionId='foreign-session';if(kind==='order')record.actionOrdinal=0;const{traceDigest:_d,...data}=altered.trace;altered.trace.traceDigest=successfulTraceDigestV5(data);expect(()=>parseProtectedTraceCaptureBundleV5(altered.capture,altered.trace)).toThrow();}
 }finally{await f.close();}});
test('native successful accounting survives cleanup uncertainty without QA promotion',async()=>{const f=await fixture(options,[choose(),selected()]),original=ProtectedContextFactory.prototype.open;let opened=0;ProtectedContextFactory.prototype.open=async function(...args){const ordinal=++opened,session=await original.apply(this,args);if(ordinal===3)session.closeWithFinalCheck=async()=>{await session.close();throw Error('PRIVATE_CLEANUP');};return session;};try{const r=await f.run();if(r.kind==='bridge_error')throw Error('bridge');expect(r.context.result.terminal.status).toBe('ENVIRONMENT_FAILED');expect(r.context.result.cleanup).toBe('unverified');expect(r.context.result.executionRunIds).toHaveLength(1);const trace=await new SuccessfulTraceV5Store(f.root).readSuccessfulExplorationV5(r.context.result.testSpecId,r.context.result.explorationAttemptId!),v9=await new DeferredCompilerV4Store(f.root).readResolvedV9(r.context.result.testSpecId,r.context.result.compilerAttemptId!,trace),pair=await new DeferredReplayV9Store(f.root).readReplayV1(r.context.result.testSpecId,r.context.result.deferredReplay!.orchestrationId,v9);const run=requireTrustedDeferredReplayReadbackV1(pair).record.runs[0]!;expect(run.result.kind).toBe('non_qa_stop');expect(run.steps[0]!.status).toBe('succeeded');expect(run.steps[1]!.verification?.actual).toBe(true);}finally{ProtectedContextFactory.prototype.open=original;await f.close();}});
async function throughPython(f: Fixture, response: Awaited<ReturnType<Fixture['run']>>, projection: unknown) {
  const file = path.join(f.root, 'external.json'); await writeFile(file, JSON.stringify({ response, projection }));
  const code = `import sys,json;sys.path.insert(0,'src');from playwright_demo.protocol_v2 import parse_response;from playwright_demo.report_projection_v2 import parse_report_projection;v=json.load(open(sys.argv[1]));r,_=parse_response(json.dumps(v['response']).encode(),v['response']['context']['result']['executionProfileRef']);p=parse_report_projection(json.dumps(v['projection']).encode(),r);print(p['kind'])`;
  const output = await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'), ['-c', code, file], { cwd: process.cwd(), encoding: 'utf8' });
  expect(output.stdout.trim()).toBe((projection as { kind: string }).kind);
}
