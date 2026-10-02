import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElementHandle } from '@playwright/test';
import { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } from '../app/exploration/action-candidate-grounding.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { admitActionSemanticsV2, type TrustedSemanticAdmissionV2 } from '../app/domain/action-semantic-admission.js';
import { candidateGroundingDigest as hash } from '../app/domain/action-candidate-grounding.js';
import type { GroundingCorrespondenceV1 } from '../app/domain/action-grounding-strategy.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../app/domain/index.js';
import { executeActionGoalGroundingV1 } from '../app/interpretation/action-grounding-execution-controller.js';
import { SuccessfulTraceAssemblerV5, parseProtectedTraceCaptureBundleV5 } from '../app/exploration/trace-assembly-v5.js';
import { SuccessfulTraceV5Store, requireTrustedSuccessfulTraceReadbackV5,
  TrustedSuccessfulTraceReadbackV5 } from '../app/evidence/trace-store-v5.js';
import { TrustedObservationSessionV1 } from '../app/exploration/trusted-observation.js';
import { GoalDirectedVerificationControllerV1 } from '../app/interpretation/verification-strategy.js';
import { action, activate, choose } from './helpers/action-v2-fixtures.js';
import { compileDeferredSuccessfulTraceV5, requireTrustedDeferredCompilationV4, TrustedDeferredCompilationV4 } from '../app/exploration/deferred-trace-compiler-v4.js';
import { DeferredCompilerV4Store, requireTrustedResolvedTestReadbackV9, TrustedResolvedTestReadbackV9 } from '../app/evidence/deferred-compiler-store-v4.js';
import { parseCompilerAttemptV4, parseResolvedTestSpecV9, ResolvedTestSpecV9Schema } from '../app/domain/deferred-action-compiler.js';

const select = '<select><option value="">Choose</option><option value="runtime-1">Option 1</option></select>';
const fill = () => action([['Enter', 'effect'], [' ', 'neutral'], ['exact text', 'argument'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
  { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'exact text', sourceSegmentIds: ['p2'] },
]);
const check = (role: 'checkbox' | 'radio') => action([['Click', 'effect'], [' the ', 'neutral'], [role, 'target'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
  { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
  { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: ['p2'] },
]);
const verification = (id = 'verify'): TestSpecV6V2['steps'][number] => ({ id, type: 'verification_goal',
  sourceText: 'Confirm the textbox is visible.', instruction: 'Confirm the textbox is visible.',
  subject: { role: 'textbox' }, intent: { kind: 'property', property: 'visible', expected: true },
  sourceInstructionSpan: { start: 0, end: 31 } });

async function harness(html: string, goalsInput: TestSpecV6V2['steps'] | ((url: string) => TestSpecV6V2['steps']) = [choose()]) {
  let currentHtml = html;
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(currentHtml); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `http://127.0.0.1:${address.port}/`;
  const goals = typeof goalsInput === 'function' ? goalsInput(url) : goalsInput;
  let end = 0;
  const steps = structuredClone(goals).map((g, index) => {
    if (index) end++;
    g.sourceInstructionSpan = { start: end, end: end + g.sourceText.length }; end += g.sourceText.length;
    return g;
  });
  const draft: TestSpecV6V2 = { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'trace-v5-fixture',
    sourceInstruction: steps.map((g) => g.sourceText).join(' '), executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url }, steps, instructionAccounting: steps.flatMap((g, i) => [
      ...(i ? [{ classification: 'neutral' as const, sourceSpan: { start: g.sourceInstructionSpan.start - 1, end: g.sourceInstructionSpan.start }, authoredText: ' ' }] : []),
      { classification: 'clause' as const, stepId: g.id, sourceSpan: g.sourceInstructionSpan, authoredText: g.sourceText },
    ]) };
  const versions = { goalContractVersion: '2' as const, primaryExtractionVersion: 'mock_primary', independentExtractionVersion: 'mock_independent',
    primaryPromptVersion: 'mock_primary', independentPromptVersion: 'mock_independent' };
  const { schemaVersion: _schema, sourceContractVersion: _contract, steps: _steps, instructionAccounting: _accounting, ...metadata } = draft;
  const admission = admitActionSemanticsV2(metadata, draft, structuredClone(draft), versions);
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const session = await McpExplorationSession.open(factory, draft.executionProfileRef, factory.catalog.resolve(draft.executionProfileRef), 'wp3a-attempt');
  await session.navigate(url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp3a-attempt');
  const root = await mkdtemp(path.join(tmpdir(), 'trace-v5-'));
  return { admission, runtime, session, url, root, factory, setHtml: (value: string) => { currentHtml = value; }, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true }); } };
}
type Run = Awaited<ReturnType<typeof harness>>;
function correspondence(goal: ActionGoalV2): GroundingCorrespondenceV1 {
  return goal.obligations.map((obligation) => {
    if (obligation.kind === 'effect' || obligation.kind === 'operation') return { obligation, realization: { kind: obligation.kind } };
    if (obligation.kind === 'argument') return { obligation, realization: { kind: 'literal' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role') return { obligation,
      realization: obligation.authoredText === 'dropdown' ? { kind: 'role_semantic', role: 'combobox' } :
        { kind: 'role_exact', role: obligation.authoredText as 'checkbox' | 'radio' | 'textbox' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'name') return { obligation,
      realization: { kind: 'name_exact', name: obligation.authoredText } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'context') return { obligation,
      realization: { kind: 'label', text: 'Country', sourceSegmentIds: ['p4'], sourceSpan: goal.sourceAccounting[4]!.sourceSpan } };
    return { obligation, realization: { kind: 'pending' } };
  });
}
async function execute(run: Run, id = 's1') {
  const sourceGoal = run.admission.spec.steps.find((g) => g.id === id);
  if (sourceGoal?.type !== 'action_goal') throw new Error('Missing source action');
  const goal = structuredClone(sourceGoal) as ActionGoalV2, entries = correspondence(goal);
  const effect = goal.obligations.find((o) => o.kind === 'effect');
  const operation = effect?.kind === 'effect' && effect.effect === 'choose' ? 'select_option' :
    effect?.kind === 'effect' && effect.effect === 'enter_text' ? 'fill' : 'click';
  return executeActionGoalGroundingV1({ admission: run.admission, runtime: run.runtime, goalId: id,
    model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: id, operation, correspondence: entries }) },
    independentModel: { extract: async () => JSON.stringify({ mappingExtractionVersion: '1', goalId: id, correspondence: entries }) } });
}
async function success(run: Run, builder: SuccessfulTraceAssemblerV5) {
  const outcome = await execute(run);
  expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
  if (outcome.status !== 'succeeded') throw new Error('No successful witness');
  builder.appendActionGroundingWitness(outcome.witness); return outcome;
}
async function artifact(run: Run) {
  const builder = await SuccessfulTraceAssemblerV5.create(run);
  const outcome = await success(run, builder);
  return { assembled: await builder.finalize(), outcome };
}


async function input(run: Run) {
  const { assembled } = await artifact(run);
  return new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(assembled);
}
async function compile(run: Run, readback: TrustedSuccessfulTraceReadbackV5) {
  await run.session.close();
  return compileDeferredSuccessfulTraceV5(run.factory, readback);
}

for (const fixture of [
  { name: 'unnamed dropdown choice', html: select, goal: choose(), effect: 'native_choice' },
  { name: 'Country-constrained choice', html: '<label for="country">Country</label>'+select.replace('<select>','<select id="country">')+select, goal: choose('at'), effect: 'native_choice' },
  { name: 'unnamed text fill', html: '<input>', goal: fill(), effect: 'entered_text' },
  { name: 'checkbox activation', html: '<input type="checkbox">', goal: check('checkbox'), effect: 'native_activation' },
  { name: 'radio activation', html: '<input type="radio">', goal: check('radio'), effect: 'native_activation' },
  { name: 'textarea fill', html: '<textarea></textarea>', goal: fill(), effect: 'entered_text' },
] as const) test(`fresh compiler v4 proves ${fixture.name} and persists isolated v9`, async () => {
  const run=await harness(fixture.html,[fixture.goal]);
  try {
    const readback=await input(run),result=await compile(run,readback);
    expect(result.kind,JSON.stringify(result.compiler.result)).toBe('compiled');
    expect(result.compiler.freshSessionId).not.toBe(requireTrustedSuccessfulTraceReadbackV5(readback).trace.sessionId);
    expect(result.compiler.freshActions[0]!.witness.postEffect.effect.kind).toBe(fixture.effect);
    const s=result.resolved!.executionSteps[0]!;
    expect(s.type).toBe('action_goal');
    if(s.type==='action_goal') { expect(s.guard.domain).toBe('all_current_page_frames');expect(s.guard.eligibleCount).toBe(1);
      expect(s.guard.sourceGoal).toEqual(run.admission.spec.steps[0]);
      if(s.operation==='select_option'){expect(s.authoredArgument).toBe('Option 1');expect(s.executableArgument).toBe('runtime-1');}
    }
    const store=new DeferredCompilerV4Store(run.root),accepted=await store.writeCompilationV4(result.artifact,readback);
    expect(requireTrustedResolvedTestReadbackV9(accepted!).resolved).toEqual(result.resolved);
    const reopened=new DeferredCompilerV4Store(run.root);
    expect(requireTrustedResolvedTestReadbackV9(await reopened.readResolvedV9(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback)).compiler).toEqual(result.compiler);
    if(fixture.name==='unnamed dropdown choice'){
      const storedTrace=requireTrustedSuccessfulTraceReadbackV5(readback).trace;
      const script=`
        import { registerHooks } from 'node:module';
        registerHooks({resolve(specifier,context,nextResolve){
          if(specifier.includes('@playwright/mcp')||specifier.includes('@modelcontextprotocol/'))throw new Error('MCP dependency loaded');
          const result=nextResolve(specifier,context);
          if(result.url.includes('/exploration/'))throw new Error('Exploration runtime loaded by persisted reader');
          return result;
        }});
        const { SuccessfulTraceV5Store }=await import('./dist/evidence/trace-store-v5.js');
        const { DeferredCompilerV4Store, requireTrustedResolvedTestReadbackV9 }=await import('./dist/evidence/deferred-compiler-store-v4.js');
        const [root,testSpecId,explorationAttemptId,compilerAttemptId]=process.argv.slice(1);
        const traceReadback=await new SuccessfulTraceV5Store(root).readSuccessfulExplorationV5(testSpecId,explorationAttemptId);
        const resolvedReadback=await new DeferredCompilerV4Store(root).readResolvedV9(testSpecId,compilerAttemptId,traceReadback);
        const artifact=requireTrustedResolvedTestReadbackV9(resolvedReadback);
        console.log(JSON.stringify({status:artifact.compiler.result.status,schemaVersion:artifact.resolved.schemaVersion,argument:artifact.resolved.executionSteps[0].executableArgument}));
      `;
      const child=execFileSync(process.execPath,['--input-type=module','-e',script,run.root,result.compiler.testSpecId,
        storedTrace.explorationAttemptId,result.compiler.compilerAttemptId],{cwd:process.cwd(),encoding:'utf8'});
      expect(JSON.parse(child.trim())).toEqual({status:'accepted',schemaVersion:'9',argument:'runtime-1'});
    }
    await expect(store.writeCompilationV4(result.artifact,readback)).rejects.toThrow();
  } finally { await run.close(); }
});

for(const fixture of [
  {name:'second native dropdown',html:select+select,reason:'NON_UNIQUE_MATCH'},
  {name:'eligible custom combobox',html:select+'<div role="combobox" tabindex="0">Custom</div>',reason:'NON_UNIQUE_MATCH'},
  {name:'second dropdown in another frame',html:select+`<iframe title="Child" srcdoc="${select.replaceAll('"','&quot;')}"></iframe>`,reason:'NON_UNIQUE_MATCH'},
  {name:'option absent',html:'<select><option value="other">Other</option></select>',reason:'OPTION_MAPPING_MISMATCH'},
  {name:'duplicate authored label',html:select.replace('</select>','<option value="two">Option 1</option></select>'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'duplicate executable value',html:select.replace('</select>','<option value="runtime-1">Other</option></select>'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'option disabled',html:select.replace('value="runtime-1"','disabled value="runtime-1"'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'option list truncated',html:'<select>'+Array.from({length:81},(_,i)=>`<option value="${i}">${i===0?'Option 1':i}</option>`).join('')+'</select>',reason:'INCOMPLETE_EVIDENCE'},
  {name:'frame drift',html:`<iframe title="Child" srcdoc="${select.replaceAll('"','&quot;')}"></iframe>`,reason:'FRAME_MISMATCH'},
] as const) test(`fresh ${fixture.name} rejects without resolved artifact`,async()=>{
  const run=await harness(select);
  try{const readback=await input(run);run.setHtml(fixture.html);const result=await compile(run,readback);
    expect(result.kind).not.toBe('compiled');expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:fixture.reason});expect(result.resolved).toBeUndefined();
    expect(result.compiler.freshActions).toHaveLength(0);
    const store=new DeferredCompilerV4Store(run.root);expect(await store.writeCompilationV4(result.artifact,readback)).toBeUndefined();
    await expect(store.readResolvedV9(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback)).rejects.toThrow();
  }finally{await run.close();}
});

test('fresh owned label remaps a changed DOM value rather than trusting exploration',async()=>{
  const run=await harness(select);
  try{const readback=await input(run);run.setHtml(select.replace('runtime-1','fresh-value'));const result=await compile(run,readback);
    expect(result.kind,JSON.stringify(result.compiler.result)).toBe('compiled');const s=result.resolved!.executionSteps[0]!;
    if(s.type!=='action_goal')throw new Error('Missing action');expect(s.authoredArgument).toBe('Option 1');expect(s.executableArgument).toBe('fresh-value');
    expect(s.guard.argumentPolicy).toBe('require_fresh_mapping_equal_compiled_argument');
  }finally{await run.close();}
});

test('changed Country ownership cannot authorize a convenient unrelated dropdown',async()=>{
  const run=await harness('<label for="country">Country</label>'+select.replace('<select>','<select id="country">')+select,[choose('at')]);
  try{const readback=await input(run);run.setHtml('<label for="other">Country</label>'+select.replace('<select>','<select id="country">')+'<input id="other">');
    const result=await compile(run,readback);expect(result.kind).not.toBe('compiled');expect(result.resolved).toBeUndefined();expect(result.compiler.freshActions).toHaveLength(0);
  }finally{await run.close();}
});

test('same profile/fingerprint is required before opening fresh compilation',async()=>{
  const run=await harness(select);
  try{const readback=await input(run);const profile=run.factory.catalog.resolve(run.admission.spec.executionProfileRef);
    const mismatched=new ProtectedContextFactory(new ProfileCatalog([{...profile.profile,viewport:{width:901,height:600}}],[profile.policy]));
    const result=await compileDeferredSuccessfulTraceV5(mismatched,readback);expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'PROFILE_MISMATCH'});expect(result.resolved).toBeUndefined();expect(result.compiler.freshSessionId).toBeUndefined();
  }finally{await run.close();}
});

test('compiler-only runtime cannot recreate semantic admission, exploration assembly, or mapping origin',async()=>{
  const run=await harness(select);
  try{const readback=await input(run);const fresh=ActionCandidateGroundingSessionV1.forFreshCompiler(run.session,readback,'compiler-only');
    expect(()=>ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(fresh.runtime)).toThrow();
    await expect(SuccessfulTraceAssemblerV5.create({...run,runtime:fresh.runtime})).rejects.toThrow();
    const record=requireTrustedSuccessfulTraceReadbackV5(readback).trace.successfulPath[0]!;
    if(record.type!=='action_goal')throw new Error('No action');
    const candidate=await fresh.runtime.query(record.witness.finalCheck.candidateObservation.request);
    await expect(fresh.runtime.prepareGrounding(candidate,structuredClone(fresh.mappings.get('s1')!), 'select_option')).rejects.toThrow();
  }finally{await run.close();}
});

test('copied schema-valid trace/compilation/runner readbacks cannot mint origin',async()=>{
  const run=await harness(select);
  try{const readback=await input(run);
    await expect(compileDeferredSuccessfulTraceV5(run.factory,{protectedArtifact:()=>requireTrustedSuccessfulTraceReadbackV5(readback)} as unknown as TrustedSuccessfulTraceReadbackV5)).rejects.toThrow();
    const result=await compile(run,readback),store=new DeferredCompilerV4Store(run.root);
    await expect(store.writeCompilationV4({protectedArtifact:()=>requireTrustedDeferredCompilationV4(result.artifact)} as unknown as TrustedDeferredCompilationV4,readback)).rejects.toThrow();
    expect(()=>requireTrustedResolvedTestReadbackV9({protectedArtifact:()=>({compiler:result.compiler,resolved:result.resolved})} as unknown as TrustedResolvedTestReadbackV9)).toThrow();
    expect(()=>new TrustedDeferredCompilationV4(Symbol(),{compiler:result.compiler})).toThrow();
  }finally{await run.close();}
});

test('authenticated compiler store tampering and cross-authority copies fail closed',async()=>{
  const run=await harness(select);
  try{const readback=await input(run),result=await compile(run,readback),store=new DeferredCompilerV4Store(run.root);await store.writeCompilationV4(result.artifact,readback);
    const file=path.join(run.root,'deferred-compiler-v4-resolved-v9',result.compiler.testSpecId,result.compiler.compilerAttemptId+'.json'),raw=await readFile(file,'utf8'),record=JSON.parse(raw);
    record.resolved.executionSteps[0].executableArgument='forged';await writeFile(file,JSON.stringify(record));
    await expect(store.readResolvedV9(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback)).rejects.toThrow();
    await writeFile(file,raw);const second=path.join(run.root,'other-authority'),target=path.join(second,'deferred-compiler-v4-resolved-v9',result.compiler.testSpecId);
    await mkdir(target,{recursive:true});await copyFile(file,path.join(target,path.basename(file)));
    await expect(new DeferredCompilerV4Store(second).readResolvedV9(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback)).rejects.toThrow();
  }finally{await run.close();}
});

test('mechanical v9 correspondence rejects dropped/changed obligations, arguments, frame, order and old family',async()=>{
  const run=await harness(select);
  try{const readback=await input(run),result=await compile(run,readback),trace=requireTrustedSuccessfulTraceReadbackV5(readback).trace;
    for(const change of [
      (r:any)=>r.executionSteps[0].guard.correspondence.pop(),
      (r:any)=>r.executionSteps[0].guard.sourceGoal.obligations[1].authoredText='Option 2',
      (r:any)=>r.executionSteps[0].executableArgument='substitute',
      (r:any)=>r.executionSteps[0].authoredArgument='Option 2',
      (r:any)=>r.executionSteps[0].guard.frame={kind:'nested',anchors:[{kind:'title',value:'Wrong',exact:true}]},
      (r:any)=>r.executionSteps[0].originStepId='wrong',
      (r:any)=>r.executionSteps[0].operation='click',
      (r:any)=>r.schemaVersion='8',
      (r:any)=>r.executionSteps[0].guard.nativeEffect='generic_activation',
    ]){const r=structuredClone(result.resolved!);change(r);const{resolvedDigest:_d,...data}=r;r.resolvedDigest=hash(data);expect(()=>parseResolvedTestSpecV9(r,trace,result.compiler)).toThrow();}
    const attempt=structuredClone(result.compiler);attempt.checks=attempt.checks.filter(c=>c.kind==='order');const{attemptDigest:_d,...data}=attempt;attempt.attemptDigest=hash(data);expect(()=>parseCompilerAttemptV4(attempt,trace)).toThrow();
    expect(()=>ResolvedTestSpecV9Schema.parse({schemaVersion:'8'})).toThrow();
  }finally{await run.close();}
});

async function verifiedInput(run:Run){
  const observations=new TrustedObservationSessionV1(run.session,run.runtime);
  const controller=new GoalDirectedVerificationControllerV1(observations,run.runtime,{complete:async({context})=>JSON.stringify(
    context.observations.length?{decisionVersion:'4',kind:'conclude',conclusion:'satisfied',comparison:{kind:'boolean',property:'visible',observationId:context.observations.at(-1)!.observationId,expected:true}}:
      {decisionVersion:'4',kind:'observe',request:{kind:'target_property',query:{role:'textbox',frame:{kind:'main'}},property:'visible'}})});
  const builder=await SuccessfulTraceAssemblerV5.create({...run,observations,verification:controller});
  const outcome=await success(run,builder);controller.noteSuccessfulGroundingWitness(outcome.witness);
  expect((await controller.evaluate(run.admission.spec.steps[1],1)).conclusion).toBe('satisfied');await builder.appendVerificationGoal('verify');
  return new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(await builder.finalize());
}

test('ordered native fill and VerificationGoal project fresh trusted strategy into v9',async()=>{
  const run=await harness('<input>',[fill(),verification()]);
  try{const readback=await verifiedInput(run),result=await compile(run,readback);expect(result.kind,JSON.stringify(result.compiler.result)).toBe('compiled');
    expect(result.resolved!.executionSteps.map(s=>s.type)).toEqual(['action_goal','verification_goal']);
     expect(result.compiler.freshVerifications[0]!.observation.stateDigest).toBe(result.compiler.freshActions[0]!.retirement!.after.stateDigest);
    const trace=requireTrustedSuccessfulTraceReadbackV5(readback).trace;
    for(const change of [
      (a:any)=>a.freshVerifications[0].observation.result.value=false,
      (a:any)=>a.freshVerifications[0].observation.frame={kind:'nested',anchors:[{kind:'title',value:'Wrong',exact:true,ownerSnapshotDigest:'1'.repeat(64),observedMatchCount:1}]},
      (a:any)=>a.freshVerifications[0].observation.stateEpoch++,
      (a:any)=>a.freshActions[0].retirement.after.stateEpoch++,
    ]){const a=structuredClone(result.compiler);change(a);const o=a.freshVerifications[0]!.observation;if(o.observationVersion!=='1')throw new Error('Historical fact required');
      // Reconstruct the same trusted-observation preimage, proving schema/digest validity is insufficient.
      const fact={observationVersion:o.observationVersion,observationId:o.observationId,testSpecId:o.testSpecId,explorationAttemptId:o.explorationAttemptId,sessionId:o.sessionId,
        executionProfileRef:o.executionProfileRef,profileFingerprint:o.profileFingerprint,pageId:o.pageId,stateEpoch:o.stateEpoch,mutationEpoch:o.mutationEpoch,stateDigest:o.stateDigest,
        observedAt:o.observedAt,request:o.request,frame:o.frame,status:o.status,...(o.status==='complete'?{result:o.result}:{reason:o.reason})};
      o.witnessDigest=hash(fact);const{attemptDigest:_d,...data}=a;a.attemptDigest=hash(data);expect(()=>parseCompilerAttemptV4(a,trace)).toThrow();}
  }finally{await run.close();}
});

test('fresh verification mismatch is a typed non-QA rejection without v9',async()=>{
  const run=await harness('<input>',[fill(),verification()]);
  try{const readback=await verifiedInput(run);run.setHtml('<input oninput="this.style.visibility=\'hidden\'">');
    const result=await compile(run,readback);expect(result.kind).not.toBe('compiled');expect(result.resolved).toBeUndefined();
    expect(result.compiler.result).toMatchObject({status:'rejected'});
  }finally{await run.close();}
});

for(const fixture of [
  {name:'no-op successful return',failure:'noop',reason:'POST_EFFECT_UNPROVEN'},
  {name:'partial failed execution',failure:'throw',reason:'POST_EFFECT_UNPROVEN'},
  {name:'replaced target before execution',failure:'replace',reason:'INCOMPLETE_EVIDENCE'},
  {name:'native option value mutation before execution',failure:'option',reason:'STALE_EVIDENCE'},
] as const)test(`fresh compiler excludes ${fixture.name}`,async()=>{
  const isOption=fixture.failure==='option',run=await harness(isOption?select:'<input>',[isOption?choose():fill()]);
  const original=ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding;
  let prototype:ElementHandle|undefined,originalFill:ElementHandle['fill']|undefined;
  try{const readback=await input(run);
    ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding=async function(preparation,deadline){
      const owner=ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this),page=owner.session.browserSession.context.pages()[0]!;
      if(fixture.failure==='replace')await page.locator('input').evaluate(e=>e.replaceWith(e.cloneNode(true)));
      if(fixture.failure==='option')await page.locator('option').nth(1).evaluate(e=>(e as HTMLOptionElement).value='changed');
      if(fixture.failure==='noop'||fixture.failure==='throw'){
        const h=await page.locator('input').elementHandle();prototype=Object.getPrototypeOf(h!) as ElementHandle;originalFill=prototype.fill;
        prototype.fill=async function(value,options){if(fixture.failure==='throw'){await originalFill!.call(this,value,options);throw new Error('Restricted fixture detail');}};
      }
      return original.call(this,preparation,deadline);
    };
    const result=await compile(run,readback);expect(result.kind).not.toBe('compiled');expect(result.resolved).toBeUndefined();expect(result.compiler.freshActions).toHaveLength(0);
    expect(result.compiler.result,JSON.stringify(result.compiler.executionStops)).toMatchObject({status:'rejected',reasonCode:fixture.reason});expect(JSON.stringify(result.compiler)).not.toContain('Restricted fixture detail');
    const store=new DeferredCompilerV4Store(run.root);expect(await store.writeCompilationV4(result.artifact,readback)).toBeUndefined();
    const reopened=await store.readCompilerAttemptV4(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback);
    expect(reopened.executionStops).toHaveLength(1);expect(reopened.executionStops[0]!.execution.status).not.toBe('succeeded');
    expect(reopened.freshActions).toHaveLength(0);
  }finally{ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding=original;if(prototype&&originalFill)prototype.fill=originalFill;await run.close();}
});

test('unverified protected cleanup cannot issue accepted v9',async()=>{
  const run=await harness(select),original=McpExplorationSession.prototype.close;
  try{const readback=await input(run);await run.session.close();McpExplorationSession.prototype.close=async function(){await original.call(this);throw new Error('Cleanup unavailable');};
    const result=await compileDeferredSuccessfulTraceV5(run.factory,readback);expect(result.resolved).toBeUndefined();expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'CLEANUP_UNVERIFIED'});expect(result.compiler.cleanup).toBe('unverified');
  }finally{McpExplorationSession.prototype.close=original;await run.close();}
});

test('exact authored role and name remain constraints in fresh all-frame predicate',async()=>{
  const goal=action([['Enter','effect'],[' ', 'neutral'],['text','argument'],[' in ', 'neutral'],['textbox','target'],[' ', 'neutral'],['Email','target'],['.','neutral']],[
    {id:'e',kind:'effect',effect:'enter_text',sourceSegmentIds:['p0']},{id:'a',kind:'argument',purpose:'entered_text',authoredText:'text',sourceSegmentIds:['p2']},
    {id:'r',kind:'constraint',constraint:'role',subject:{kind:'target'},polarity:'positive',authoredText:'textbox',sourceSegmentIds:['p4']},
    {id:'n',kind:'constraint',constraint:'name',subject:{kind:'target'},polarity:'positive',authoredText:'Email',sourceSegmentIds:['p6']},
  ]);
  const run=await harness('<input aria-label="Email"><input aria-label="Other">',[goal]);
  try{const readback=await input(run),result=await compile(run,readback);expect(result.kind).toBe('compiled');const s=result.resolved!.executionSteps[0]!;
    if(s.type!=='action_goal')throw new Error('Missing action');expect(s.guard.predicate.roles).toEqual(['textbox']);expect(s.guard.predicate.names).toEqual(['Email']);
  }finally{await run.close();}
});

test('authored navigation is fresh ordered action while historical retirement is never a browser operation',async()=>{
  const run=await harness(select,url=>[{id:'go',type:'navigate',sourceText:`Go to ${url}.`,sourceInstructionSpan:{start:0,end:1},url},choose()]);
  try{const builder=await SuccessfulTraceAssemblerV5.create(run);await run.session.navigate(run.url);run.runtime.invalidate();await builder.appendObservedNavigation('go');await success(run,builder);
    const readback=await new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(await builder.finalize()),result=await compile(run,readback);
    expect(result.kind,JSON.stringify(result.compiler.result)).toBe('compiled');expect(result.resolved!.executionSteps.map(s=>s.type)).toEqual(['navigate','action_goal']);
    expect(result.compiler.freshNavigations).toHaveLength(1);expect(result.compiler.freshActions[0]!.witness.postEffect.before.stateDigest).toBe(result.compiler.freshNavigations[0]!.after.stateDigest);
  }finally{await run.close();}
});

test('successful temporal VerificationGoal with no closed projection stops unsupported without resolved artifact',async()=>{
  const present:TestSpecV6V2['steps'][number]={id:'present',type:'verification_goal',sourceText:'Confirm the Notice dialog exists.',instruction:'Confirm the Notice dialog exists.',subject:{role:'dialog',accessibleName:'Notice'},intent:{kind:'presence',expected:'present'},sourceInstructionSpan:{start:0,end:1}};
  const disappears:TestSpecV6V2['steps'][number]={id:'disappears',type:'verification_goal',sourceText:'Confirm the Notice dialog disappears.',instruction:'Confirm the Notice dialog disappears.',subject:{role:'dialog',accessibleName:'Notice'},intent:{kind:'temporal',transition:'disappears'},dependsOnStepId:'s1',sourceInstructionSpan:{start:0,end:1}};
  const run=await harness('<div role="dialog" aria-label="Notice">Notice</div><input type="checkbox" onclick="document.querySelector(\'div\').remove()">',[present,check('checkbox'),disappears]);
  try{const observations=new TrustedObservationSessionV1(run.session,run.runtime),controller=new GoalDirectedVerificationControllerV1(observations,run.runtime,{complete:async({context})=>JSON.stringify(
      context.observations.length?{decisionVersion:'4',kind:'conclude',conclusion:'satisfied',comparison:context.goal.id==='present'?{kind:'count',observationId:context.observations.at(-1)!.observationId,operator:'greater_than',expected:0}:
        {kind:'transition',operator:'disappears',earlierObservationId:context.priorObservations[0]!.observation.observationId,laterObservationId:context.observations.at(-1)!.observationId}}:
        {decisionVersion:'4',kind:'observe',request:{kind:'semantic_query',query:{role:'dialog',name:'Notice',frame:{kind:'main'}}}})});
    const builder=await SuccessfulTraceAssemblerV5.create({...run,observations,verification:controller});
    expect((await controller.evaluate(run.admission.spec.steps[0],0)).conclusion).toBe('satisfied');await builder.appendVerificationGoal('present');
    const outcome=await success(run,builder);controller.noteSuccessfulGroundingWitness(outcome.witness);
    expect((await controller.evaluate(run.admission.spec.steps[2],2)).conclusion).toBe('satisfied');await builder.appendVerificationGoal('disappears');
    const readback=await new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(await builder.finalize()),result=await compile(run,readback);
    expect(result.kind).toBe('compilation_unsupported');expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'UNSUPPORTED_VERIFICATION'});expect(result.resolved).toBeUndefined();
  }finally{await run.close();}
});

test('tampered v5 authenticated source cannot enter compiler and generic button/link effect remains closed',async()=>{
  const run=await harness(select);
  try{const readback=await input(run),{trace,capture}=requireTrustedSuccessfulTraceReadbackV5(readback),tampered=structuredClone(trace);
    const record=tampered.successfulPath[0]!;if(record.type!=='action_goal')throw new Error('Missing action');
    (record.witness.postEffect.effect as any)={kind:'generic_activation',role:'button'};
    expect(()=>parseProtectedTraceCaptureBundleV5(capture,tampered)).toThrow();
    const file=path.join(run.root,'deferred-successful-trace-v5',trace.testSpecId,trace.explorationAttemptId+'.json'),json=JSON.parse(await readFile(file,'utf8'));
    json.artifact.trace.source.steps[0].obligations[1].authoredText='Option 2';await writeFile(file,JSON.stringify(json));
    await expect(new SuccessfulTraceV5Store(run.root).readSuccessfulExplorationV5(trace.testSpecId,trace.explorationAttemptId)).rejects.toThrow();
  }finally{await run.close();}
});

test('unrecorded fresh drift after successful action is demoted to typed rejection before v9 issuance',async()=>{
  const run=await harness('<input>',[fill()]),original=ActionCandidateGroundingSessionV1.prototype.protectedTraceState,
    originalExecute=ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding;
  let successfulInvocations=0;
  try{const readback=await input(run);let reads=0;
    ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding=async function(preparation,deadline){
      const outcome=await originalExecute.call(this,preparation,deadline);
      if(outcome.status==='succeeded')successfulInvocations++;
      return outcome;
    };
    ActionCandidateGroundingSessionV1.prototype.protectedTraceState=async function(){
      if(++reads===2){const owner=ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this);await owner.session.browserSession.context.pages()[0]!.locator('input').evaluate(e=>(e as HTMLInputElement).value='drift');}
      return original.call(this);
    };
    const result=await compile(run,readback);expect(result.kind).toBe('compilation_stop');expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'SOURCE_CORRESPONDENCE'});expect(result.resolved).toBeUndefined();
    expect(successfulInvocations).toBe(1);
    // A rejected compiler attempt still needs to account for a real successful mutation
    // whose later state-chain proof failed; it must not be promoted to a resolved artifact.
    const store=new DeferredCompilerV4Store(run.root);
    expect(await store.writeCompilationV4(result.artifact,readback)).toBeUndefined();
    const persisted=await new DeferredCompilerV4Store(run.root).readCompilerAttemptV4(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback);
    expect(persisted.freshActions).toHaveLength(1);
    expect(persisted.freshActions[0]!.witness.postEffect.effect).toMatchObject({kind:'entered_text',value:'exact text'});
    expect(persisted.freshActions[0]!.witness.execution).toMatchObject({status:'succeeded',attempted:true});
    expect(persisted.executionStops).toHaveLength(0);
    expect(persisted.result).toMatchObject({status:'rejected',reasonCode:'SOURCE_CORRESPONDENCE'});
    await expect(store.readResolvedV9(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback)).rejects.toThrow();
  }finally{ActionCandidateGroundingSessionV1.prototype.protectedTraceState=original;ActionCandidateGroundingSessionV1.prototype.executePreparedGrounding=originalExecute;await run.close();}
});

test('late integrity rejection retains valid invocation evidence and discards a substituted retirement proof',async()=>{
  const second=fill();second.id=second.sourceStepId='s2';
  const run=await harness('<input>',[fill(),second]);
  const original=ActionCandidateGroundingSessionV1.prototype.protectedActionGroundingRetirement;
  try{
    const builder=await SuccessfulTraceAssemblerV5.create(run);await success(run,builder);
    const next=await execute(run,'s2');expect(next.status).toBe('succeeded');
    if(next.status!=='succeeded')throw new Error('Missing second success');
    builder.appendActionGroundingWitness(next.witness);
    const readback=await new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(await builder.finalize());
    let reads=0;
    ActionCandidateGroundingSessionV1.prototype.protectedActionGroundingRetirement=function(witnessId){
      const receipt=original.call(this,witnessId);
      if(receipt&&++reads===2){const {witnessDigest:_d,...data}=receipt;data.postEffectDigest='0'.repeat(64);return {...data,witnessDigest:hash(data)};}
      return receipt;
    };
    const result=await compile(run,readback);
    expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'SOURCE_CORRESPONDENCE'});
    expect(result.resolved).toBeUndefined();expect(result.compiler.freshActions).toHaveLength(1);
    expect(result.compiler.freshActions[0]!.witness.preparation.goalId).toBe('s1');
    const store=new DeferredCompilerV4Store(run.root);expect(await store.writeCompilationV4(result.artifact,readback)).toBeUndefined();
    const reopened=await store.readCompilerAttemptV4(result.compiler.testSpecId,result.compiler.compilerAttemptId,readback);
    expect(reopened.freshActions).toEqual(result.compiler.freshActions);expect(reopened.executionStops).toHaveLength(0);
  }finally{ActionCandidateGroundingSessionV1.prototype.protectedActionGroundingRetirement=original;await run.close();}
});

for(const element of ['button','link'] as const)test(`fresh generic ${element} cannot substitute for a supported native activation witness`,async()=>{
  const run=await harness('<input type="checkbox" aria-label="Save">',[activate('Click','Save')]);
  try{const readback=await input(run);run.setHtml(element==='button'?'<button onclick="document.body.dataset.clicked=\'yes\'">Save</button>':'<a href="#clicked">Save</a>');
    const result=await compile(run,readback);expect(result.kind,JSON.stringify({result:result.compiler.result,stops:result.compiler.executionStops})).toBe('compilation_unsupported');expect(result.compiler.result).toMatchObject({status:'rejected',reasonCode:'UNSUPPORTED_ACTIVATION'});
    expect(result.resolved).toBeUndefined();expect(result.compiler.freshActions).toHaveLength(0);expect(result.compiler.executionStops[0]!.execution.attempted).toBe(false);
  }finally{await run.close();}
});
