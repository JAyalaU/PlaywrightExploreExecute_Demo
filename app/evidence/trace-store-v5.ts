import { parseProtectedTraceCaptureBundleV5, type ProtectedTraceCaptureBundleV5 } from '../domain/trace-capture-v5.js';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AssembledSuccessfulTraceV5 } from '../exploration/trace-assembly-v5.js';
import { type SuccessfulExplorationTraceV5 } from '../domain/agentic-trace-v5.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const namespace = 'deferred-successful-trace-v5';
const StoredV5Schema = z.strictObject({ storageVersion: z.literal('5'), namespace: z.literal(namespace),
  testSpecId: id, explorationAttemptId: id, successfulTraceId: id,
  artifact: z.strictObject({ trace: z.unknown(), capture: z.unknown() }), authentication: digest });
const issued = new WeakSet<object>(), readbackToken = Symbol('authenticated-trace-v5');
export class TrustedSuccessfulTraceReadbackV5 {
  readonly #artifact;
  constructor(token: symbol, artifact: { trace: SuccessfulExplorationTraceV5; capture: ProtectedTraceCaptureBundleV5 }) {
    if (token !== readbackToken) throw new Error('Authenticated v5 store provenance required');
    this.#artifact = structuredClone(artifact); issued.add(this);
  }
  protectedArtifact() { return structuredClone(this.#artifact); }
}
/** Separate durable provenance; never recreates WP1 admission or WP2 runtime capabilities. */
export function requireTrustedSuccessfulTraceReadbackV5(value: TrustedSuccessfulTraceReadbackV5) {
  if (!issued.has(value)) throw new Error('Untrusted v5 stored provenance');
  return TrustedSuccessfulTraceReadbackV5.prototype.protectedArtifact.call(value);
}

async function regularFile(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid v5 restricted file');
  // The host-owned restricted root/key are the durable trust boundary, not attacker-writable files.
  return readFile(file);
}
async function createImmutable(file: string, contents: Buffer): Promise<void> {
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file); } finally { await unlink(temporary); }
}

/** Isolated restricted namespace. No old job/source reader, compiler, report or production route. */
export class SuccessfulTraceV5Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(this.#root);
    if (path.relative(this.#root, resolvedRoot) !== '') throw new Error('V5 root cannot contain symbolic links');
    let checked = this.#root;
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('V5 path outside restricted root');
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid v5 restricted namespace');
    }
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.trace-v5-authority');
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regularFile(file, 32);
      if (key.length !== 32) throw new Error('Invalid v5 store authority');
      return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string, attemptId: string): string {
    return path.join(this.#root, namespace, id.parse(testSpecId), `${id.parse(attemptId)}.json`);
  }
  async writeSuccessfulExplorationV5(value: AssembledSuccessfulTraceV5): Promise<TrustedSuccessfulTraceReadbackV5> {
    const { requireAssembledSuccessfulTraceV5 } = await import('../exploration/trace-assembly-v5.js');
    const raw = requireAssembledSuccessfulTraceV5(value);
    const artifact = parseProtectedTraceCaptureBundleV5(raw.capture, raw.trace);
    const key = await this.#authority(), trace = artifact.trace;
    const data = { storageVersion: '5' as const, namespace, testSpecId: trace.testSpecId,
      explorationAttemptId: trace.explorationAttemptId, successfulTraceId: trace.successfulTraceId, artifact };
    const authentication = createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(trace.testSpecId, trace.explorationAttemptId);
    await this.#directory(path.dirname(file), true);
    await createImmutable(file, Buffer.from(JSON.stringify({ ...data, authentication }), 'utf8'));
    return this.readSuccessfulExplorationV5(trace.testSpecId, trace.explorationAttemptId);
  }
  async readSuccessfulExplorationV5(testSpecId: string, attemptId: string): Promise<TrustedSuccessfulTraceReadbackV5> {
    const file = this.#file(testSpecId, attemptId);
    await this.#directory(path.dirname(file), false);
    const record = StoredV5Schema.parse(JSON.parse((await regularFile(file, 32 * 1024 * 1024)).toString('utf8')));
    const { authentication, ...data } = record;
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected)) throw new Error('V5 stored provenance authentication mismatch');
    const artifact = parseProtectedTraceCaptureBundleV5(record.artifact.capture, record.artifact.trace);
    if (record.testSpecId !== testSpecId || record.explorationAttemptId !== attemptId ||
      artifact.trace.testSpecId !== testSpecId || artifact.trace.explorationAttemptId !== attemptId ||
      artifact.trace.successfulTraceId !== record.successfulTraceId) throw new Error('V5 immutable namespace owner mismatch');
    return new TrustedSuccessfulTraceReadbackV5(readbackToken, artifact);
  }
}
