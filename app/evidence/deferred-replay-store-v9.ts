import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { TrustedDeferredReplayV1 } from '../interpretation/deferred-action-replay.js';
import { requireTrustedResolvedTestReadbackV9, type TrustedResolvedTestReadbackV9 } from './deferred-compiler-store-v4.js';
import { parseDeferredReplayRecordV1, deferredResultRecordV2, type DeferredReplayRecordV1 } from '../domain/deferred-action-replay.js';
import { parseResultRecordV2, type ResultRecordV2 } from '../domain/agentic-result-v2.js';
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const namespace = 'deferred-replay-v9-result-v2';
const schema = z.strictObject({ storageVersion: z.literal('1'), namespace: z.literal(namespace),
  testSpecId: id, orchestrationId: id, resolvedDigest: digest, record: z.unknown(), result: z.unknown(), authentication: digest });
const issued = new WeakSet<object>(), authority = Symbol('authenticated-deferred-result');
export class TrustedDeferredReplayReadbackV1 {
  readonly #artifact: { record: DeferredReplayRecordV1; result: ResultRecordV2 };
  constructor(token: symbol, artifact: { record: DeferredReplayRecordV1; result: ResultRecordV2 }) {
    if (token !== authority) throw new Error('Authenticated deferred replay origin required');
    this.#artifact = structuredClone(artifact); issued.add(this);
  }
  protectedArtifact() { return structuredClone(this.#artifact); }
}
export function requireTrustedDeferredReplayReadbackV1(input: TrustedDeferredReplayReadbackV1) {
  if (!issued.has(input)) throw new Error('Untrusted deferred replay readback');
  return TrustedDeferredReplayReadbackV1.prototype.protectedArtifact.call(input);
}
async function regular(file: string, limit: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid deferred replay file');
  return readFile(file);
}
/** Immutable private pair/result storage. HMAC keys stay in the reviewed trusted-host root. */
export class DeferredReplayV9Store {
  readonly #root: string; #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Deferred replay root symlink');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Deferred replay path outside root');
    let checked = this.#root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid deferred replay directory');
    }
  }
  async #authority() {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true); const file = path.join(this.#root, '.deferred-replay-v9-authority');
      try { const h = await open(file, 'wx', 0o600); try { await h.writeFile(randomBytes(32)); await h.sync(); } finally { await h.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regular(file, 32); if (key.length !== 32) throw new Error('Invalid deferred replay authority'); return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string, pairId: string) { return path.join(this.#root, namespace, id.parse(testSpecId), `${id.parse(pairId)}.json`); }
  async writeReplayV1(input: TrustedDeferredReplayV1, resolvedInput: TrustedResolvedTestReadbackV9): Promise<TrustedDeferredReplayReadbackV1> {
    const { requireTrustedDeferredReplayV1 } = await import('../interpretation/deferred-action-replay.js');
    const artifact = requireTrustedResolvedTestReadbackV9(resolvedInput), record = parseDeferredReplayRecordV1(requireTrustedDeferredReplayV1(input), artifact);
    const result = deferredResultRecordV2(record, artifact), data = { storageVersion: '1' as const, namespace,
      testSpecId: artifact.resolved.testSpecId, orchestrationId: record.orchestrationId, resolvedDigest: artifact.resolved.resolvedDigest, record, result };
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(data.testSpecId, data.orchestrationId); await this.#directory(path.dirname(file), true);
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close();
    try { await link(temporary, file); } finally { await unlink(temporary); }
    return this.readReplayV1(data.testSpecId, data.orchestrationId, resolvedInput);
  }
  async readReplayV1(testSpecId: string, pairId: string, input: TrustedResolvedTestReadbackV9): Promise<TrustedDeferredReplayReadbackV1> {
    const artifact = requireTrustedResolvedTestReadbackV9(input), file = this.#file(testSpecId, pairId);
    await this.#directory(path.dirname(file), false);
    const envelope = schema.parse(JSON.parse((await regular(file, 16 * 1024 * 1024)).toString('utf8'))), { authentication, ...data } = envelope;
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected) || data.testSpecId !== testSpecId || data.orchestrationId !== pairId ||
      data.resolvedDigest !== artifact.resolved.resolvedDigest || artifact.resolved.testSpecId !== testSpecId) throw new Error('Deferred replay authenticated owner mismatch');
    const record = parseDeferredReplayRecordV1(data.record, artifact), result = parseResultRecordV2(data.result);
    if (record.orchestrationId !== pairId || JSON.stringify(result) !== JSON.stringify(deferredResultRecordV2(record, artifact))) throw new Error('Deferred replay terminal mismatch');
    return new TrustedDeferredReplayReadbackV1(authority, { record, result });
  }
}
