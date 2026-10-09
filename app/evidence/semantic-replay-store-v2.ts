import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseSemanticReplayPairV2, type SemanticReplayPairV2 } from '../domain/semantic-runner-v10.js';
import { requireTrustedSemanticResolvedReadbackV10,
  type TrustedSemanticResolvedReadbackV10 } from './semantic-compiler-store-v5.js';
import { requireTrustedSemanticReplayV2, validateSemanticReplayRunsV2,
  type TrustedSemanticReplayV2 } from '../interpretation/semantic-replay-v2.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const namespace = 'semantic-replay-v2-resolved-v10';
const envelope = z.strictObject({ storageVersion: z.literal('2'), namespace: z.literal(namespace),
  testSpecId: id, resolvedSpecId: id, orchestrationId: id, resolvedDigest: digest,
  replay: z.unknown(), authentication: digest });
const issued = new WeakSet<object>(), token = Symbol('semantic-replay-v2-readback');
export class TrustedSemanticReplayReadbackV2 {
  readonly #record: SemanticReplayPairV2;
  constructor(authority: symbol, record: SemanticReplayPairV2) {
    if (authority !== token) throw new Error('Authenticated semantic replay origin required');
    this.#record = structuredClone(record); issued.add(this);
  }
  protectedRecord(): SemanticReplayPairV2 { return structuredClone(this.#record); }
}
export function requireTrustedSemanticReplayReadbackV2(input: TrustedSemanticReplayReadbackV2): SemanticReplayPairV2 {
  if (!issued.has(input)) throw new Error('Unauthenticated semantic replay readback');
  return parseSemanticReplayPairV2(TrustedSemanticReplayReadbackV2.prototype.protectedRecord.call(input));
}
async function regular(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid semantic replay file');
  return readFile(file);
}
/** Authenticated semantic replay-pair storage with its own versioned lineage. */
export class SemanticReplayV2Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Semantic replay root symlink');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Semantic replay path outside root');
    let checked = this.#root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid semantic replay directory');
    }
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.semantic-replay-v2-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regular(file, 32);
      if (key.length !== 32) throw new Error('Invalid semantic replay authority');
      return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string, resolvedSpecId: string, orchestrationId: string): string {
    return path.join(this.#root, namespace, id.parse(testSpecId), id.parse(resolvedSpecId),
      `${id.parse(orchestrationId)}.json`);
  }
  async writeReplayV2(replay: TrustedSemanticReplayV2,
    readback: TrustedSemanticResolvedReadbackV10): Promise<TrustedSemanticReplayReadbackV2> {
    const artifact = requireTrustedSemanticResolvedReadbackV10(readback);
    const pair = parseSemanticReplayPairV2(requireTrustedSemanticReplayV2(replay));
    if (pair.resolvedSpecId !== artifact.resolved.resolvedSpecId ||
      pair.resolvedDigest !== artifact.resolved.resolvedDigest) throw new Error('Semantic replay owner mismatch');
    validateSemanticReplayRunsV2(pair.runs, artifact);
    const data = { storageVersion: '2' as const, namespace, testSpecId: artifact.resolved.testSpecId,
      resolvedSpecId: pair.resolvedSpecId, orchestrationId: pair.orchestrationId,
      resolvedDigest: pair.resolvedDigest, replay: pair };
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(data.testSpecId, data.resolvedSpecId, data.orchestrationId);
    await this.#directory(path.dirname(file), true);
    const temp = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, file); } finally { await unlink(temp); }
    return this.readReplayV2(data.testSpecId, data.resolvedSpecId, data.orchestrationId, readback);
  }
  async readReplayV2(testSpecId: string, resolvedSpecId: string, orchestrationId: string,
    readback: TrustedSemanticResolvedReadbackV10): Promise<TrustedSemanticReplayReadbackV2> {
    const artifact = requireTrustedSemanticResolvedReadbackV10(readback);
    const file = this.#file(testSpecId, resolvedSpecId, orchestrationId);
    await this.#directory(path.dirname(file), false);
    const record = envelope.parse(JSON.parse((await regular(file, 32 * 1024 * 1024)).toString('utf8')));
    const { authentication, ...data } = record;
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected) || record.testSpecId !== testSpecId ||
      record.resolvedSpecId !== resolvedSpecId || record.orchestrationId !== orchestrationId ||
      record.resolvedDigest !== artifact.resolved.resolvedDigest ||
      record.testSpecId !== artifact.resolved.testSpecId) throw new Error('Semantic replay authenticated owner mismatch');
    const pair = parseSemanticReplayPairV2(record.replay);
    validateSemanticReplayRunsV2(pair.runs, artifact);
    return new TrustedSemanticReplayReadbackV2(token, pair);
  }
}
