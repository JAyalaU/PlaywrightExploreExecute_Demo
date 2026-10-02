import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseResultRecordV2, ResultRecordV2Schema } from '../domain/agentic-result-v2.js';
import type { TrustedDeferredWorkflowStopV1 } from '../interpretation/deferred-action-production.js';
import { DeferredWorkflowPrivateAccountingV1Schema } from '../domain/deferred-workflow-accounting.js';
import { DeferredStartupDiagnosticV1Schema, type DeferredStartupDiagnosticV1 } from '../domain/deferred-startup-diagnostics.js';
import { DeferredVerificationDiagnosticV1Schema, type DeferredVerificationDiagnosticV1 } from '../domain/deferred-verification-diagnostic.js';

const namespace = 'deferred-workflow-stop-v1', id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const envelope = z.strictObject({ storageVersion: z.literal('1'), namespace: z.literal(namespace),
  testSpecId: id, result: ResultRecordV2Schema, accounting: DeferredWorkflowPrivateAccountingV1Schema, authentication: z.string().regex(/^[a-f0-9]{64}$/) });
const startupNamespace = 'deferred-startup-diagnostics-v1';
const verificationNamespace = 'deferred-verification-diagnostics-v1';
const verificationEnvelope = z.strictObject({ storageVersion: z.literal('1'), namespace: z.literal(verificationNamespace),
  testSpecId: id, explorationAttemptId: id, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostics: z.array(DeferredVerificationDiagnosticV1Schema).min(1).max(100),
  authentication: z.string().regex(/^[a-f0-9]{64}$/) });
const startupEnvelope = z.strictObject({ storageVersion: z.literal('1'), namespace: z.literal(startupNamespace),
  testSpecId: id, explorationAttemptId: id, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostics: z.array(DeferredStartupDiagnosticV1Schema).min(1).max(5), authentication: z.string().regex(/^[a-f0-9]{64}$/) });
async function regular(file: string, limit: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid workflow stop file');
  return readFile(file);
}
/** Early non-QA terminals have their own authenticated namespace; no fictitious replay capability. */
export class DeferredWorkflowStopStoreV1 {
  readonly #root: string; #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(directory: string, create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Workflow root symlink');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workflow path outside root');
    let checked = this.#root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) checked = path.join(checked, part);
      const info = await lstat(checked); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid workflow directory');
    }
  }
  async #authority() {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true); const file = path.join(this.#root, '.deferred-workflow-v1-authority');
      try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await regular(file, 32); if (key.length !== 32) throw new Error('Invalid workflow authority'); return key;
    })();
    return this.#key;
  }
  #file(testSpecId: string) { return path.join(this.#root, namespace, id.parse(testSpecId), 'terminal.json'); }
  #startupFile(testSpecId: string) { return path.join(this.#root, startupNamespace, id.parse(testSpecId), 'startup.json'); }
  #verificationFile(testSpecId: string) { return path.join(this.#root, verificationNamespace, id.parse(testSpecId), 'verification.json'); }
  /** Successful exploration diagnostics remain private and have no QA authority. */
  async writeVerificationDiagnostics(testSpecId: string, explorationAttemptId: string, profileFingerprint: string,
    diagnostics: readonly DeferredVerificationDiagnosticV1[]) {
    const data = { storageVersion: '1' as const, namespace: verificationNamespace, testSpecId, explorationAttemptId,
      profileFingerprint, diagnostics: structuredClone(diagnostics) };
    verificationEnvelope.omit({ authentication: true }).parse(data);
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#verificationFile(testSpecId); await this.#directory(path.dirname(file), true);
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close(); try { await link(temporary, file); } finally { await unlink(temporary); }
    return this.readVerificationDiagnostics(testSpecId, explorationAttemptId, profileFingerprint);
  }
  async readVerificationDiagnostics(testSpecId: string, explorationAttemptId: string, profileFingerprint: string) {
    const file = this.#verificationFile(testSpecId); await this.#directory(path.dirname(file), false);
    const { authentication, ...data } = verificationEnvelope.parse(JSON.parse((await regular(file, 256 * 1024)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(authentication, 'hex')) || data.testSpecId !== testSpecId ||
      data.explorationAttemptId !== explorationAttemptId || data.profileFingerprint !== profileFingerprint)
      throw new Error('Verification diagnostic authentication mismatch');
    return data.diagnostics;
  }
  /** Successful runs have no stop envelope. This record grants no execution or QA authority. */
  async writeStartupDiagnostics(testSpecId: string, explorationAttemptId: string, profileFingerprint: string,
    diagnostics: readonly DeferredStartupDiagnosticV1[]) {
    const data = { storageVersion: '1' as const, namespace: startupNamespace, testSpecId, explorationAttemptId,
      profileFingerprint, diagnostics: structuredClone(diagnostics) };
    startupEnvelope.omit({ authentication: true }).parse(data);
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#startupFile(testSpecId); await this.#directory(path.dirname(file), true);
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close(); try { await link(temporary, file); } finally { await unlink(temporary); }
    return this.readStartupDiagnostics(testSpecId, explorationAttemptId, profileFingerprint);
  }
  async readStartupDiagnostics(testSpecId: string, explorationAttemptId: string, profileFingerprint: string) {
    const file = this.#startupFile(testSpecId); await this.#directory(path.dirname(file), false);
    const { authentication, ...data } = startupEnvelope.parse(JSON.parse((await regular(file, 64 * 1024)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(authentication, 'hex')) || data.testSpecId !== testSpecId ||
      data.explorationAttemptId !== explorationAttemptId || data.profileFingerprint !== profileFingerprint)
      throw new Error('Startup diagnostic authentication mismatch');
    return data.diagnostics;
  }
  async writeStop(input: TrustedDeferredWorkflowStopV1) {
    const { requireTrustedDeferredWorkflowStopV1, requireTrustedDeferredWorkflowStopAccountingV1 } = await import('../interpretation/deferred-action-production.js');
    const result = requireTrustedDeferredWorkflowStopV1(input);
    if (!result.deferredStage || result.deferredReplay) throw new Error('Pre-replay stop authority required');
    const data = { storageVersion: '1' as const, namespace, testSpecId: result.testSpecId, result,
      accounting: requireTrustedDeferredWorkflowStopAccountingV1(input) };
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = this.#file(result.testSpecId); await this.#directory(path.dirname(file), true);
    const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close(); try { await link(temporary, file); } finally { await unlink(temporary); }
    return this.readStop(result.testSpecId);
  }
  async readStop(testSpecId: string) {
    return (await this.#read(testSpecId)).result;
  }
  /** Restricted audit only. This never issues successful evidence or a replay readback. */
  async readPrivateAccounting(testSpecId: string) {
    return (await this.#read(testSpecId)).accounting;
  }
  async #read(testSpecId: string) {
    const file = this.#file(testSpecId); await this.#directory(path.dirname(file), false);
    const { authentication, ...data } = envelope.parse(JSON.parse((await regular(file, 16 * 1024 * 1024)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(authentication, 'hex')) || data.testSpecId !== testSpecId ||
      data.result.testSpecId !== testSpecId || !data.result.deferredStage || data.result.deferredReplay)
      throw new Error('Workflow terminal authentication mismatch');
    return { result: parseResultRecordV2(data.result), accounting: DeferredWorkflowPrivateAccountingV1Schema.parse(data.accounting) };
  }
}
