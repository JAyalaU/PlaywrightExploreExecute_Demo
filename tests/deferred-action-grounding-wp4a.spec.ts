import { expect, test, type ElementHandle } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harness,input,compile,fill,check,select,execute } from './helpers/deferred-v9-fixtures.js';
import { choose, activate, action } from './helpers/action-v2-fixtures.js';
import { DeferredCompilerV4Store,requireTrustedResolvedTestReadbackV9,TrustedResolvedTestReadbackV9 } from '../app/evidence/deferred-compiler-store-v4.js';
import { runDeferredResolvedTestV9,requireTrustedDeferredRunV9,TrustedDeferredRunV9 } from '../app/runner/deferred-v9.js';
import { SuccessfulTraceAssemblerV5 } from '../app/exploration/trace-assembly-v5.js';
import { SuccessfulTraceV5Store } from '../app/evidence/trace-store-v5.js';
import { TrustedObservationSessionV1 } from '../app/exploration/trusted-observation.js';
import { GoalDirectedVerificationControllerV1 } from '../app/interpretation/verification-strategy.js';
import type { TestSpecV6V2 } from '../app/domain/index.js';

type Fixture=Awaited<ReturnType<typeof harness>>;
async function accepted(f:Fixture){const trace=await input(f),compiled=await compile(f,trace);expect(compiled.kind,JSON.stringify(compiled.compiler.result)).toBe('compiled');
  const cap=await new DeferredCompilerV4Store(f.root).writeCompilationV4(compiled.artifact,trace);if(!cap)throw new Error('Missing v9');return{cap,trace,compiled};}
async function run(f:Fixture,cap:TrustedResolvedTestReadbackV9){return requireTrustedDeferredRunV9(await runDeferredResolvedTestV9(f.factory,cap));}

for(const fixture of [
  {name:'unnamed native textarea',html:'<textarea></textarea>',goal:fill(),effect:'entered_text'},
] as const)test(`runner v9 supported ${fixture.name}`,async()=>{const f=await harness(fixture.html,[fixture.goal]);try{const {cap,compiled}=await accepted(f),record=await run(f,cap);
  expect(record.result,JSON.stringify(record)).toEqual({kind:'completed',assertions:0,passed:true});expect(record.cleanup).toBe('verified');expect(record.steps[0]!.effect?.kind).toBe(fixture.effect);
  expect(record.steps[0]!.invocation).toBe('returned');expect(record.provenance!.sessionId).not.toBe(compiled.compiler.freshSessionId);expect(record.startState!.sessionId).toBe(record.finalState!.sessionId);
}finally{await f.close();}});

for(const kind of ['boolean','count','string','url'] as const)test(`source ordered verification ${kind} retains exact facts`,async()=>{
  const f=await harness('<input><div role="dialog" aria-label="Notice">Hello</div>',url=>{const sourceText=kind==='boolean'?'Confirm the Notice dialog is visible.':kind==='count'?'Verify exactly one Notice dialog exists.':kind==='string'?'Verify Notice dialog text "Hello".':`Verify URL ${url}`;
    const goal:TestSpecV6V2['steps'][number]={id:'verify',type:'verification_goal',sourceText,instruction:sourceText,sourceInstructionSpan:{start:0,end:sourceText.length},
      ...(kind==='boolean'?{subject:{role:'dialog' as const,accessibleName:'Notice'},intent:{kind:'property' as const,property:'visible' as const,expected:true}}:{}),
      ...(kind==='count'?{subject:{role:'dialog' as const,accessibleName:'Notice'},intent:{kind:'cardinality' as const,comparison:'equal' as const,count:1}}:{})};
    return[fill(),goal];});
  try{const observations=new TrustedObservationSessionV1(f.session,f.runtime),query={role:'dialog',name:'Notice',frame:{kind:'main'}};
    const request=kind==='url'?{kind:'current_url'}:kind==='count'?{kind:'semantic_query',query}:{kind:'target_property',query,property:kind==='boolean'?'visible':'text'};
    const comparison=(id:string)=>kind==='boolean'?{kind:'boolean',property:'visible',observationId:id,expected:true}:kind==='count'?{kind:'count',operator:'equal',observationId:id,expected:1}:{kind:'string',property:kind==='url'?'url':'text',operator:'equal',observationId:id,expected:kind==='url'?f.url:'Hello'};
    const controller=new GoalDirectedVerificationControllerV1(observations,f.runtime,{complete:async({context})=>JSON.stringify(context.observations.length?{decisionVersion:'4',kind:'conclude',conclusion:'satisfied',comparison:comparison(context.observations.at(-1)!.observationId)}:{decisionVersion:'4',kind:'observe',request})});
    const builder=await SuccessfulTraceAssemblerV5.create({...f,observations,verification:controller}),outcome=await execute(f);expect(outcome.status).toBe('succeeded');if(outcome.status!=='succeeded')throw new Error('No action');builder.appendActionGroundingWitness(outcome.witness);controller.noteSuccessfulGroundingWitness(outcome.witness);
    expect((await controller.evaluate(f.admission.spec.steps[1],1)).conclusion).toBe('satisfied');await builder.appendVerificationGoal('verify');
    const trace=await new SuccessfulTraceV5Store(f.root).writeSuccessfulExplorationV5(await builder.finalize()),result=await compile(f,trace);expect(result.kind).toBe('compiled');const cap=await new DeferredCompilerV4Store(f.root).writeCompilationV4(result.artifact,trace);
    const record=await run(f,cap!);expect(record.result).toEqual({kind:'completed',assertions:1,passed:true});expect(record.steps.map(s=>s.type)).toEqual(['action_goal','verification_goal']);expect(record.steps[1]!.verification!.evaluated).toBe(true);
    expect(record.steps[1]!.before).toEqual(record.steps[0]!.after);
    if(kind==='count'){f.setHtml('<input>');const falseRecord=await run(f,cap!);expect(falseRecord.result).toEqual({kind:'completed',assertions:1,passed:false});expect(falseRecord.steps[1]!.verification!.actual).toBe(0);}
    if(kind==='string'){f.setHtml('<input><div role="dialog" aria-label="Notice">Changed</div>');const falseRecord=await run(f,cap!);expect(falseRecord.result).toEqual({kind:'completed',assertions:1,passed:false});expect(falseRecord.steps[1]!.verification!.actual).toBe('Changed');}
    if(kind==='boolean'){f.setHtml('<input>');const uncertain=await run(f,cap!);expect(uncertain.result).toMatchObject({kind:'non_qa_stop',reasonCode:'VERIFICATION_UNEVALUABLE'});
      expect(uncertain.steps[0]!.effect?.kind).toBe('entered_text');expect(uncertain.steps[1]!.status).toBe('stopped');expect(uncertain.steps[1]!.verification).toBeUndefined();}
  }finally{await f.close();}
});

test('navigation follows source order and records explicit state continuity',async()=>{const f=await harness(select,url=>[{id:'go',type:'navigate',sourceText:`Go to ${url}.`,sourceInstructionSpan:{start:0,end:1},url},choose()]);
  try{const builder=await SuccessfulTraceAssemblerV5.create(f);await f.session.navigate(f.url);f.runtime.invalidate();await builder.appendObservedNavigation('go');const outcome=await execute(f);if(outcome.status!=='succeeded')throw new Error('No witness');builder.appendActionGroundingWitness(outcome.witness);
    const trace=await new SuccessfulTraceV5Store(f.root).writeSuccessfulExplorationV5(await builder.finalize()),result=await compile(f,trace);expect(result.kind).toBe('compiled');const cap=await new DeferredCompilerV4Store(f.root).writeCompilationV4(result.artifact,trace),record=await run(f,cap!);
    expect(record.result).toEqual({kind:'completed',assertions:0,passed:true});expect(record.steps.map(s=>s.type)).toEqual(['navigate','action_goal']);expect(record.steps[1]!.before).toEqual(record.steps[0]!.after);expect(record.steps[0]!.after.mutationEpoch).toBeGreaterThan(record.steps[0]!.before.mutationEpoch);
  }finally{await f.close();}});

for(const mutation of [
  {name:'second eligible dropdown',html:select+select,reason:'NON_UNIQUE_MATCH'},
  {name:'other frame eligible dropdown',html:select+`<iframe title="other" srcdoc='${select}'></iframe>`,reason:'NON_UNIQUE_MATCH'},
  {name:'custom eligible control cannot narrow',html:select+'<div role="combobox"></div>',reason:'NON_UNIQUE_MATCH'},
  {name:'different executable value',html:select.replace('runtime-1','new-value'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'missing choice ownership',html:select.replace('Option 1','Other'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'duplicate displayed label',html:select.replace('</select>','<option value="x">Option 1</option></select>'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'disabled option',html:select.replace('value="runtime-1"','disabled value="runtime-1"'),reason:'OPTION_MAPPING_MISMATCH'},
  {name:'frame owner drift',html:`<iframe title="other" srcdoc='${select}'></iframe>`,reason:'FRAME_MISMATCH'},
  {name:'options truncated',html:'<select>'+Array.from({length:81},(_,i)=>`<option value="v${i}">${i===1?'Option 1':i}</option>`).join('')+'</select>',reason:'INCOMPLETE_EVIDENCE'},
  {name:'generic button',html:'<button>Option 1</button>',reason:'TARGET_MISMATCH'},
] as const)test(`runner guard stops ${mutation.name} before invocation`,async()=>{const f=await harness(select);try{const {cap}=await accepted(f);f.setHtml(mutation.html);const record=await run(f,cap);
  expect(record.result).toMatchObject({kind:'non_qa_stop',reasonCode:mutation.reason});expect(record.steps[0]!.invocation).toBe('not_invoked');expect(record.steps[0]!.effect).toBeUndefined();
}finally{await f.close();}});

test('Country association cannot move to an unrelated control',async()=>{const f=await harness('<label for="country">Country</label>'+select.replace('<select>','<select id="country">')+select,[choose('at')]);try{const {cap}=await accepted(f);
  f.setHtml('<label for="other">Country</label>'+select.replace('<select>','<select id="country">')+'<input id="other">');const record=await run(f,cap);expect(record.result).toMatchObject({kind:'non_qa_stop',reasonCode:'LABEL_ASSOCIATION_MISMATCH'});expect(record.steps[0]!.invocation).toBe('not_invoked');
}finally{await f.close();}});

test('fresh compiler remap becomes v9 pinned replay value',async()=>{const f=await harness(select);try{const trace=await input(f);f.setHtml(select.replace('runtime-1','compiled-fresh'));const result=await compile(f,trace);
  expect(result.kind).toBe('compiled');const cap=await new DeferredCompilerV4Store(f.root).writeCompilationV4(result.artifact,trace);expect((await run(f,cap!)).steps[0]!.argument).toBe('compiled-fresh');
  f.setHtml(select.replace('runtime-1','yet-another'));expect((await run(f,cap!)).result).toMatchObject({kind:'non_qa_stop',reasonCode:'OPTION_MAPPING_MISMATCH'});
}finally{await f.close();}});

test('unauthenticated and copied readback stop before browser authority',async()=>{const f=await harness(select);try{const {cap}=await accepted(f);const original=f.factory.open;let opened=0;f.factory.open=async()=>{opened++;throw new Error('must not open');};
  for(const fake of [requireTrustedResolvedTestReadbackV9(cap),Object.create(TrustedResolvedTestReadbackV9.prototype),Object.assign(Object.create(TrustedResolvedTestReadbackV9.prototype),{protectedArtifact:()=>requireTrustedResolvedTestReadbackV9(cap)})]){
    const record=await run(f,fake as TrustedResolvedTestReadbackV9);expect(record.result).toEqual({kind:'non_qa_stop',reasonCode:'UNAUTHENTICATED_INPUT'});expect(record.steps).toEqual([]);}
  expect(opened).toBe(0);f.factory.open=original;expect(()=>new TrustedDeferredRunV9(Symbol(),{} as never)).toThrow('Runner origin');expect(()=>requireTrustedDeferredRunV9({} as TrustedDeferredRunV9)).toThrow('Untrusted');
}finally{await f.close();}});

test('tampered persisted value fails authentication before runner handoff',async()=>{const f=await harness(select);try{const {compiled,trace}=await accepted(f),file=path.join(f.root,'deferred-compiler-v4-resolved-v9',compiled.compiler.testSpecId,compiled.compiler.compilerAttemptId+'.json');
  const data=JSON.parse(await readFile(file,'utf8'));data.resolved.executionSteps[0].executableArgument='forged';await writeFile(file,JSON.stringify(data));await expect(new DeferredCompilerV4Store(f.root).readResolvedV9(compiled.compiler.testSpecId,compiled.compiler.compilerAttemptId,trace)).rejects.toThrow();
}finally{await f.close();}});

test('cleanup failure overrides completed mutation and preserves effects',async()=>{const f=await harness('<input>',[fill()]);try{const {cap}=await accepted(f),open=f.factory.open.bind(f.factory);f.factory.open=async(...args)=>{const session=await open(...args),close=session.closeWithFinalCheck.bind(session);session.closeWithFinalCheck=async(check)=>{await close(check);throw new Error('cleanup unverified');};return session;};
  const record=await run(f,cap);expect(record.result).toEqual({kind:'non_qa_stop',reasonCode:'CLEANUP_UNVERIFIED'});expect(record.cleanup).toBe('unverified');expect(record.steps[0]!.effect).toEqual({kind:'entered_text',nativeControl:'input',value:'exact text'});
}finally{await f.close();}});

test('post-effect mutation during renewed proof cannot preserve old successful value',async()=>{const f=await harness('<input>',[fill()]);try{const {cap}=await accepted(f),s=await f.factory.open({id:'desktop',version:'1'}),p=await s.context.newPage();await p.goto(f.url);const h=await p.locator('input').elementHandle();if(!h)throw new Error('No handle');const proto=Object.getPrototypeOf(h) as ElementHandle,fillOld=proto.fill,readOld=proto.$;await s.close();let invoked=false,reads=0;
  try{proto.fill=async function(...args){await fillOld.apply(this,args);invoked=true;};proto.$=async function(selector:string){const carrier=await readOld.call(this,selector);if(invoked&&selector==='runner_v9_native_facts='&&++reads===1)await this.evaluate(node=>{if(node instanceof HTMLInputElement)node.value='drift';});return carrier;};
    const record=await run(f,cap);expect(record.result).toEqual({kind:'non_qa_stop',reasonCode:'POST_EFFECT_UNPROVEN',failedStepId:requireTrustedResolvedTestReadbackV9(cap).resolved.executionSteps[0]!.id});expect(record.steps[0]!.invocation).toBe('returned');expect(record.steps[0]!.effect).toBeUndefined();
  }finally{proto.fill=fillOld;proto.$=readOld;}
}finally{await f.close();}});

test('closing observer drift rejects while cleanup and actual effect accounting survive',async()=>{const f=await harness('<input>',[fill()]);try{const {cap}=await accepted(f),open=f.factory.open.bind(f.factory);f.factory.open=async(...args)=>{const session=await open(...args);session.onClosing(()=>{void session.context.pages()[0]!.evaluate(()=>{document.querySelector('input')!.value='closing drift';}).catch(()=>{});});return session;};
  const record=await run(f,cap);expect(record.result).toMatchObject({kind:'non_qa_stop',reasonCode:'STATE_CONTINUITY_MISMATCH'});expect(record.cleanup).toBe('verified');expect(record.steps[0]!.effect).toEqual({kind:'entered_text',nativeControl:'input',value:'exact text'});
}finally{await f.close();}});

test('failed trusted final callback still completes protected cleanup',async()=>{const f=await harness('<input>',[fill()]);try{const {cap}=await accepted(f),open=f.factory.open.bind(f.factory);let closed=false;f.factory.open=async(...args)=>{const s=await open(...args),close=s.closeWithFinalCheck.bind(s);s.closeWithFinalCheck=async()=>{try{await close(async()=>{throw new Error('final read unavailable');});}finally{closed=s.context.pages().length===0;}};return s;};
  const record=await run(f,cap);expect(closed).toBe(true);expect(record.cleanup).toBe('verified');expect(record.result).toMatchObject({kind:'non_qa_stop',reasonCode:'STATE_CONTINUITY_MISMATCH'});expect(record.steps[0]!.effect).toBeDefined();
}finally{await f.close();}});

test('fresh profile mismatch stops before opening a context',async()=>{const f=await harness(select);try{const {cap}=await accepted(f),other=await harness(select);try{let opened=false;other.factory.open=async()=>{opened=true;throw new Error('no open');};const record=requireTrustedDeferredRunV9(await runDeferredResolvedTestV9(other.factory,cap));expect(record.result).toEqual({kind:'non_qa_stop',reasonCode:'PROFILE_MISMATCH'});expect(opened).toBe(false);}finally{await other.close();}}finally{await f.close();}});

for(const tag of ['button','a'] as const)test(`broad native activation cannot become generic ${tag}`,async()=>{const f=await harness('<input type="checkbox" aria-label="Save">',[activate()]);try{const {cap}=await accepted(f);f.setHtml(tag==='a'?'<a href="#">Save</a>':'<button>Save</button>');const record=await run(f,cap);expect(record.result).toMatchObject({kind:'non_qa_stop',reasonCode:'UNSUPPORTED_CAPABILITY'});expect(record.steps[0]!.invocation).toBe('not_invoked');}finally{await f.close();}});

test('nested frame ancestry is reconstructed without old refs',async()=>{const f=await harness(`<iframe title="Owner" srcdoc='${select}'></iframe>`);try{const {cap}=await accepted(f);expect((await run(f,cap)).result.kind).toBe('completed');f.setHtml(`<iframe title="Changed owner" srcdoc='${select}'></iframe>`);expect((await run(f,cap)).result).toMatchObject({kind:'non_qa_stop',reasonCode:'FRAME_MISMATCH'});}finally{await f.close();}});

test('exact authored role and name constrain the complete all-frame domain',async()=>{const goal=action([['Enter','effect'],[' ','neutral'],['exact text','argument'],[' into the ','neutral'],['textbox','target'],[' ','neutral'],['Email','target'],['.','neutral']],
  [{id:'e',kind:'effect',effect:'enter_text',sourceSegmentIds:['p0']},{id:'a',kind:'argument',purpose:'entered_text',authoredText:'exact text',sourceSegmentIds:['p2']},
   {id:'r',kind:'constraint',constraint:'role',subject:{kind:'target'},polarity:'positive',authoredText:'textbox',sourceSegmentIds:['p4']},
   {id:'n',kind:'constraint',constraint:'name',subject:{kind:'target'},polarity:'positive',authoredText:'Email',sourceSegmentIds:['p6']}]);
  const f=await harness('<input aria-label="Email"><input aria-label="Other">',[goal]);try{const {cap}=await accepted(f);expect((await run(f,cap)).result.kind).toBe('completed');f.setHtml('<input aria-label="Different"><input aria-label="Other">');expect((await run(f,cap)).result).toMatchObject({kind:'non_qa_stop',reasonCode:'TARGET_MISMATCH'});}finally{await f.close();}});

for(const scenario of [
  {name:'fill',html:'<input>',goal:fill(),selector:'input',method:'fill'},
  {name:'choice',html:select,goal:choose(),selector:'select',method:'selectOption'},
  {name:'native activation',html:'<input type="checkbox">',goal:check('checkbox'),selector:'input',method:'click'},
] as const)test(`runner dispatches exactly once on the retained ${scenario.name} handle`,async()=>{const f=await harness(scenario.html,[scenario.goal]);try{const {cap}=await accepted(f);
  const session=await f.factory.open({id:'desktop',version:'1'}),page=await session.context.newPage();await page.goto(f.url);const handle=await page.locator(scenario.selector).elementHandle();if(!handle)throw new Error('Missing instrumentation handle');
  const proto=Object.getPrototypeOf(handle) as ElementHandle,original=proto[scenario.method];await session.close();let calls=0,dispatchHandle:ElementHandle|undefined;
  try{
    if(scenario.method==='fill')proto.fill=async function(...args:Parameters<ElementHandle['fill']>){calls++;dispatchHandle=this;return (original as ElementHandle['fill']).apply(this,args);};
    else if(scenario.method==='selectOption')proto.selectOption=async function(...args:Parameters<ElementHandle['selectOption']>){calls++;dispatchHandle=this;return (original as ElementHandle['selectOption']).apply(this,args);};
    else proto.click=async function(...args:Parameters<ElementHandle['click']>){calls++;dispatchHandle=this;return (original as ElementHandle['click']).apply(this,args);};
    const record=await run(f,cap);expect(record.result).toMatchObject({kind:'completed'});expect(record.steps[0]!.effect).toBeDefined();expect(calls).toBe(1);expect(dispatchHandle).toBeDefined();
  }finally{Object.assign(proto,{[scenario.method]:original});await handle.dispose();}
}finally{await f.close();}});

for(const mode of ['no-op','partial failure','replace-before','replace-after','option-after','page-closed-after'] as const)test(`execution accounting ${mode}`,async()=>{const f=await harness(mode==='option-after'?select:'<input>',mode==='option-after'?[choose()]:[fill()]);try{const {cap}=await accepted(f);
  const session=await f.factory.open({id:'desktop',version:'1'}),page=await session.context.newPage();await page.goto(f.url);const h=await page.locator(mode==='option-after'?'select':'input').elementHandle();if(!h)throw new Error('No handle');
  const proto=Object.getPrototypeOf(h) as ElementHandle,method=mode==='option-after'?'selectOption':mode==='replace-before'?'scrollIntoViewIfNeeded':'fill',old=proto[method];await session.close();
  try{if(method==='fill')proto.fill=async function(...args:Parameters<ElementHandle['fill']>){if(mode==='no-op')return;await (old as ElementHandle['fill']).apply(this,args);if(mode==='partial failure')throw new Error('partial');if(mode==='replace-after')await this.evaluate(node=>{if(node instanceof Element)node.replaceWith(node.cloneNode(true));});if(mode==='page-closed-after')await (await this.ownerFrame())!.page().close();};
    else if(method==='scrollIntoViewIfNeeded')proto.scrollIntoViewIfNeeded=async function(...args){await (old as ElementHandle['scrollIntoViewIfNeeded']).apply(this,args);await this.evaluate(node=>{if(node instanceof Element)node.replaceWith(node.cloneNode(true));});};
    else proto.selectOption=async function(...args){const value=await(old as ElementHandle['selectOption']).apply(this,args);await this.evaluate(node=>{(node as HTMLSelectElement).options[1]!.value='changed';});return value;};
    const record=await run(f,cap);expect(record.result.kind).toBe('non_qa_stop');expect(record.steps[0]!.effect).toBeUndefined();expect(record.steps[0]!.invocation).toBe(mode==='replace-before'?'not_invoked':mode==='partial failure'?'threw':'returned');
    if(mode==='no-op')expect(record.result).toMatchObject({reasonCode:'POST_EFFECT_UNPROVEN'});
    if(mode==='page-closed-after'){expect(record.steps[0]!.afterStateStatus).toBe('unavailable');expect(record.steps[0]!.mutationMayHaveOccurred).toBe(true);expect(record.steps[0]!.after).toEqual(record.steps[0]!.before);}
  }finally{Object.assign(proto,{[method]:old});}
}finally{await f.close();}});

test('runner/readback execute in new process with exploration and MCP imports blocked',async()=>{const f=await harness(select);try{const {cap,compiled}=await accepted(f),{trace}=requireTrustedResolvedTestReadbackV9(cap);
  const script=`import { registerHooks } from 'node:module';registerHooks({resolve(specifier,context,nextResolve){if(specifier.includes('@playwright/mcp')||specifier.includes('@modelcontextprotocol/'))throw new Error('blocked MCP');const result=nextResolve(specifier,context);if(result.url.includes('/exploration/'))throw new Error('blocked exploration');return result;}});
    const {SuccessfulTraceV5Store}=await import('./dist/evidence/trace-store-v5.js');const {DeferredCompilerV4Store}=await import('./dist/evidence/deferred-compiler-store-v4.js');
    const {runDeferredResolvedTestV9,requireTrustedDeferredRunV9}=await import('./dist/runner/deferred-v9.js');const {ProtectedContextFactory}=await import('./dist/profile/context.js');const {ProfileCatalog}=await import('./dist/profile/contracts.js');
    const c=new ProfileCatalog(${JSON.stringify([f.factory.catalog.resolve(trace.executionProfileRef).profile])},${JSON.stringify([f.factory.catalog.resolve(trace.executionProfileRef).policy])});
    const t=await new SuccessfulTraceV5Store(${JSON.stringify(f.root)}).readSuccessfulExplorationV5(${JSON.stringify(trace.testSpecId)},${JSON.stringify(trace.explorationAttemptId)});
    const r=await new DeferredCompilerV4Store(${JSON.stringify(f.root)}).readResolvedV9(${JSON.stringify(trace.testSpecId)},${JSON.stringify(compiled.compiler.compilerAttemptId)},t);
    console.log(JSON.stringify(requireTrustedDeferredRunV9(await runDeferredResolvedTestV9(new ProtectedContextFactory(c),r)).result));`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000});expect(JSON.parse(result.stdout.trim())).toEqual({kind:'completed',assertions:0,passed:true});
}finally{await f.close();}});
