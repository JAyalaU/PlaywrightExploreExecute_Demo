import { z } from 'zod';
import { NativeOptionComparisonV2Schema } from '../domain/native-option-verification.js';
const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const NativeOptionDecisionV6Schema=z.discriminatedUnion('kind',[
 z.strictObject({decisionVersion:z.literal('6'),kind:z.literal('observe'),request:z.strictObject({kind:z.literal('native_owned_option_state'),goalStepId:id,admissionDigest:digest,claimDigest:digest})}),
 z.strictObject({decisionVersion:z.literal('6'),kind:z.literal('conclude'),conclusion:z.enum(['satisfied','unsatisfied','unresolved','unsupported']),comparison:NativeOptionComparisonV2Schema.nullable()})]);
export const NativeOptionDecisionWireSchema=z.strictObject({response:NativeOptionDecisionV6Schema});
function providerSchema(value:unknown):unknown{if(Array.isArray(value))return value.map(providerSchema);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='$schema').map(([k,v])=>k==='const'?['enum',[v]]:[k==='oneOf'?'anyOf':k,providerSchema(v)]));}
export const NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT=Object.freeze({type:'json_schema' as const,name:'agentic_native_option_verification_decision_v6',strict:true as const,schema:providerSchema(z.toJSONSchema(NativeOptionDecisionWireSchema,{target:'draft-7',io:'input'}))});

export const normalizeNativeOptionDecisionWire=(input:unknown)=>JSON.stringify(NativeOptionDecisionWireSchema.parse(input).response);
