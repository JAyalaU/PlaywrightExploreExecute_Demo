import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildActionObligationHandoffV2, requireTrustedSemanticAdmissionV2,
  type TrustedSemanticAdmissionV2 } from '../domain/action-semantic-admission.js';
import { DeferredInterpretationTimingV1Schema, type DeferredInterpretationTimingV1 } from '../domain/deferred-interpretation-timing.js';

const namespace = 'deferred-interpretation-attempt-v1';
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z.strictObject({ storageVersion: z.literal('1'), namespace: z.literal(namespace),
  testSpecId: id, sourceDigest: digest, admissionDigest: digest, profileFingerprint: digest,
  timing: DeferredInterpretationTimingV1Schema, authentication: digest });

async function regular(file: string, limit: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid interpretation attempt file');
  return readFile(file);
}

/** Diagnostic-only immutable record. Authenticated readback grants no semantic or replay authority. */
export class DeferredInterpretationAttemptStoreV1 {
  readonly #root: string; #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Interpretation root symlink');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Interpretation path outside root');
    let checked = this.#root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) checked = path.join(checked, part);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid interpretation directory');
    }
  }
  async #authority() {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.deferred-interpretation-attempt-v1-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regular(file, 32);
      if (key.length !== 32) throw new Error('Invalid interpretation authority');
      return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string) { return path.join(this.#root, namespace, id.parse(testSpecId), 'attempts.json'); }
  async writeAcceptedRetry(admission: TrustedSemanticAdmissionV2, timingInput: DeferredInterpretationTimingV1,
    profileFingerprint: string): Promise<DeferredInterpretationTimingV1> {
    requireTrustedSemanticAdmissionV2(admission);
    const handoff = buildActionObligationHandoffV2(admission), timing = DeferredInterpretationTimingV1Schema.parse(timingInput);
    if (timing.phase !== 'admission' || !timing.attempts?.some(item => item.attempt === 2) ||
      timing.attempts.at(-1)?.outcome !== 'valid_extraction') throw new Error('Successful retry accounting required');
    const data = { storageVersion: '1' as const, namespace, testSpecId: admission.spec.testSpecId,
      sourceDigest: handoff.sourceDigest, admissionDigest: handoff.admissionDigest,
      profileFingerprint: digest.parse(profileFingerprint), timing };
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(data.testSpecId);
    await this.#directory(path.dirname(file), true);
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close();
    try { await link(temporary, file); } finally { await unlink(temporary); }
    return this.readPrivateAttempts(data.testSpecId, data.sourceDigest, data.admissionDigest, data.profileFingerprint);
  }
  async readPrivateAttempts(testSpecId: string, sourceDigest: string, admissionDigest: string,
    profileFingerprint: string): Promise<DeferredInterpretationTimingV1> {
    const file = this.#file(testSpecId);
    await this.#directory(path.dirname(file), false);
    const { authentication, ...data } = envelope.parse(JSON.parse((await regular(file, 64 * 1024)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected) || data.testSpecId !== testSpecId ||
      data.sourceDigest !== sourceDigest || data.admissionDigest !== admissionDigest ||
      data.profileFingerprint !== profileFingerprint) throw new Error('Interpretation attempt authentication mismatch');
    return DeferredInterpretationTimingV1Schema.parse(data.timing);
  }
}
