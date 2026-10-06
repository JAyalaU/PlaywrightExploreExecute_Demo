import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { requireTrustedSemanticIntentAdmissionV3, type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { parseSemanticCompilerAttemptV5, parseSemanticGroundedTraceV1,
  parseSemanticResolvedTestSpecV10, requireIssuedSemanticGroundedTraceV1,
  type SemanticCompilerAttemptV5, type SemanticGroundedTraceV1,
  type SemanticResolvedTestSpecV10 } from '../domain/semantic-resolved-v10.js';
import { requireIssuedSemanticCompilationV5 } from '../exploration/semantic-trace-compiler-v5.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const namespace = 'semantic-compiler-v5-resolved-v10';
const envelope = z.strictObject({ storageVersion: z.literal('5'), namespace: z.literal(namespace),
  testSpecId: id, compilerAttemptId: id, traceDigest: digest, trace: z.unknown(),
  compiler: z.unknown(), resolved: z.unknown(), authentication: digest });
type Artifact = { admission: TrustedSemanticIntentAdmissionV3; trace: SemanticGroundedTraceV1;
  compiler: SemanticCompilerAttemptV5; resolved: SemanticResolvedTestSpecV10 };
const issued = new WeakSet<object>(), token = Symbol('semantic-resolved-v10-readback');
export class TrustedSemanticResolvedReadbackV10 {
  readonly #artifact: Artifact;
  constructor(authority: symbol, artifact: Artifact) {
    if (authority !== token) throw new Error('Authenticated v10 origin required');
    this.#artifact = { ...artifact, trace: structuredClone(artifact.trace),
      compiler: structuredClone(artifact.compiler), resolved: structuredClone(artifact.resolved) };
    issued.add(this);
  }
  protectedArtifact(): Artifact { return { ...this.#artifact, trace: structuredClone(this.#artifact.trace),
    compiler: structuredClone(this.#artifact.compiler), resolved: structuredClone(this.#artifact.resolved) }; }
}
export function requireTrustedSemanticResolvedReadbackV10(input: TrustedSemanticResolvedReadbackV10): Artifact {
  if (!issued.has(input)) throw new Error('UNAUTHENTICATED_SEMANTIC_V10_INPUT');
  const artifact = TrustedSemanticResolvedReadbackV10.prototype.protectedArtifact.call(input);
  requireTrustedSemanticIntentAdmissionV3(artifact.admission);
  const trace = parseSemanticGroundedTraceV1(artifact.trace, artifact.admission);
  const compiler = parseSemanticCompilerAttemptV5(artifact.compiler, trace);
  const resolved = parseSemanticResolvedTestSpecV10(artifact.resolved, trace);
  if (compiler.result.status !== 'accepted' || compiler.result.resolvedSpecId !== resolved.resolvedSpecId ||
    compiler.compilerAttemptId !== resolved.compilerAttemptId || compiler.cleanup !== 'verified' ||
    compiler.profileFingerprint !== resolved.profileFingerprint)
    throw new Error('INVALID_SEMANTIC_V10_HANDOFF');
  return { admission: artifact.admission, trace, compiler, resolved };
}
async function regular(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid semantic restricted file');
  return readFile(file);
}
/** Separate authenticated namespace. v9 readers cannot mint or parse v10 runner authority. */
export class SemanticCompilerV5Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Compiler root symlink');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Compiler path outside root');
    let checked = this.#root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid compiler directory');
    }
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.semantic-compiler-v5-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regular(file, 32);
      if (key.length !== 32) throw new Error('Invalid semantic compiler authority');
      return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string, attempt: string): string {
    return path.join(this.#root, namespace, id.parse(testSpecId), `${id.parse(attempt)}.json`);
  }
  async writeCompilationV5(compilation: { kind: 'compiled' | 'compilation_stop'; compiler: SemanticCompilerAttemptV5;
    resolved?: SemanticResolvedTestSpecV10 }, admission: TrustedSemanticIntentAdmissionV3,
  traceInput: SemanticGroundedTraceV1): Promise<TrustedSemanticResolvedReadbackV10> {
    requireIssuedSemanticCompilationV5(compilation);
    if (compilation.kind !== 'compiled' || !compilation.resolved) throw new Error('No accepted semantic v10 artifact');
    requireIssuedSemanticGroundedTraceV1(traceInput);
    requireTrustedSemanticIntentAdmissionV3(admission);
    const trace = parseSemanticGroundedTraceV1(traceInput, admission);
    const compiler = parseSemanticCompilerAttemptV5(compilation.compiler, trace);
    const resolved = parseSemanticResolvedTestSpecV10(compilation.resolved, trace);
    if (compiler.result.status !== 'accepted' || compiler.result.resolvedSpecId !== resolved.resolvedSpecId ||
      compiler.compilerAttemptId !== resolved.compilerAttemptId || compiler.cleanup !== 'verified' ||
      compiler.profileFingerprint !== resolved.profileFingerprint)
      throw new Error('INVALID_SEMANTIC_V10_HANDOFF');
    const data = { storageVersion: '5' as const, namespace, testSpecId: trace.testSpecId,
      compilerAttemptId: compiler.compilerAttemptId, traceDigest: trace.traceDigest, trace, compiler, resolved };
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(trace.testSpecId, compiler.compilerAttemptId);
    await this.#directory(path.dirname(file), true);
    const temp = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, file); } finally { await unlink(temp); }
    return this.readResolvedV10(trace.testSpecId, compiler.compilerAttemptId, admission);
  }
  async readResolvedV10(testSpecId: string, attempt: string,
    admission: TrustedSemanticIntentAdmissionV3): Promise<TrustedSemanticResolvedReadbackV10> {
    requireTrustedSemanticIntentAdmissionV3(admission);
    const file = this.#file(testSpecId, attempt);
    await this.#directory(path.dirname(file), false);
    const record = envelope.parse(JSON.parse((await regular(file, 32 * 1024 * 1024)).toString('utf8')));
    const { authentication, ...data } = record;
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected) || record.testSpecId !== testSpecId ||
      record.compilerAttemptId !== attempt) throw new Error('Semantic compiler authenticated owner mismatch');
    const trace = parseSemanticGroundedTraceV1(record.trace, admission);
    const compiler = parseSemanticCompilerAttemptV5(record.compiler, trace);
    const resolved = parseSemanticResolvedTestSpecV10(record.resolved, trace);
    const result = new TrustedSemanticResolvedReadbackV10(token, { admission, trace, compiler, resolved });
    requireTrustedSemanticResolvedReadbackV10(result);
    return result;
  }
}
