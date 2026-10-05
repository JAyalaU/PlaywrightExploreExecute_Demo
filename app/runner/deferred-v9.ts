import { randomUUID } from 'node:crypto';
import { selectors, type ElementHandle, type Frame, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { ProtectedContextFactory, ProtectedFinalCheckError, type ProtectedBrowserSession } from '../profile/context.js';
import { assertEquivalentEffectiveProfile } from '../profile/contracts.js';
import { requireTrustedResolvedTestReadbackV9, type TrustedResolvedTestReadbackV9 } from '../evidence/deferred-compiler-store-v4.js';
import type { ResolvedTestSpecV9 } from '../domain/deferred-action-compiler.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { DeferredRunnerRecordV9Schema, parseDeferredRunnerRecordV9, type DeferredRunnerRecordV9, type DeferredRunStateV9, type DeferredRunnerStopV9 } from '../domain/deferred-action-runner.js';
import { readOwnedLabelSourcesFromLocator } from '../browser-action/label-association.js';
import { nativeActivationReceipt } from '../browser-action/native-activation.js';
import { executeVerificationAssertionV9 } from './verification-v9.js';
import { DeferredViewerPreflightError } from '../observability/deferred-viewer-channel.js';

type Action=Extract<ResolvedTestSpecV9['executionSteps'][number],{type:'action_goal'}>;
type Step=DeferredRunnerRecordV9['steps'][number];
const optionSchema=z.strictObject({label:z.string().max(1024),text:z.string().max(1024),value:z.string().max(1024),disabled:z.boolean(),selected:z.boolean(),owned:z.literal(true)});
const factsSchema=z.strictObject({connected:z.literal(true),tag:z.enum(['input','textarea','select','unsupported']),inputType:z.string().max(128),readOnly:z.boolean(),
  value:z.string().max(2048),checked:z.boolean(),multiple:z.boolean(),options:z.array(optionSchema).max(80)});
type Facts=z.infer<typeof factsSchema>;
// Fixed utility-world native facts, immune to page-world getter/Event overrides.
const engines=Promise.all([
  selectors.register('runner_v9_native_facts',()=>{const read=(root:Node)=>{
    if(!(root instanceof HTMLElement)||!root.isConnected)return null;
    const carrier=root.ownerDocument.createElement('span');
    const native=root instanceof HTMLInputElement||root instanceof HTMLTextAreaElement||root instanceof HTMLSelectElement;
    if(root instanceof HTMLSelectElement&&root.options.length>80){carrier.textContent='overflow';return carrier;}
    carrier.textContent=JSON.stringify({connected:true,tag:root instanceof HTMLInputElement?'input':root instanceof HTMLTextAreaElement?'textarea':root instanceof HTMLSelectElement?'select':'unsupported',
      inputType:root instanceof HTMLInputElement?root.type:'',readOnly:root instanceof HTMLInputElement||root instanceof HTMLTextAreaElement?root.readOnly:false,
      value:native?root.value:'',checked:root instanceof HTMLInputElement?root.checked:false,multiple:root instanceof HTMLSelectElement?root.multiple:false,
      options:root instanceof HTMLSelectElement?Array.from(root.options,o=>({label:o.label,text:o.text,value:o.value,disabled:o.disabled||o.parentElement instanceof HTMLOptGroupElement&&o.parentElement.disabled,
        selected:o.selected,owned:o.closest('select')===root})):[]});return carrier;
    };return{query:read,queryAll(root:Node){const e=read(root);return e?[e]:[];}};},{contentScript:true}),
  selectors.register('runner_v9_owned_options',()=>({query(root:Node){return root instanceof HTMLSelectElement?root.options.item(0):null;},
    queryAll(root:Node){return root instanceof HTMLSelectElement?Array.from(root.options).slice(0,81):[];}}),{contentScript:true}),
  selectors.register('runner_v9_state',()=>{const read=(root:Node)=>{if(!(root instanceof HTMLElement))return null;const e=root.ownerDocument.createElement('span');
    const controls=root.querySelectorAll('input,textarea,select');if(controls.length>1000){e.textContent='overflow';return e;}
    e.textContent=JSON.stringify(Array.from(controls,c=>c instanceof HTMLInputElement?{value:c.value,checked:c.checked}:c instanceof HTMLTextAreaElement?{value:c.value}:c instanceof HTMLSelectElement?{value:c.value,selected:Array.from(c.options,o=>o.selected)}:{}));return e;
  };return{query:read,queryAll(root:Node){const e=read(root);return e?[e]:[];}};},{contentScript:true}),
]);
class Stop extends Error {constructor(readonly reason:DeferredRunnerStopV9){super(reason);}}
function stop(reason:DeferredRunnerStopV9):never {throw new Stop(reason);}
const issued=new WeakSet<object>(),token=Symbol('runner-v9-origin');
export class TrustedDeferredRunV9 {
  readonly #record:DeferredRunnerRecordV9;
  constructor(authority:symbol,record:DeferredRunnerRecordV9){if(authority!==token)throw new Error('Runner origin required');this.#record=structuredClone(record);issued.add(this);}
  protectedRecord(){return structuredClone(this.#record);}
}
export function requireTrustedDeferredRunV9(value:TrustedDeferredRunV9){if(!issued.has(value))throw new Error('Untrusted runner v9 origin');return TrustedDeferredRunV9.prototype.protectedRecord.call(value);}
type Candidate={frame:Frame;locator:Locator;handle:ElementHandle;role:Action['guard']['predicate']['roles'][number]};
type Proof={target:Candidate;all:Candidate[];labels:ElementHandle[];options:ElementHandle[];facts:Facts;digest:string};
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const identical=async(a:ElementHandle,b:ElementHandle)=>a.evaluate((node,old)=>node===old,b);
const dispose=async(p:Proof)=>{await Promise.allSettled([...p.all.map(c=>c.handle),...p.labels,...p.options].map(h=>h.dispose()));};

/** Owns a fresh private protected context. No discovery, retry, refs or model/MCP dependency. */
class FreshRunner {
  #tail:Promise<unknown>=Promise.resolve();#epoch=0;#mutation=0;#navigation=0;#stateKey='';
  readonly sessionId=`runner-session-${randomUUID()}`;readonly pageId=`runner-page-${randomUUID()}`;
  constructor(readonly session:ProtectedBrowserSession,readonly page:Page,readonly deadline:number){
    page.on('framenavigated',()=>{this.#navigation++;});
    page.on('frameattached',()=>{this.#navigation++;});
    page.on('framedetached',()=>{this.#navigation++;});
  }
  bounded(closing=false){if(Date.now()>this.deadline)stop('BUDGET_EXHAUSTED');if(!closing&&this.session.isClosed||this.page.isClosed()||this.session.context.pages().length!==1||this.session.context.pages()[0]!==this.page)stop('ENVIRONMENT_FAILURE');}
  async exclusive<T>(callback:()=>Promise<T>):Promise<T>{const prior=this.#tail;let release!:()=>void;this.#tail=new Promise<void>(r=>{release=r;});await prior;try{this.bounded();return await callback();}finally{release();}}
  mutated(){this.#mutation++;}
  /** URL-only state for admitted PoC URL assertions; no document or control read. */
  urlState(closing=false):{state:DeferredRunStateV9;url:string}{
    this.bounded(closing);
    const navigation=this.#navigation,mutation=this.#mutation,url=this.page.url();
    if(url.length>2048)stop('INCOMPLETE_EVIDENCE');
    this.bounded(closing);
    if(this.#navigation!==navigation||this.#mutation!==mutation||this.page.url()!==url||
      this.page.mainFrame().url()!==url)stop('STALE_EVIDENCE');
    const stateDigest=hash({kind:'poc_current_url',pageId:this.pageId,url,navigation,mutation});
    if(stateDigest!==this.#stateKey){this.#stateKey=stateDigest;this.#epoch++;}
    return{url,state:{sessionId:this.sessionId,pageId:this.pageId,stateDigest,stateEpoch:this.#epoch,mutationEpoch:mutation}};
  }
  async state(closing=false):Promise<DeferredRunStateV9>{this.bounded(closing);await engines;const frames=this.page.frames();if(frames.length>8)stop('INCOMPLETE_EVIDENCE');const materials=[];
    for(const f of frames){this.bounded(closing);const content=await f.content(),values=await f.locator('body').locator('runner_v9_state=').textContent({timeout:3000});
      if(content.length>262144||!values||values==='overflow'||values.length>262144)stop('INCOMPLETE_EVIDENCE');materials.push({content,values,url:f.url()});}
    if(frames.length!==this.page.frames().length||frames.some((f,i)=>f!==this.page.frames()[i]))stop('STALE_EVIDENCE');
    const stateDigest=hash({pageId:this.pageId,materials,mutation:this.#mutation});if(stateDigest!==this.#stateKey){this.#stateKey=stateDigest;this.#epoch++;}
    return{sessionId:this.sessionId,pageId:this.pageId,stateDigest,stateEpoch:this.#epoch,mutationEpoch:this.#mutation};}
  async facts(handle:ElementHandle):Promise<Facts>{await engines;const carrier=await handle.$('runner_v9_native_facts=');try{const payload=await carrier?.textContent();
    if(!payload||payload==='overflow'||payload.length>262144)stop('INCOMPLETE_EVIDENCE');const parsed=factsSchema.safeParse(JSON.parse(payload));if(!parsed.success)stop('UNSUPPORTED_CAPABILITY');return parsed.data;
  }finally{await carrier?.dispose();}}
  async framePath(frame:Frame):Promise<Action['guard']['frame']>{if(frame===this.page.mainFrame())return{kind:'main'};const anchors:Extract<Action['guard']['frame'],{kind:'nested'}>['anchors']=[];
    let child=frame;while(child!==this.page.mainFrame()){const parent=child.parentFrame();if(!parent||anchors.length>=8)stop('FRAME_MISMATCH');const element=await child.frameElement();
      try{let selected:typeof anchors[number]|undefined;for(const kind of ['title','testId'] as const){const attr=kind==='title'?'title':'data-testid',value=await element.getAttribute(attr);if(!value||value.length>512)continue;
        const siblings=parent.locator('iframe'),count=await siblings.count();if(count>80)stop('INCOMPLETE_EVIDENCE');let matches=0,owned=false;
        for(let i=0;i<count;i++){if(await siblings.nth(i).getAttribute(attr)!==value)continue;matches++;const h=await siblings.nth(i).elementHandle();try{if(await h?.contentFrame()===child)owned=true;}finally{await h?.dispose();}}
        if(matches===1&&owned){selected={kind,value,exact:true};break;}}
        if(!selected)stop('FRAME_MISMATCH');anchors.unshift(selected);child=parent;
      }finally{await element.dispose();}}
    return{kind:'nested',anchors};}
  async prove(action:Action,post=false):Promise<Proof>{this.bounded();const all:Candidate[]=[],labels:ElementHandle[]=[],options:ElementHandle[]=[];
    try{const frames=this.page.frames();if(frames.length>action.guard.frameLimit)stop('INCOMPLETE_EVIDENCE');
      for(const frame of frames)for(const role of action.guard.predicate.roles){let locator=frame.getByRole(role,{includeHidden:true,...(action.guard.predicate.names.length?{name:action.guard.predicate.names[0]!,exact:true}:{})});
        for(const name of action.guard.predicate.names.slice(1))locator=locator.and(frame.getByRole(role,{name,exact:true,includeHidden:true}));
        const count=await locator.count();if(all.length+count>80)stop('INCOMPLETE_EVIDENCE');for(let i=0;i<count;i++){this.bounded();const current=locator.nth(i),handle=await current.elementHandle();if(!handle||await handle.ownerFrame()!==frame){await handle?.dispose();stop('STALE_EVIDENCE');}all.push({frame,locator:current,handle,role});}}
      // Only accepted/endorsed target role and label realizations may narrow the broad source domain.
      let eligible=all;for(const entry of action.guard.correspondence){const r=entry.realization;if(r.kind==='pending')stop('UNSUPPORTED_CAPABILITY');
        if(r.kind==='role_exact'||r.kind==='role_semantic')eligible=eligible.filter(c=>c.role===r.role);
        if(r.kind==='name_exact'){const kept:Candidate[]=[];for(const c of eligible)if(await c.locator.and(c.frame.getByRole(c.role,{name:r.name,exact:true,includeHidden:true})).count()===1)kept.push(c);eligible=kept;}
        if(r.kind==='label'){const kept:Candidate[]=[];for(const c of eligible){let owned;try{owned=await readOwnedLabelSourcesFromLocator(c.frame,c.locator,r.text,c.role,()=>this.bounded());}
          catch{stop('LABEL_ASSOCIATION_MISMATCH');}if(owned.length){kept.push(c);labels.push(...owned.map(s=>s.handle));}}eligible=kept;if(!eligible.length)stop('LABEL_ASSOCIATION_MISMATCH');}}
      if(eligible.length!==1)stop(eligible.length?'NON_UNIQUE_MATCH':'TARGET_MISMATCH');const target=eligible[0]!;
      if(!same(await this.framePath(target.frame),action.guard.frame))stop('FRAME_MISMATCH');
      if(!await target.handle.isVisible()||!await target.handle.isEnabled())stop('TARGET_MISMATCH');const facts=await this.facts(target.handle);
      if(action.operation==='fill'){if(!['input','textarea'].includes(facts.tag)||facts.tag!==action.guard.nativeControl||facts.readOnly||!await target.handle.isEditable()||action.authoredArgument!==action.executableArgument)stop('UNSUPPORTED_CAPABILITY');}
      else if(action.operation==='select_option'){if(facts.tag!=='select'||action.guard.nativeControl!=='select'||facts.multiple)stop('UNSUPPORTED_CAPABILITY');
        const matches=facts.options.filter(o=>o.label===action.authoredArgument);if(matches.length!==1||matches[0]!.disabled||facts.options.filter(o=>o.value===matches[0]!.value).length!==1||matches[0]!.value!==action.executableArgument)stop('OPTION_MAPPING_MISMATCH');
        options.push(...await target.handle.$$('runner_v9_owned_options='));if(options.length!==facts.options.length||options.length>80)stop('INCOMPLETE_EVIDENCE');}
      else if(action.guard.nativeEffect==='generic_activation'){
        if(target.role!==action.guard.nativeControl)stop('UNSUPPORTED_CAPABILITY');
      }else{if(facts.tag!=='input'||!['checkbox','radio'].includes(facts.inputType)||facts.inputType!==action.guard.nativeControl||!post&&facts.inputType==='radio'&&facts.checked)stop('UNSUPPORTED_CAPABILITY');}
      const digest=hash({guard:action.guard,operation:action.operation,authoredArgument:action.authoredArgument,executableArgument:action.executableArgument,
        roles:eligible.map(c=>c.role),frame:await this.framePath(target.frame),facts});return{target,all,labels,options,facts,digest};
    }catch(e){await Promise.allSettled([...all.map(c=>c.handle),...labels,...options].map(h=>h.dispose()));throw e;}}
  async sameProof(a:Proof,b:Proof){if(a.digest!==b.digest||a.all.length!==b.all.length||a.labels.length!==b.labels.length||a.options.length!==b.options.length||a.target.frame!==b.target.frame||!await identical(a.target.handle,b.target.handle))stop('STALE_EVIDENCE');
    for(const [left,right] of [[a.all.map(c=>c.handle),b.all.map(c=>c.handle)],[a.labels,b.labels],[a.options,b.options]])for(let i=0;i<left!.length;i++)if(!await identical(left![i]!,right![i]!))stop('STALE_EVIDENCE');}
  async execute(action:Action,before:DeferredRunStateV9,pocSemantic=false):Promise<Step>{return this.exclusive(async()=>{
    let initial:Proof|undefined,renewed:Proof|undefined;let invocation:Step['invocation']='not_invoked',predicateDigest:string|undefined,effectDigest:string|undefined,reasonCode:DeferredRunnerStopV9|undefined,invokedAt:string|undefined,returnedAt:string|undefined;
    let after=before,effect:Step['effect'],activationId:string|undefined,afterStateStatus:Step['afterStateStatus']='observed',genericClick=false;
    try{if(!pocSemantic&&!same(await this.state(),before))stop('STATE_CONTINUITY_MISMATCH');initial=await this.prove(action);
      // Preparation can scroll/mutate; renew the entire predicate and retain identity afterwards.
      await initial.target.handle.scrollIntoViewIfNeeded({timeout:3000});renewed=await this.prove(action);await this.sameProof(initial,renewed);
      if(!pocSemantic&&!same(await this.state(),before))stop('STALE_EVIDENCE');predicateDigest=renewed.digest;
      const executionId=`execution-${randomUUID()}`;genericClick=action.operation==='click'&&action.guard.nativeEffect==='generic_activation';
      if(action.operation==='click'&&!genericClick){activationId=executionId;const armed=await nativeActivationReceipt(renewed.target.handle,executionId,'arm');if(armed.clicks!==0)stop('POST_EFFECT_UNPROVEN');}
      if(!pocSemantic&&!same(await this.state(),before))stop('STALE_EVIDENCE');this.bounded();invokedAt=new Date().toISOString();invocation='threw';this.mutated();
      const dispatchStarted=Date.now();
      try{if(action.operation==='fill')await renewed.target.handle.fill(action.executableArgument!,{force:true,timeout:3000});
        else if(action.operation==='select_option')await renewed.target.handle.selectOption({value:action.executableArgument!},{force:true,timeout:3000});
        else if(genericClick)await renewed.target.handle.click({force:true,timeout:Math.max(1,Math.min(this.session.effectiveProfile.profile.timeoutPolicy.navigationMs,this.deadline-Date.now()))});
        else await renewed.target.handle.click({force:true,timeout:3000,noWaitAfter:true});}
      catch{stop('ACTION_FAILED_PARTIAL_OR_UNKNOWN');}invocation='returned';returnedAt=new Date().toISOString();
      if(genericClick){
        effect={kind:'generic_activation',role:renewed.target.role,
          delivery:{executionId,clicks:1,targetOwned:true,dispatched:true,returned:true,
            elapsedMs:Math.min(120_000,Math.max(0,Date.now()-dispatchStarted))}};
        // Delivery is already established. The next replay step obtains its own
        // browser state after a possible document replacement.
        effectDigest=hash(effect);afterStateStatus='unavailable';
      }else{
      const effectState=await this.state(),current=await this.facts(renewed.target.handle);if(await renewed.target.handle.ownerFrame()!==renewed.target.frame||!same(await this.framePath(renewed.target.frame),action.guard.frame))stop('POST_EFFECT_UNPROVEN');
      const postProof=await this.prove(action,true);
      try{if(!same(current,postProof.facts)||!await identical(postProof.target.handle,renewed.target.handle)||!same(effectState,await this.state()))stop('POST_EFFECT_UNPROVEN');
        if(action.operation==='fill'){if(current.value!==action.authoredArgument)stop('POST_EFFECT_UNPROVEN');effect={kind:'entered_text',nativeControl:current.tag==='textarea'?'textarea':'input',value:current.value};}
        else if(action.operation==='select_option'){const strip=(o:Facts['options'])=>o.map(({selected,...rest})=>rest);
          if(!same(strip(current.options),strip(renewed.facts.options)))stop('POST_EFFECT_UNPROVEN');const handles=await renewed.target.handle.$$('runner_v9_owned_options=');
          try{if(handles.length!==renewed.options.length)stop('POST_EFFECT_UNPROVEN');for(let i=0;i<handles.length;i++)if(!await identical(handles[i]!,renewed.options[i]!))stop('POST_EFFECT_UNPROVEN');}finally{await Promise.allSettled(handles.map(h=>h.dispose()));}
          const selected=current.options.filter(o=>o.selected);if(selected.length!==1||selected[0]!.label!==action.authoredArgument||selected[0]!.value!==action.executableArgument||selected[0]!.disabled)stop('POST_EFFECT_UNPROVEN');effect={kind:'native_choice',complete:true,label:selected[0]!.label,value:selected[0]!.value,options:current.options};}
        else{const receipt=await nativeActivationReceipt(renewed.target.handle,executionId,'read');if(receipt.clicks!==1||receipt.nativeInputType!==renewed.facts.inputType||current.checked===renewed.facts.checked)stop('POST_EFFECT_UNPROVEN');effect={kind:'native_activation',executionId,nativeInputType:receipt.nativeInputType,beforeChecked:renewed.facts.checked,checked:current.checked,clicks:1,targetOwned:true};}
        if(!same(current,await this.facts(renewed.target.handle)))stop('POST_EFFECT_UNPROVEN');
        after=await this.state();if(!same(effectState,after)||!same(after,await this.state()))stop('POST_EFFECT_UNPROVEN');effectDigest=hash(effect);
      }finally{if(postProof)await dispose(postProof);}
      }
    }catch(e){reasonCode=e instanceof Stop?e.reason:invocation==='returned'?(genericClick?'ENVIRONMENT_FAILURE':'POST_EFFECT_UNPROVEN'):'ENVIRONMENT_FAILURE';effectDigest=undefined;effect=undefined;try{after=await this.state();}catch{afterStateStatus='unavailable';/* after retains only the last known point */}}
    finally{if(activationId&&renewed)await nativeActivationReceipt(renewed.target.handle,activationId,'clear').catch(()=>{});if(initial)await dispose(initial);if(renewed)await dispose(renewed);}
    return{stepId:action.id,traceRecordId:action.traceRecordId,originStepId:action.originStepId,type:'action_goal',status:reasonCode?'stopped':'succeeded',before,after,afterStateStatus,operation:action.operation,
      ...(action.executableArgument!==undefined?{argument:action.executableArgument}:{}),invocation,mutationMayHaveOccurred:invocation!=='not_invoked',...(predicateDigest?{predicateDigest}:{}),...(effectDigest&&effect?{effectDigest,effect}:{}),
      ...(reasonCode?{reasonCode}:{}),...(invokedAt?{invokedAt}:{}),...(returnedAt?{returnedAt}:{})};
  });}
}

/** One deterministic replay only. Trusted host owns any later two-run agreement policy. */
export async function runDeferredResolvedTestV9(factory:ProtectedContextFactory,input:TrustedResolvedTestReadbackV9):Promise<TrustedDeferredRunV9>{
  const executionRunId=`run-${randomUUID()}`,startedAt=new Date().toISOString(),deadline=Date.now()+120000;
  let artifact:ReturnType<typeof requireTrustedResolvedTestReadbackV9>|undefined,session:ProtectedBrowserSession|undefined,runtime:FreshRunner|undefined;
  const steps:Step[]=[];let startState:DeferredRunStateV9|undefined,finalState:DeferredRunStateV9|undefined,reason:DeferredRunnerStopV9|undefined,failedStepId:string|undefined,cleanup:'verified'|'unverified'='verified';
  try{try{artifact=requireTrustedResolvedTestReadbackV9(input);}catch{stop('UNAUTHENTICATED_INPUT');}
    const r=artifact.resolved,profile=factory.catalog.resolve(r.executionProfileRef);if(profile.fingerprint!==r.profileFingerprint)stop('PROFILE_MISMATCH');
    session=await factory.open(r.executionProfileRef,profile,{observationOwner:{kind:'run',id:executionRunId}});assertEquivalentEffectiveProfile(profile,session.effectiveProfile);
    if(session.effectiveProfile.fingerprint!==r.profileFingerprint)stop('PROFILE_MISMATCH');const page=await session.context.newPage();runtime=new FreshRunner(session,page,deadline);
    if(artifact.trace.source.startState.url!=='about:blank'){const response=await page.goto(artifact.trace.source.startState.url,{timeout:Math.max(1,Math.min(profile.profile.timeoutPolicy.navigationMs,deadline-Date.now()))});
      if(response?.status()===403&&await response.text()==='Network policy denied request')stop('ENVIRONMENT_FAILURE');runtime.mutated();}
    startState=await runtime.state();let current=startState;
    for(const s of r.executionSteps){
      failedStepId=s.id;runtime.bounded();
      const preceding=steps.at(-1);
      const pocUrl=artifact.trace.source.semanticMode==='poc_v1'&&s.type==='verification_goal'&&
        'kind'in s.assertion&&s.assertion.kind==='url';
      let stateRefresh:Step['stateRefresh'];
      if(preceding?.status==='succeeded'&&preceding.effect?.kind==='generic_activation'&&preceding.afterStateStatus==='unavailable')
        current=pocUrl?runtime.urlState().state:await runtime.state();
      else if(pocUrl){const next=runtime.urlState().state;
        if(!same(next,current)){stateRefresh={kind:'url_only',from:current};current=next;}}
      else if(artifact.trace.source.semanticMode==='poc_v1'&&s.type==='action_goal'&&
        preceding?.type==='verification_goal'&&preceding.verification&&
        'kind'in preceding.verification.assertion&&preceding.verification.assertion.kind==='url'){
        const next=await runtime.state();
        if(!same(next,current)){stateRefresh={kind:'rich_after_url',from:current};current=next;}}
      // PoC actions prove their own unique, fresh target immediately before dispatch;
      // unrelated page content can change after the preceding observation.
      else if(!(artifact.trace.source.semanticMode==='poc_v1'&&s.type==='action_goal')&&
        !same(await runtime.state(),current))stop('STATE_CONTINUITY_MISMATCH');
      let entry:Step;
      if(s.type==='action_goal')entry=await runtime.execute(s,current,artifact.trace.source.semanticMode==='poc_v1');
      else{const base={stepId:s.id,traceRecordId:s.traceRecordId,originStepId:s.originStepId,type:s.type,before:current};
        entry=await runtime.exclusive(async()=>{if(s.type==='navigate'){let invocation:Step['invocation']='not_invoked';try{runtime!.mutated();invocation='threw';const response=await page.goto(s.url,{timeout:Math.max(1,Math.min(profile.profile.timeoutPolicy.navigationMs,deadline-Date.now()))});
              if(response?.status()===403&&await response.text()==='Network policy denied request')stop('ENVIRONMENT_FAILURE');invocation='returned';if(page.url()!==new URL(s.url).href)stop('TARGET_MISMATCH');
              return{...base,status:'succeeded' as const,after:await runtime!.state(),afterStateStatus:'observed' as const,invocation,mutationMayHaveOccurred:true};
            }catch(e){let after=current,afterStateStatus:Step['afterStateStatus']='observed';try{after=await runtime!.state();}catch{afterStateStatus='unavailable';}
              return{...base,status:'stopped' as const,after,afterStateStatus,invocation,mutationMayHaveOccurred:invocation!=='not_invoked',reasonCode:e instanceof Stop?e.reason:'ENVIRONMENT_FAILURE' as const};}}
          const result=await executeVerificationAssertionV9(page,s.assertion,{state:()=>runtime!.state(),bounded:()=>runtime!.bounded(),
            ...(pocUrl?{currentUrl:()=>runtime!.urlState().url}:{})}),after=pocUrl?runtime!.urlState().state:await runtime!.state();if(!same(current,after))stop('STATE_CONTINUITY_MISMATCH');
          return{...base,after,afterStateStatus:'observed' as const,status:result.status==='QA_ASSERTION_PASSED'?'assertion_passed' as const:result.status==='QA_ASSERTION_FAILED'?'assertion_failed' as const:'stopped' as const,
            invocation:'not_invoked' as const,mutationMayHaveOccurred:false,...(result.facts?{verification:result.facts}:{}),...(result.proof?{verificationProof:result.proof}:{}),...(result.status==='QA_ASSERTION_PASSED'||result.status==='QA_ASSERTION_FAILED'?{}:{reasonCode:result.reason==='OPTION_MAPPING_MISMATCH'?'OPTION_MAPPING_MISMATCH' as const:result.reason==='FRAME_MISMATCH'?'FRAME_MISMATCH' as const:result.reason==='NON_UNIQUE_MATCH'?'NON_UNIQUE_MATCH' as const:'VERIFICATION_UNEVALUABLE' as const})};});}
      if(stateRefresh)entry={...entry,stateRefresh};
      steps.push(entry);current=entry.after;if(entry.status==='stopped')stop(entry.reasonCode!);
    }
    const lastExecution=r.executionSteps.at(-1);
    const lastPocUrl=artifact.trace.source.semanticMode==='poc_v1'&&lastExecution?.type==='verification_goal'&&
      'kind'in lastExecution.assertion&&lastExecution.assertion.kind==='url';
    finalState=lastPocUrl?runtime.urlState().state:await runtime.state();
    const last=steps.at(-1);
    if(last?.status==='succeeded'&&last.effect?.kind==='generic_activation'&&last.afterStateStatus==='unavailable')
      current=finalState;
    if(!same(current,finalState))stop('STATE_CONTINUITY_MISMATCH');failedStepId=undefined;
  }catch(e){if(e instanceof DeferredViewerPreflightError&&e.cleanup==='unverified')cleanup='unverified';
    reason=cleanup==='unverified'?'CLEANUP_UNVERIFIED':e instanceof Stop?e.reason:'ENVIRONMENT_FAILURE';}
  finally{if(session)try{if(runtime&&finalState)await session.closeWithFinalCheck(async()=>{const lastExecution=artifact?.resolved.executionSteps.at(-1);
      const lastPocUrl=artifact?.trace.source.semanticMode==='poc_v1'&&lastExecution?.type==='verification_goal'&&
        'kind'in lastExecution.assertion&&lastExecution.assertion.kind==='url';
      const closing=lastPocUrl?runtime!.urlState(true).state:await runtime!.state(true);
      if(!same(finalState,closing))stop('STATE_CONTINUITY_MISMATCH');});else await session.close();}
    catch(e){if(e instanceof ProtectedFinalCheckError){reason=e.checkError instanceof Stop?e.checkError.reason:'STATE_CONTINUITY_MISMATCH';}else{cleanup='unverified';reason='CLEANUP_UNVERIFIED';}}}
  const r=artifact?.resolved,record=DeferredRunnerRecordV9Schema.parse({runnerVersion:'9',executionRunId,startedAt,finishedAt:new Date().toISOString(),
    ...(r?{provenance:{testSpecId:r.testSpecId,resolvedSpecId:r.resolvedSpecId,resolvedDigest:r.resolvedDigest,compilerAttemptId:r.compilerAttemptId,traceDigest:r.traceDigest,admissionDigest:r.admissionDigest,
      executionProfileRef:r.executionProfileRef,profileFingerprint:r.profileFingerprint,...(artifact?.trace.source.semanticMode==='poc_v1'?{semanticMode:'poc_v1' as const}:{}),
      ...(runtime?{sessionId:runtime.sessionId}:{})}}:{}),cleanup,steps,...(startState?{startState}:{}),...(finalState?{finalState}:{}),
    result:reason?{kind:'non_qa_stop',reasonCode:reason,...(failedStepId?{failedStepId}:{})}:{kind:'completed',assertions:steps.filter(s=>s.type==='verification_goal').length,passed:!steps.some(s=>s.status==='assertion_failed')},recordDigest:'0'.repeat(64)});
  const {recordDigest,...data}=record;return new TrustedDeferredRunV9(token,parseDeferredRunnerRecordV9({...data,recordDigest:hash(data)}));
}
