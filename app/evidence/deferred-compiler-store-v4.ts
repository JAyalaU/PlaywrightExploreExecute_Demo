import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdir,open,link,unlink,lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {TrustedDeferredCompilationV4} from '../exploration/deferred-trace-compiler-v4.js';
import {requireTrustedSuccessfulTraceReadbackV5,type TrustedSuccessfulTraceReadbackV5} from './trace-store-v5.js';
import {parseCompilerAttemptV4,parseResolvedTestSpecV9,type CompilerAttemptV4,type ResolvedTestSpecV9} from '../domain/deferred-action-compiler.js';
import type {SuccessfulExplorationTraceV5} from '../domain/agentic-trace-v5.js';

const id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128),digest=z.string().regex(/^[a-f0-9]{64}$/),namespace='deferred-compiler-v4-resolved-v9';
const envelope=z.strictObject({storageVersion:z.literal('4'),namespace:z.literal(namespace),testSpecId:id,compilerAttemptId:id,
  traceDigest:digest,compiler:z.unknown(),resolved:z.unknown().optional(),authentication:digest});
const issued=new WeakSet<object>(),token=Symbol('authenticated-resolved-v9');
/** Only authenticated accepted compiler artifacts grant runner input origin. */
export class TrustedResolvedTestReadbackV9 {
  readonly #artifact:{compiler:CompilerAttemptV4;resolved:ResolvedTestSpecV9;trace:SuccessfulExplorationTraceV5};
  constructor(authority:symbol,artifact:{compiler:CompilerAttemptV4;resolved:ResolvedTestSpecV9;trace:SuccessfulExplorationTraceV5}){
    if(authority!==token)throw new Error('Authenticated v9 store origin required');this.#artifact=structuredClone(artifact);issued.add(this);
  }
  protectedArtifact(){return structuredClone(this.#artifact);}
}
export function requireTrustedResolvedTestReadbackV9(input:TrustedResolvedTestReadbackV9){
  if(!issued.has(input))throw new Error('Untrusted v9 origin');return TrustedResolvedTestReadbackV9.prototype.protectedArtifact.call(input);
}
async function regular(file:string,limit:number){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new Error('Invalid compiler restricted file');return readFile(file);}
/** Separate immutable namespace and authority key; old stores cannot read or mint this family. */
export class DeferredCompilerV4Store {
  readonly #root:string;#key:Promise<Buffer>|undefined;
  constructor(root:string){this.#root=path.resolve(root);}
  async #directory(directory:string,create:boolean){
    if(create)await mkdir(directory,{recursive:true,mode:0o700});
    if(path.relative(this.#root,await realpath(this.#root))!=='')throw new Error('Compiler root symlink');
    const relative=path.relative(this.#root,directory);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Compiler path outside root');
    let checked=this.#root;for(const segment of ['',...relative.split(path.sep).filter(Boolean)]){if(segment)checked=path.join(checked,segment);const info=await lstat(checked);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid compiler directory');}
  }
  async #authority(){this.#key??=(async()=>{await this.#directory(this.#root,true);const file=path.join(this.#root,'.deferred-compiler-v4-authority');
    try{const h=await open(file,'wx',0o600);try{await h.writeFile(randomBytes(32));await h.sync();}finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    const key=await regular(file,32);if(key.length!==32)throw new Error('Invalid compiler authority');return key;})();return this.#key;}
  #file(testSpecId:string,attempt:string){return path.join(this.#root,namespace,id.parse(testSpecId),`${id.parse(attempt)}.json`);}
  async writeCompilationV4(input:TrustedDeferredCompilationV4,readback:TrustedSuccessfulTraceReadbackV5):Promise<TrustedResolvedTestReadbackV9|undefined>{
    const {requireTrustedDeferredCompilationV4}=await import('../exploration/deferred-trace-compiler-v4.js');
    const artifact=requireTrustedDeferredCompilationV4(input),{trace}=requireTrustedSuccessfulTraceReadbackV5(readback);
    const compiler=parseCompilerAttemptV4(artifact.compiler,trace),resolved=artifact.resolved&&parseResolvedTestSpecV9(artifact.resolved,trace,compiler);
    if((compiler.result.status==='accepted')!==!!resolved)throw new Error('Rejected compilation cannot contain resolved artifact');
    const data={storageVersion:'4' as const,namespace,testSpecId:compiler.testSpecId,compilerAttemptId:compiler.compilerAttemptId,traceDigest:trace.traceDigest,compiler,...(resolved?{resolved}:{})};
    const authentication=createHmac('sha256',await this.#authority()).update(JSON.stringify(data)).digest('hex'),file=this.#file(compiler.testSpecId,compiler.compilerAttemptId);
    await this.#directory(path.dirname(file),true);
    const temp=path.join(path.dirname(file),`.pending-${randomUUID()}`),handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({...data,authentication}));await handle.sync();}finally{await handle.close();}
    try{await link(temp,file);}finally{await unlink(temp);}
    return resolved?this.readResolvedV9(compiler.testSpecId,compiler.compilerAttemptId,readback):undefined;
  }
  async readCompilerAttemptV4(testSpecId:string,attempt:string,readback:TrustedSuccessfulTraceReadbackV5){return(await this.#read(testSpecId,attempt,readback)).compiler;}
  async #read(testSpecId:string,attempt:string,readback:TrustedSuccessfulTraceReadbackV5){
    const {trace}=requireTrustedSuccessfulTraceReadbackV5(readback),file=this.#file(testSpecId,attempt);await this.#directory(path.dirname(file),false);
    const record=envelope.parse(JSON.parse((await regular(file,32*1024*1024)).toString('utf8'))),{authentication,...data}=record;
    const expected=createHmac('sha256',await this.#authority()).update(JSON.stringify(data)).digest();
    if(!timingSafeEqual(Buffer.from(authentication,'hex'),expected)||record.testSpecId!==testSpecId||record.compilerAttemptId!==attempt||record.traceDigest!==trace.traceDigest)throw new Error('Compiler authenticated owner mismatch');
    const compiler=parseCompilerAttemptV4(record.compiler,trace),resolved=record.resolved===undefined?undefined:parseResolvedTestSpecV9(record.resolved,trace,compiler);
    if(compiler.testSpecId!==testSpecId||compiler.compilerAttemptId!==attempt||(compiler.result.status==='accepted')!==!!resolved)throw new Error('Compiler namespace linkage mismatch');
    return{compiler,resolved,trace};
  }
  async readResolvedV9(testSpecId:string,attempt:string,readback:TrustedSuccessfulTraceReadbackV5){
    const artifact=await this.#read(testSpecId,attempt,readback);if(!artifact.resolved||artifact.compiler.result.status!=='accepted')throw new Error('No accepted v9 artifact');
    return new TrustedResolvedTestReadbackV9(token,{...artifact,resolved:artifact.resolved});
  }
}
