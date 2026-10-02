import { randomUUID } from 'node:crypto';
import { selectors,type Page,type Frame,type Locator,type ElementHandle } from '@playwright/test';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { NativeOptionFactSchema,NativeOptionProofSchema,type NativeOptionAssertionV2 } from '../domain/native-option-verification.js';
import { readOwnedLabelSourcesFromLocator,readNativeLabelOwnership } from './label-association.js';
import { z } from 'zod';
import {nativeOptionEngine,nativeOptionFactsEngine,nativeFactsSchema} from './native-option-facts.js';

const facts=z.strictObject({native:z.boolean(),multiple:z.boolean(),options:z.array(NativeOptionFactSchema).max(80)});
const engines=Promise.all([
 selectors.register('verification_v2_native_options',()=>{const read=(root:Node)=>{if(!(root instanceof HTMLElement)||!root.isConnected)return null;const carrier=root.ownerDocument.createElement('span');
  carrier.textContent=JSON.stringify({native:root instanceof HTMLSelectElement,multiple:root instanceof HTMLSelectElement&&root.multiple,options:[]});return carrier;};return{query:read,queryAll(root:Node){const e=read(root);return e?[e]:[];}};},{contentScript:true}),
 selectors.register('verification_v2_option_handles',()=>({query(root:Node){return root instanceof HTMLSelectElement?root.options.item(0):null;},queryAll(root:Node){return root instanceof HTMLSelectElement?Array.from(root.options).slice(0,81):[];}}),{contentScript:true})]);
export class NativeOptionReadError extends Error{constructor(readonly reason:'NO_MATCH'|'NON_UNIQUE'|'OPTION_ABSENT'|'OPTION_NON_UNIQUE'|'VALUE_NON_UNIQUE'|'RESULT_LIMIT'|'UNSUPPORTED_CONTROL'|'UNPROVEN_FRAME'|'STALE_STATE'|'QUERY_UNEVALUABLE'){super(reason);}}
function stop(r:NativeOptionReadError['reason']):never{throw new NativeOptionReadError(r);}
const identical=async(a:ElementHandle,b:ElementHandle)=>a.evaluate((node,old)=>node===old,b);
async function ownedLabels(...args:Parameters<typeof readOwnedLabelSourcesFromLocator>){try{return await readOwnedLabelSourcesFromLocator(...args);}catch(e){const message=e instanceof Error?e.message:'';stop(message==='LABEL_RESULT_LIMIT'?'RESULT_LIMIT':message==='LABEL_STALE_STATE'?'STALE_STATE':'UNSUPPORTED_CONTROL');}}
type Candidate={frame:Frame;locator:Locator;handle:ElementHandle;role:'combobox'|'listbox'};
type Read={all:Candidate[];target:Candidate;labels:ElementHandle[];options:ElementHandle[];value:z.infer<typeof NativeOptionProofSchema>};
/** Optional restricted diagnostic side channel; it has no effect on native proof. */
export type NativeOptionReadDiagnostic={ownerCandidateCount?:number;ownerRole?:'combobox'|'listbox';optionCandidateCount?:number;optionSelected?:boolean;unresolvedConstraint?:string};
async function framePath(page:Page,frame:Frame):Promise<z.infer<typeof NativeOptionProofSchema>['frame']>{if(frame===page.mainFrame())return{kind:'main'};const anchors:Extract<z.infer<typeof NativeOptionProofSchema>['frame'],{kind:'nested'}>['anchors']=[];
 let child=frame;while(child!==page.mainFrame()){const parent=child.parentFrame();if(!parent||anchors.length>=8)stop('UNPROVEN_FRAME');const owner=await child.frameElement();try{let found:typeof anchors[number]|undefined;
 for(const kind of ['title','testId'] as const){const attribute=kind==='title'?'title':'data-testid',value=await owner.getAttribute(attribute);if(!value||value.length>512)continue;const siblings=parent!.locator('iframe'),count=await siblings.count();if(count>80)stop('RESULT_LIMIT');let matches=0,owned=false;
 for(let i=0;i<count;i++){if(await siblings.nth(i).getAttribute(attribute)!==value)continue;matches++;const h=await siblings.nth(i).elementHandle();try{owned ||= await h?.contentFrame()===child;}finally{await h?.dispose();}}
 if(matches===1&&owned){found={kind,value,exact:true};break;}}
 if(!found)stop('UNPROVEN_FRAME');anchors.unshift(found!);child=parent!;
 }finally{await owner.dispose();}}return{kind:'nested',anchors};}
const dispose=async(p:Read)=>{await Promise.allSettled([...p.all.map(c=>c.handle),...p.labels,...p.options].map(h=>h.dispose()));};
/** Fixed utility-world native reader. No action authority, source parsing or model locator language. */
export async function readNativeOwnedOptionState(page:Page,predicate:NativeOptionAssertionV2['controlPredicate'],optionLabel:string,
 state:()=>Promise<unknown>,bounded:()=>void,identity:(h:ElementHandle)=>Promise<string>,expectedFrame?:NativeOptionAssertionV2['frame'],compiledValue?:string,compiledLabelOwnershipDigest?:string,diagnostic?:NativeOptionReadDiagnostic):Promise<z.infer<typeof NativeOptionProofSchema>>{
 await Promise.all([engines,nativeOptionEngine,nativeOptionFactsEngine]);const before=await state();let first:Read|undefined,renewed:Read|undefined;
 const prove=async():Promise<Read>=>{const all:Candidate[]=[],labels:ElementHandle[]=[],options:ElementHandle[]=[];
 try{bounded();const frames=page.frames();if(frames.length>8)stop('RESULT_LIMIT');
 for(const frame of frames)for(const role of ['combobox','listbox'] as const){let locator=frame.getByRole(role,{includeHidden:true});
  for(const c of predicate.controlConstraints){if(c.kind==='role'&&c.text!==role){locator=locator.and(frame.getByRole(c.text as 'combobox',{includeHidden:true}));}if(c.kind==='name')locator=locator.and(frame.getByRole(role,{name:c.text,exact:true,includeHidden:true}));}
  const count=await locator.count();if(all.length+count>80)stop('RESULT_LIMIT');for(let i=0;i<count;i++){bounded();const current=locator.nth(i),handle=await current.elementHandle();if(!handle||await handle.ownerFrame()!==frame){await handle?.dispose();stop('STALE_STATE');}all.push({frame,locator:current,handle,role});}}
 let eligible=all;for(const c of predicate.controlConstraints.filter(c=>c.kind==='label')){const kept:Candidate[]=[];for(const candidate of eligible){const sources=await ownedLabels(candidate.frame,candidate.locator,c.text,candidate.role,bounded);if(sources.length)kept.push(candidate);await Promise.allSettled(sources.map(s=>s.handle.dispose()));}eligible=kept;if(!eligible.length&&diagnostic)diagnostic.unresolvedConstraint=`label:${c.text}`;}
 if(diagnostic){diagnostic.ownerCandidateCount=eligible.length;
  if(!eligible.length&&!diagnostic.unresolvedConstraint)diagnostic.unresolvedConstraint=
    predicate.controlConstraints.some(c=>c.kind==='role'||c.kind==='name')?'role_or_name':'owner_absent';}
 if(eligible.length!==1)stop(eligible.length?'NON_UNIQUE':'NO_MATCH');const target=eligible[0]!,frame=await framePath(page,target.frame);
 if(diagnostic)diagnostic.ownerRole=target.role;
 for(const c of predicate.controlConstraints.filter(c=>c.kind==='label')){const sources=await ownedLabels(target.frame,target.locator,c.text,target.role,bounded);if(!sources.length)stop('STALE_STATE');for(const source of sources){if(await Promise.all(labels.map(h=>identical(h,source.handle))).then(values=>values.some(Boolean)))await source.handle.dispose();else labels.push(source.handle);}}
 if(expectedFrame&&hash(frame)!==hash(expectedFrame))stop('UNPROVEN_FRAME');if(!await target.handle.isVisible())stop('UNSUPPORTED_CONTROL');
 const carrier=await target.handle.$('verification_v2_native_options=');let payload;try{payload=await carrier?.textContent();}finally{await carrier?.dispose();}
 if(!payload||payload==='overflow'||payload.length>262144)stop('RESULT_LIMIT');let f=facts.parse(JSON.parse(payload!));if(!f.native||f.multiple)stop('UNSUPPORTED_CONTROL');
 const sharedCarrier=await target.handle.$('wp2b_native_option_facts=');let sharedPayload;try{sharedPayload=await sharedCarrier?.textContent();}finally{await sharedCarrier?.dispose();}
 if(!sharedPayload||sharedPayload.length>262144)stop('RESULT_LIMIT');const shared=nativeFactsSchema.parse(JSON.parse(sharedPayload!));if(shared.status!=='complete')stop('RESULT_LIMIT');if(shared.count!==shared.options.length||shared.multiple)stop('UNSUPPORTED_CONTROL');f={native:true,multiple:false,options:shared.options.map(({displayedLabel,...o})=>({...o,label:displayedLabel}))};
 const matches=f.options.filter(o=>o.label===optionLabel);if(diagnostic){diagnostic.optionCandidateCount=matches.length;
  if(matches.length!==1)diagnostic.unresolvedConstraint='option_label';}
 if(!matches.length)stop('OPTION_ABSENT');if(matches.length!==1)stop('OPTION_NON_UNIQUE');const matched=matches[0]!;
 if(diagnostic)diagnostic.optionSelected=matched.selected;
 if(f.options.filter(o=>o.value===matched.value).length!==1)stop('VALUE_NON_UNIQUE');if(compiledValue!==undefined&&matched.value!==compiledValue)stop('VALUE_NON_UNIQUE');
 options.push(...await target.handle.$$('wp2b_native_options='));if(options.length!==f.options.length||options.length>80)stop('RESULT_LIMIT');for(const h of options)if(await h.ownerFrame()!==target.frame)stop('STALE_STATE');
 const ownership=predicate.controlConstraints.some(c=>c.kind==='label')?await readNativeLabelOwnership(target.handle):null,labelOwnershipDigest=hash(ownership);if(compiledLabelOwnershipDigest!==undefined&&compiledLabelOwnershipDigest!==labelOwnershipDigest)stop('STALE_STATE');
 const selectedOption=options[f.options.findIndex(o=>o.label===optionLabel)]!;
 const value=NativeOptionProofSchema.parse({kind:'native_owned_option_state',candidateComplete:true,candidateCount:1,optionsComplete:true,optionCount:f.options.length,labelMatchCount:1,valueMatchCount:1,predicate,frame,controlId:await identity(target.handle),optionId:await identity(selectedOption),labelSourceIds:await Promise.all(labels.map(identity)),labelOwnershipDigest,labelOwnership:ownership,options:f.options,optionLabel,optionValue:matched.value,selected:matched.selected});return{all,target,labels,options,value};
 }catch(e){await Promise.allSettled([...all.map(c=>c.handle),...labels,...options].map(h=>h.dispose()));throw e;}};
 try{first=await prove();renewed=await prove();bounded();if(hash(first.value)!==hash(renewed.value)||first.target.frame!==renewed.target.frame||first.all.length!==renewed.all.length||first.labels.length!==renewed.labels.length||first.options.length!==renewed.options.length)stop('STALE_STATE');
 for(const [a,b] of [[first.all.map(c=>c.handle),renewed.all.map(c=>c.handle)],[first.labels,renewed.labels],[first.options,renewed.options]])for(let i=0;i<a!.length;i++)if(!await identical(a![i]!,b![i]!))stop('STALE_STATE');
 if(hash(before)!==hash(await state()))stop('STALE_STATE');
 const finalCarrier=await renewed.target.handle.$('wp2b_native_option_facts=');let finalPayload;
 try{finalPayload=await finalCarrier?.textContent();}finally{await finalCarrier?.dispose();}
 if(!finalPayload||finalPayload.length>262144)stop('RESULT_LIMIT');const finalFacts=nativeFactsSchema.parse(JSON.parse(finalPayload));
 if(finalFacts.status!=='complete'||hash(finalFacts.options.map(({displayedLabel,...o})=>({label:displayedLabel,...o})))!==hash(renewed.value.options))stop('STALE_STATE');
 const finalHandles=await renewed.target.handle.$$('wp2b_native_options=');try{if(finalHandles.length!==renewed.options.length)stop('STALE_STATE');for(let i=0;i<finalHandles.length;i++)if(!await identical(finalHandles[i]!,renewed.options[i]!))stop('STALE_STATE');}finally{await Promise.allSettled(finalHandles.map(h=>h.dispose()));}
 bounded();if(!await renewed.target.handle.isVisible()||await renewed.target.handle.ownerFrame()!==renewed.target.frame)stop('STALE_STATE');if(hash(before)!==hash(await state()))stop('STALE_STATE');return first.value;
 }finally{if(first)await dispose(first);if(renewed)await dispose(renewed);}
}
/** One journal identity map per protected observer/replay; identical markup never inherits identity. */
export function nativeOptionIdentityJournal(){const records:{handle:ElementHandle;id:string}[]=[];return{async identify(handle:ElementHandle){for(const r of records)try{if(await identical(handle,r.handle))return r.id;}catch{}const copy=await handle.evaluateHandle(node=>node);const retained=copy.asElement();if(!retained){await copy.dispose();stop('STALE_STATE');}if(records.length>=8192){await retained.dispose();stop('RESULT_LIMIT');}const id=`native-node-${randomUUID()}`;records.push({handle:retained,id});return id;},async close(){await Promise.allSettled(records.map(r=>r.handle.dispose()));records.length=0;}};}
