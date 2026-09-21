import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, link, unlink, readFile, readdir, stat, lstat, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  SCHEMA_VERSION, ExecutionProfileRefSchema, TestSpecSchema, parseResultRecord, parseResolvedTestSpec,
  parseTestSpec, type ResolvedTestSpec, type ResultRecord, type TestSpec,
} from '../domain/index.js';
import { ExecutionProfileSchema, NetworkPolicySchema, ProfileCatalog, assertEquivalentEffectiveProfile, type EffectiveProfile } from '../profile/index.js';
import type { ExecutionRun } from '../runner/index.js';
import { EvidenceRedactor } from './redact.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const time = z.iso.datetime();
const attemptStatus = z.enum(['resolved', 'ambiguous', 'unresolved']);

export const ExplorationAttemptSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), testSpecId: id, explorationAttemptId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeVersions: z.strictObject({ node: z.string().min(1), playwright: z.string().min(1), browser: z.string().min(1), mcp: z.string().min(1) }),
  status: attemptStatus,
  startedAt: time, finishedAt: time,
  results: z.array(z.unknown()), evidenceRefs: z.array(z.string()),
});
export type ExplorationAttempt = Omit<z.infer<typeof ExplorationAttemptSchema>, 'results'> & { results: ResultRecord[] };

export const EvidenceDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), evidenceId: id, testSpecId: id,
  owner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('attempt'), id }),
    z.strictObject({ kind: z.literal('run'), id }),
  ]),
  originStepId: id.optional(), executionStepId: id.optional(), locatorId: id.optional(),
  mediaType: z.enum(['application/json', 'text/plain', 'image/png', 'application/zip', 'video/webm']),
  sensitivity: z.enum(['redacted', 'restricted']),
  capturedAt: time, byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), ref: z.string(),
});
export type EvidenceDescriptor = z.infer<typeof EvidenceDescriptorSchema>;

/** A deployment-owned authorization boundary for raw screenshots, traces, and video. */
export interface RestrictedEvidenceAccess {
  authorize(descriptor: EvidenceDescriptor): Promise<void>;
}

export const StoredRunSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), testSpecId: id, resolvedSpecId: id,
  explorationAttemptId: id, executionRunId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  versions: z.strictObject({ node: z.string(), playwright: z.string(), browser: z.string() }),
  outcomes: z.array(z.unknown()),
});
export type StoredRun = Omit<z.infer<typeof StoredRunSchema>, 'outcomes'> & { outcomes: ResultRecord[] };

export const InterpretationRecordSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), testSpecId: id,
  sourceInstruction: z.string(),
  executionProfileRef: ExecutionProfileRefSchema,
  startState: TestSpecSchema.shape.startState,
  outcome: z.enum(['accepted', 'rejected']),
  result: z.unknown(), explanation: z.string().optional(),
});
export type InterpretationRecord = Omit<z.infer<typeof InterpretationRecordSchema>, 'result'> & { result: ResultRecord };

function validatedInterpretation(input: unknown): InterpretationRecord {
  const record = InterpretationRecordSchema.parse(input);
  const result = parseResultRecord(record.result);
  if (result.phase !== 'interpretation' || result.testSpecId !== record.testSpecId ||
    (record.outcome === 'accepted' ? result.status !== 'OPERATION_SUCCEEDED' :
      result.status !== 'INTERPRETATION_FAILED' && result.status !== 'AMBIGUOUS_INSTRUCTION' &&
      result.status !== 'TEST_BUILD_FAILED')) {
    throw new Error('Interpretation result correlation failure');
  }
  return { ...record, result };
}

const JobManifestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), testSpecId: id, createdAt: time,
  expiresAt: time,
  executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

const extensions: Record<EvidenceDescriptor['mediaType'], string> = {
  'application/json': 'json', 'text/plain': 'txt', 'image/png': 'png',
  'application/zip': 'zip', 'video/webm': 'webm',
};

async function atomicCreate(file: string, content: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, file); }
  finally { await unlink(temporary); }
}

function bytes(value: unknown): Uint8Array { return Buffer.from(JSON.stringify(value, null, 2), 'utf8'); }
async function readJson(file: string): Promise<unknown> { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export class LocalArtifactStore {
  readonly #root: string;
  readonly #redactor: EvidenceRedactor;
  readonly #restrictedAccess: RestrictedEvidenceAccess | undefined;

  constructor(root: string, redactor = new EvidenceRedactor(), readonly retentionDays = 7,
    restrictedAccess?: RestrictedEvidenceAccess) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error('Invalid retention days');
    this.#root = path.resolve(root);
    this.#redactor = redactor;
    this.#restrictedAccess = restrictedAccess;
  }

  #job(testSpecId: string): string { return path.join(this.#root, id.parse(testSpecId)); }
  #file(testSpecId: string, ...parts: string[]): string {
    for (const part of parts) if (part === '.' || part === '..' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(part)) throw new Error('Invalid artifact path segment');
    return path.join(this.#job(testSpecId), ...parts);
  }
  async #createJson(file: string, value: unknown): Promise<void> { await atomicCreate(file, bytes(value)); }

  async #privateRoot(create = false): Promise<void> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('Artifact root must be a private directory');
    }
  }

  /** Interpretation may fail before a valid TestSpec or job exists. */
  async writeInterpretation(input: unknown): Promise<InterpretationRecord> {
    const record = validatedInterpretation(input);
    const result = record.result;
    const saved = { ...record, ...this.#redactor.value({
      sourceInstruction: record.sourceInstruction, result, explanation: record.explanation,
    }) as Pick<InterpretationRecord, 'sourceInstruction' | 'result' | 'explanation'> };
    await this.#privateRoot(true);
    await this.#createJson(path.join(this.#root, '.interpretations', `${id.parse(record.testSpecId)}.json`), saved);
    return saved;
  }

  async readInterpretation(testSpecId: string): Promise<InterpretationRecord> {
    await this.#privateRoot();
    const file = path.join(this.#root, '.interpretations', `${id.parse(testSpecId)}.json`);
    if (Date.now() >= (await stat(file)).mtimeMs + this.retentionDays * 86_400_000) {
      throw new Error('Interpretation retention expired');
    }
    const record = validatedInterpretation(await readJson(file));
    if (record.testSpecId !== testSpecId) throw new Error('Interpretation result correlation failure');
    return record;
  }

  async createJob(sourceInput: unknown, profile: EffectiveProfile): Promise<void> {
    const source = parseTestSpec(sourceInput);
    if (!same(source.executionProfileRef, { id: profile.profile.id, version: profile.profile.version })) throw new Error('Job profile differs from TestSpec');
    ExecutionProfileSchema.parse(profile.profile);
    NetworkPolicySchema.parse(profile.policy);
    assertEquivalentEffectiveProfile(new ProfileCatalog([profile.profile], [profile.policy]).resolve(source.executionProfileRef), profile);
    this.#redactor.assertSafeContract(source);
    this.#redactor.assertSafeContract(profile.profile);
    const manifest = JobManifestSchema.parse({
      schemaVersion: SCHEMA_VERSION, testSpecId: source.testSpecId, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.retentionDays * 86_400_000).toISOString(),
      executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
    });
    await this.#privateRoot(true);
    const temporary = path.join(this.#root, `.pending-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await this.#createJson(path.join(temporary, 'manifest.json'), manifest);
      await this.#createJson(path.join(temporary, 'test-spec.json'), source);
      await this.#createJson(path.join(temporary, 'profile.json'), { profile: profile.profile, policy: profile.policy, fingerprint: profile.fingerprint });
      await rename(temporary, this.#job(source.testSpecId));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async readJob(testSpecId: string): Promise<{ source: TestSpec; profile: EffectiveProfile }> {
    await this.#privateRoot();
    const manifest = JobManifestSchema.parse(await readJson(this.#file(testSpecId, 'manifest.json')));
    if (Date.now() >= Date.parse(manifest.expiresAt)) throw new Error('Artifact retention expired');
    const source = parseTestSpec(await readJson(this.#file(testSpecId, 'test-spec.json')));
    const raw = await readJson(this.#file(testSpecId, 'profile.json')) as Record<string, unknown>;
    const profile = ExecutionProfileSchema.parse(raw.profile);
    const policy = NetworkPolicySchema.parse(raw.policy);
    if (manifest.testSpecId !== source.testSpecId || !same(source.executionProfileRef, manifest.executionProfileRef) ||
      manifest.profileFingerprint !== raw.fingerprint || !same(source.executionProfileRef, { id: profile.id, version: profile.version })) {
      throw new Error('Job manifest/profile integrity failure');
    }
    const effective = new ProfileCatalog([profile], [policy]).resolve(source.executionProfileRef);
    if (effective.fingerprint !== manifest.profileFingerprint) throw new Error('Stored profile fingerprint mismatch');
    return { source, profile: effective };
  }

  async writeEvidence(testSpecId: string, input: {
    evidenceId: string; owner: EvidenceDescriptor['owner']; mediaType: EvidenceDescriptor['mediaType'];
    content: Uint8Array | string | unknown; originStepId?: string; executionStepId?: string; locatorId?: string;
    allowSensitiveBinary?: boolean;
  }): Promise<EvidenceDescriptor> {
    const { source } = await this.readJob(testSpecId);
    let content: Uint8Array;
    if (input.mediaType === 'application/json') content = bytes(this.#redactor.value(input.content));
    else if (input.mediaType === 'text/plain') content = Buffer.from(this.#redactor.text(String(input.content)), 'utf8');
    else {
      if (!input.allowSensitiveBinary) throw new Error('Browser binary evidence requires explicit sensitive-capture approval');
      if (!(input.content instanceof Uint8Array)) throw new Error('Expected binary browser evidence');
      content = input.content;
    }
    const owner = input.owner.kind === 'attempt' ? `attempt-${id.parse(input.owner.id)}` : `run-${id.parse(input.owner.id)}`;
    const evidenceId = id.parse(input.evidenceId);
    const reference = `evidence/${owner}/${evidenceId}/content.${extensions[input.mediaType]}`;
    const descriptor = EvidenceDescriptorSchema.parse({
      schemaVersion: SCHEMA_VERSION, evidenceId: input.evidenceId, testSpecId: source.testSpecId,
      owner: input.owner, mediaType: input.mediaType, capturedAt: new Date().toISOString(),
      sensitivity: input.mediaType === 'application/json' || input.mediaType === 'text/plain' ? 'redacted' : 'restricted',
      byteLength: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'), ref: reference,
      ...(input.originStepId ? { originStepId: input.originStepId } : {}),
      ...(input.executionStepId ? { executionStepId: input.executionStepId } : {}),
      ...(input.locatorId ? { locatorId: input.locatorId } : {}),
    });
    const ownerDirectory = this.#file(testSpecId, 'evidence', owner);
    await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(ownerDirectory, `.pending-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await atomicCreate(path.join(temporary, `content.${extensions[input.mediaType]}`), content);
      await this.#createJson(path.join(temporary, 'manifest.json'), descriptor);
      await rename(temporary, path.join(ownerDirectory, evidenceId));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return descriptor;
  }

  async readEvidence(testSpecId: string, reference: string): Promise<EvidenceDescriptor> {
    await this.readJob(testSpecId);
    const segments = reference.split('/');
    if (segments.length !== 4 || segments[0] !== 'evidence' ||
      !/^content\.(?:json|txt|png|zip|webm)$/.test(segments[3] ?? '')) throw new Error('Invalid evidence reference');
    const file = this.#file(testSpecId, ...segments);
    const descriptor = EvidenceDescriptorSchema.parse(await readJson(path.join(path.dirname(file), 'manifest.json')));
    const content = await readFile(file);
    if (descriptor.ref !== reference || descriptor.testSpecId !== testSpecId ||
      descriptor.byteLength !== content.byteLength || descriptor.sha256 !== createHash('sha256').update(content).digest('hex')) {
      throw new Error('Evidence integrity failure');
    }
    return descriptor;
  }

  /** Restricted bytes require approval from the deployment-owned access boundary. */
  async readEvidenceContent(testSpecId: string, reference: string): Promise<Uint8Array> {
    const descriptor = await this.readEvidence(testSpecId, reference);
    if (descriptor.sensitivity === 'restricted') {
      if (!this.#restrictedAccess) throw new Error('Restricted evidence access denied');
      await this.#restrictedAccess.authorize(descriptor);
    }
    const content = await readFile(this.#file(testSpecId, ...reference.split('/')));
    if (content.byteLength !== descriptor.byteLength ||
      createHash('sha256').update(content).digest('hex') !== descriptor.sha256) {
      throw new Error('Evidence integrity failure');
    }
    return content;
  }

  async writeAttempt(input: unknown): Promise<ExplorationAttempt> {
    const attempt = ExplorationAttemptSchema.parse(input);
    const { source, profile } = await this.readJob(attempt.testSpecId);
    if (!same(attempt.executionProfileRef, source.executionProfileRef)) throw new Error('Attempt profile mismatch');
    if (attempt.profileFingerprint !== profile.fingerprint) throw new Error('Attempt effective profile mismatch');
    if (Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) throw new Error('Attempt timestamps out of order');
    const results = attempt.results.map(parseResultRecord);
    for (const result of results) {
      if (result.testSpecId !== source.testSpecId || result.explorationAttemptId !== attempt.explorationAttemptId ||
        (result.phase !== 'exploration' && result.phase !== 'locator')) throw new Error('Attempt result correlation failure');
      if (result.originStepId && !source.steps.some((step) => step.id === result.originStepId)) throw new Error('Attempt origin step missing');
    }
    await this.#verifyRefs(source.testSpecId, attempt.evidenceRefs, 'attempt', attempt.explorationAttemptId);
    for (const result of results) {
      await this.#verifyRefs(source.testSpecId, result.evidenceRefs, 'attempt', attempt.explorationAttemptId);
      for (const ref of result.evidenceRefs) {
        const descriptor = await this.readEvidence(source.testSpecId, ref);
        if (descriptor.originStepId !== result.originStepId ||
          descriptor.executionStepId !== result.executionStepId || descriptor.locatorId !== result.locatorId) {
          throw new Error('Attempt evidence result correlation failure');
        }
      }
    }
    const saved = { ...attempt, results: (this.#redactor.value(results) as unknown[]).map(parseResultRecord) };
    await this.#createJson(this.#file(source.testSpecId, 'attempts', `${attempt.explorationAttemptId}.json`), saved);
    return saved as ExplorationAttempt;
  }

  async writeResolved(input: unknown): Promise<ResolvedTestSpec> {
    const parsed = input as { testSpecId?: string };
    const { source } = await this.readJob(id.parse(parsed.testSpecId));
    const resolved = parseResolvedTestSpec(input, source);
    const attempt = ExplorationAttemptSchema.parse(await readJson(this.#file(source.testSpecId, 'attempts', `${resolved.explorationAttemptId}.json`)));
    if (attempt.status !== 'resolved') throw new Error('Resolved spec requires a successful attempt');
    for (const existingId of await this.listIds(source.testSpecId, 'resolved')) {
      const existing = await this.readResolved(source.testSpecId, existingId);
      if (existing.explorationAttemptId === resolved.explorationAttemptId) throw new Error('Exploration attempt already has a resolved artifact');
      if (existing.resolvedSpecId === resolved.resolvedSpecId) throw new Error('Resolved spec ID already exists');
    }
    this.#redactor.assertSafeContract(resolved);
    for (const step of resolved.executionSteps) {
      const descriptor = await this.readEvidence(source.testSpecId, step.derivationEvidenceRef);
      if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== resolved.explorationAttemptId ||
        descriptor.originStepId !== step.originStepId || descriptor.executionStepId !== step.id ||
        descriptor.locatorId !== ('locatorId' in step ? step.locatorId : undefined)) throw new Error('Derivation evidence correlation failure');
    }
    await this.#createJson(this.#file(source.testSpecId, 'resolved', `${resolved.explorationAttemptId}.json`), resolved);
    return resolved;
  }

  async readResolved(testSpecId: string, resolvedSpecId: string): Promise<ResolvedTestSpec> {
    const { source } = await this.readJob(testSpecId);
    id.parse(resolvedSpecId);
    let found: ResolvedTestSpec | undefined;
    for (const attemptId of await this.#fileIds(testSpecId, 'resolved')) {
      const resolved = parseResolvedTestSpec(await readJson(this.#file(testSpecId, 'resolved', `${attemptId}.json`)), source);
      if (resolved.resolvedSpecId === resolvedSpecId) {
        if (found) throw new Error('Duplicate resolved spec ID');
        found = resolved;
      }
    }
    if (!found) throw new Error(`Resolved spec ${resolvedSpecId} not found`);
    return found;
  }

  async #verifyRefs(testSpecId: string, refs: readonly string[], kind: 'attempt' | 'run', ownerId: string): Promise<void> {
    for (const reference of refs) {
      const descriptor = await this.readEvidence(testSpecId, reference);
      if (descriptor.owner.kind !== kind || descriptor.owner.id !== ownerId) throw new Error('Evidence owner mismatch');
    }
  }

  async writeRun(testSpecId: string, resolvedSpecId: string, run: ExecutionRun): Promise<StoredRun> {
    const resolved = await this.readResolved(testSpecId, resolvedSpecId);
    const { source, profile } = await this.readJob(testSpecId);
    assertEquivalentEffectiveProfile(profile, run.effectiveProfile);
    if (profile.fingerprint !== run.effectiveProfile.fingerprint ||
      !same(source.executionProfileRef, { id: run.effectiveProfile.profile.id, version: run.effectiveProfile.profile.version })) {
      throw new Error('Run effective profile mismatch');
    }
    const steps = new Map(resolved.executionSteps.map((step) => [step.id, step]));
    const outcomes = run.outcomes.map(parseResultRecord);
    if (outcomes.length < resolved.executionSteps.length || outcomes.length > resolved.executionSteps.length + 1) throw new Error('Run outcome count mismatch');
    const seen = new Set<string>();
    let nextStepIndex = 0;
    for (const result of outcomes) {
      if (result.phase !== 'execution' || result.testSpecId !== testSpecId || result.resolvedSpecId !== resolvedSpecId ||
        result.explorationAttemptId !== resolved.explorationAttemptId || result.executionRunId !== run.executionRunId ||
        !same(result.executionProfileRef, source.executionProfileRef)) throw new Error('Run result correlation failure');
      if (result.executionStepId) {
        const step = steps.get(result.executionStepId);
        if (!step || seen.has(step.id) || result.originStepId !== step.originStepId ||
          result.locatorId !== ('locatorId' in step ? step.locatorId : undefined) ||
          resolved.executionSteps[nextStepIndex]?.id !== step.id) throw new Error('Run step/locator correlation failure');
        seen.add(step.id);
        nextStepIndex += 1;
      }
      for (const ref of result.evidenceRefs) {
        const descriptor = await this.readEvidence(testSpecId, ref);
        if (descriptor.owner.kind !== 'run' || descriptor.owner.id !== run.executionRunId ||
          descriptor.originStepId !== result.originStepId || descriptor.executionStepId !== result.executionStepId ||
          descriptor.locatorId !== result.locatorId) throw new Error('Run evidence correlation failure');
      }
    }
    if (seen.size !== steps.size) throw new Error('Run is missing execution-step outcomes');
    const saved = StoredRunSchema.parse({
      schemaVersion: SCHEMA_VERSION, testSpecId, resolvedSpecId,
      explorationAttemptId: resolved.explorationAttemptId, executionRunId: run.executionRunId,
      executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
      versions: run.versions, outcomes: this.#redactor.value(outcomes),
    });
    for (const outcome of saved.outcomes) parseResultRecord(outcome);
    await this.#createJson(this.#file(testSpecId, 'runs', `${run.executionRunId}.json`), saved);
    return saved as StoredRun;
  }

  async readAttempt(testSpecId: string, attemptId: string): Promise<ExplorationAttempt> {
    await this.readJob(testSpecId);
    const raw = ExplorationAttemptSchema.parse(await readJson(this.#file(testSpecId, 'attempts', `${id.parse(attemptId)}.json`)));
    return { ...raw, results: raw.results.map(parseResultRecord) };
  }

  async readRun(testSpecId: string, runId: string): Promise<StoredRun> {
    await this.readJob(testSpecId);
    const raw = StoredRunSchema.parse(await readJson(this.#file(testSpecId, 'runs', `${id.parse(runId)}.json`)));
    return { ...raw, outcomes: raw.outcomes.map(parseResultRecord) };
  }

  async #fileIds(testSpecId: string, type: 'attempts' | 'resolved' | 'runs'): Promise<string[]> {
    const directory = this.#file(testSpecId, type);
    try {
      const entries = await readdir(directory);
      const ids: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.startsWith('.pending-')) continue;
        if (!(await stat(path.join(directory, entry))).isFile()) continue;
        ids.push(id.parse(entry.slice(0, -5)));
      }
      return ids.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async listIds(testSpecId: string, type: 'attempts' | 'resolved' | 'runs'): Promise<string[]> {
    await this.readJob(testSpecId);
    const ids = await this.#fileIds(testSpecId, type);
    if (type !== 'resolved') return ids;
    const resolvedIds = await Promise.all(ids.map(async (attemptId) => {
      const raw = await readJson(this.#file(testSpecId, 'resolved', `${attemptId}.json`)) as { resolvedSpecId?: unknown };
      return id.parse(raw.resolvedSpecId);
    }));
    return resolvedIds.sort();
  }

  /** Explicit operator sweep. Only expired artifacts created inside this private root are removed. */
  async pruneExpired(now = new Date()): Promise<{ jobs: string[]; interpretations: string[] }> {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid retention sweep time');
    try { await this.#privateRoot(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], interpretations: [] };
      throw error;
    }
    const jobs: string[] = [];
    const interpretations: string[] = [];
    const rootReal = await realpath(this.#root);
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (entry.name === '.interpretations') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe interpretation directory');
        const directory = path.join(this.#root, entry.name);
        for (const record of await readdir(directory, { withFileTypes: true })) {
          if (!record.name.endsWith('.json') || !id.safeParse(record.name.slice(0, -5)).success) continue;
          if (!record.isFile() || record.isSymbolicLink()) throw new Error('Unsafe interpretation record');
          const file = path.join(directory, record.name);
          if (now.getTime() >= (await stat(file)).mtimeMs + this.retentionDays * 86_400_000) {
            await unlink(file);
            interpretations.push(record.name.slice(0, -5));
          }
        }
        continue;
      }
      if (!id.safeParse(entry.name).success) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe artifact job directory');
      const job = this.#job(entry.name);
      const manifest = JobManifestSchema.parse(await readJson(path.join(job, 'manifest.json')));
      if (manifest.testSpecId !== entry.name) throw new Error('Artifact manifest ID mismatch');
      if (now.getTime() < Date.parse(manifest.expiresAt)) continue;
      const jobReal = await realpath(job);
      if (path.dirname(jobReal) !== rootReal) throw new Error('Artifact job escapes private root');
      const quarantine = path.join(this.#root, `.expired-${randomUUID()}`);
      await rename(job, quarantine);
      await rm(quarantine, { recursive: true });
      jobs.push(entry.name);
    }
    return { jobs, interpretations };
  }
}
