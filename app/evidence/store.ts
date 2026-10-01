import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, link, unlink, readFile, readdir, stat, lstat, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  SCHEMA_VERSION, ExecutionProfileRefSchema, TestSpecSchema, parseResultRecord, parseResolvedTestSpec,
  parseTestSpec, type ResolvedTestSpec, type ResultRecord, type TestSpec,
  parseCompilerAttemptV1, parseExplorationAttemptV3, parseExplorationBranchDiagnosticV1,
  parseSuccessfulExplorationTraceV1, parseSuccessfulExplorationTraceV2,
  parseSuccessfulExplorationTraceV3,
  parseSuccessfulExplorationTraceV4,
  SuccessfulExplorationTraceV4Schema,
  parseCompilerAttemptV2, parseResolvedTestSpecV7,
  parseCompilerAttemptV3, parseResolvedTestSpecV8,
  ExplorationBranchDiagnosticV1Schema,
  parseResolvedTestSpecV6,
  type CompilerAttemptV1, type ExplorationAttemptV3,
  type ExplorationBranchDiagnosticV1, type SuccessfulExplorationTraceV1,
  type SuccessfulExplorationTraceV2, type ResolvedTestSpecV6,
  type SuccessfulExplorationTraceV3,
  type SuccessfulExplorationTraceV4,
  type CompilerAttemptV2, type ResolvedTestSpecV7,
  type CompilerAttemptV3, type ResolvedTestSpecV8,
  type ProtectedTraceObservationSourceV3,
  type ProtectedTraceActionIdentitySourceV4,
  parseResultRecordV2, type ResultRecordV2,
} from '../domain/index.js';
import { ExecutionProfileSchema, NetworkPolicySchema, ProfileCatalog, assertEquivalentEffectiveProfile, type EffectiveProfile } from '../profile/index.js';
import type { ExecutionRun } from '../runner/index.js';
import { EvidenceRedactor } from './redact.js';
import { M7DecisionDiagnosticSchema, type M7DecisionDiagnostic } from './m7-diagnostic.js';
import { AssembledSuccessfulTraceV3, parseProtectedTraceCaptureBundleV3,
  ProtectedTraceCaptureBundleV3Schema } from '../exploration/trace-assembly-v3.js';
import { AssembledSuccessfulTraceV4, parseProtectedTraceCaptureBundleV4,
  ProtectedTraceCaptureBundleV4Schema } from '../exploration/trace-assembly-v4.js';

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
function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
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

  /** One atomic record keeps the v3 attempt and its successful trace inseparable. */
  async writeSuccessfulExploration(input: { attempt: unknown; trace: unknown }): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV1 | SuccessfulExplorationTraceV2;
  }> {
    const candidate = input.attempt as { testSpecId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const attempt = parseExplorationAttemptV3(input.attempt, source);
    const trace = (input.trace as { traceVersion?: unknown })?.traceVersion === '2' ?
      parseSuccessfulExplorationTraceV2(input.trace, source, attempt) :
      parseSuccessfulExplorationTraceV1(input.trace, source, attempt);
    if (attempt.status !== 'path_established' ||
      attempt.profileFingerprint !== profile.fingerprint || trace.profileFingerprint !== profile.fingerprint)
      throw new Error('Successful trace effective profile mismatch');
    if (trace.traceVersion === '2' && trace.bindings.some((binding) =>
      binding.frameOwnership.kind === 'unproven'))
      throw new Error('Successful v2 trace has unproven required frame ownership');
    this.#redactor.assertSafeContract(trace);
    for (const record of trace.successfulPath) {
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(source.testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attempt.explorationAttemptId ||
          descriptor.originStepId !== record.originStepId)
          throw new Error('Successful trace evidence correlation failure');
      }
    }
    const branchDirectory = this.#file(source.testSpecId, 'developer-diagnostics', attempt.explorationAttemptId);
    let branchNames: string[] = [];
    try { branchNames = await readdir(branchDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of branchNames.filter((entry) => /^branch-[1-9][0-9]*\.json$/.test(entry))) {
      const branch = parseExplorationBranchDiagnosticV1(await readJson(path.join(branchDirectory, name)), source, attempt);
      // A recovery branch may originate in a disposed protected session. It
      // must point to a record reconstructed in the final successful session.
      if ((branch.sessionId !== trace.sessionId && !branch.recoveredToRecordId) ||
        (branch.recoveredToRecordId && !trace.successfulPath.some((record) => record.recordId === branch.recoveredToRecordId)))
        throw new Error('Exploration branch linkage mismatch');
    }
    await this.#createJson(this.#file(source.testSpecId, 'agentic-explorations',
      `${attempt.explorationAttemptId}.json`), { attempt, trace });
    return { attempt, trace };
  }

  async readSuccessfulExploration(testSpecId: string, attemptId: string): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV1 | SuccessfulExplorationTraceV2;
  }> {
    const { source, profile } = await this.readJob(testSpecId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-explorations', `${id.parse(attemptId)}.json`)) as
      { attempt?: unknown; trace?: unknown };
    const attempt = parseExplorationAttemptV3(raw.attempt, source);
    const trace = (raw.trace as { traceVersion?: unknown })?.traceVersion === '2' ?
      parseSuccessfulExplorationTraceV2(raw.trace, source, attempt) :
      parseSuccessfulExplorationTraceV1(raw.trace, source, attempt);
    if (attempt.explorationAttemptId !== attemptId || attempt.status !== 'path_established' ||
      attempt.profileFingerprint !== profile.fingerprint || trace.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored successful trace correlation failure');
    if (trace.traceVersion === '2' && trace.bindings.some((binding) =>
      binding.frameOwnership.kind === 'unproven'))
      throw new Error('Stored successful v2 trace has unproven required frame ownership');
    for (const record of trace.successfulPath) {
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attemptId ||
          descriptor.originStepId !== record.originStepId)
          throw new Error('Stored successful trace evidence correlation failure');
      }
    }
    return { attempt, trace };
  }

  /** V3 uses a separate immutable namespace and a protected runtime capture bundle. */
  async writeSuccessfulExplorationV3(assembled: AssembledSuccessfulTraceV3): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV3;
  }> {
    if (!(assembled instanceof AssembledSuccessfulTraceV3))
      throw new Error('V3 write requires protected assembler output');
    const artifact = assembled.protectedArtifact();
    const { source, profile } = await this.readJob(artifact.attempt.testSpecId);
    const attempt = parseExplorationAttemptV3(artifact.attempt, source);
    const capture = ProtectedTraceCaptureBundleV3Schema.parse(artifact.capture);
    const rawTrace = artifact.trace;
    const proof = parseProtectedTraceCaptureBundleV3(capture, rawTrace);
    const trace = parseSuccessfulExplorationTraceV3(rawTrace, source, attempt, proof.source);
    if (attempt.status !== 'path_established' ||
        attempt.profileFingerprint !== profile.fingerprint ||
        trace.profileFingerprint !== profile.fingerprint)
      throw new Error('V3 effective profile mismatch');
    this.#redactor.assertSafeContract(trace);
    this.#redactor.assertSafeContract(capture);
    for (const record of trace.successfulPath) {
      if (record.type === 'verification_goal') continue;
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(source.testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' ||
            descriptor.owner.id !== attempt.explorationAttemptId ||
            descriptor.originStepId !== record.originStepId)
          throw new Error('V3 evidence correlation failure');
      }
    }
    const branchDirectory = this.#file(source.testSpecId, 'developer-diagnostics',
      attempt.explorationAttemptId);
    let branchNames: string[] = [];
    try { branchNames = await readdir(branchDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of branchNames.filter((entry) => /^branch-[1-9][0-9]*\.json$/.test(entry))) {
      const branch = parseExplorationBranchDiagnosticV1(
        await readJson(path.join(branchDirectory, name)), source, attempt);
      if ((branch.sessionId !== trace.sessionId && !branch.recoveredToRecordId) ||
          (branch.recoveredToRecordId && !trace.successfulPath.some((record) =>
            record.recordId === branch.recoveredToRecordId)))
        throw new Error('V3 branch linkage mismatch');
    }
    const envelope = { attempt, trace, capture,
      sourceDigest: hashJson(source), attemptDigest: hashJson(attempt),
      traceDigest: hashJson(trace), captureDigest: hashJson(capture) };
    await this.#createJson(this.#file(source.testSpecId, 'agentic-explorations-v3',
      `${attempt.explorationAttemptId}.json`), envelope);
    return { attempt, trace };
  }

  async readSuccessfulExplorationV3(testSpecId: string, attemptId: string): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV3;
  }> {
    const { source, profile } = await this.readJob(testSpecId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-explorations-v3',
      `${id.parse(attemptId)}.json`)) as Record<string, unknown>;
    if (raw.sourceDigest !== hashJson(source) ||
        raw.attemptDigest !== hashJson(raw.attempt) ||
        raw.traceDigest !== hashJson(raw.trace) ||
        raw.captureDigest !== hashJson(raw.capture))
      throw new Error('Stored v3 artifact digest mismatch');
    const attempt = parseExplorationAttemptV3(raw.attempt, source);
    const traceInput = raw.trace as SuccessfulExplorationTraceV3;
    const proof = parseProtectedTraceCaptureBundleV3(raw.capture, traceInput);
    const trace = parseSuccessfulExplorationTraceV3(traceInput, source, attempt, proof.source);
    if (attempt.explorationAttemptId !== attemptId ||
        attempt.status !== 'path_established' ||
        attempt.profileFingerprint !== profile.fingerprint ||
        trace.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored v3 artifact ownership mismatch');
    for (const record of trace.successfulPath) {
      if (record.type === 'verification_goal') continue;
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attemptId ||
            descriptor.originStepId !== record.originStepId)
          throw new Error('Stored v3 evidence correlation failure');
      }
    }
    return { attempt, trace };
  }

  /** V5 actions enter only the separate immutable trace-v4 namespace. */
  async writeSuccessfulExplorationV4(assembled: AssembledSuccessfulTraceV4): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV4;
  }> {
    if (!(assembled instanceof AssembledSuccessfulTraceV4))
      throw new Error('V4 write requires protected assembler output');
    const artifact = assembled.protectedArtifact();
    const { source, profile } = await this.readJob(artifact.attempt.testSpecId);
    if (source.schemaVersion !== '5') throw new Error('V4 trace requires TestSpec v5');
    const attempt = parseExplorationAttemptV3(artifact.attempt, source);
    const capture = ProtectedTraceCaptureBundleV4Schema.parse(artifact.capture);
    const proof = parseProtectedTraceCaptureBundleV4(capture, artifact.trace);
    const trace = parseSuccessfulExplorationTraceV4(artifact.trace, source, attempt, proof.source);
    if (attempt.status !== 'path_established' ||
        attempt.profileFingerprint !== profile.fingerprint ||
        trace.profileFingerprint !== profile.fingerprint)
      throw new Error('V4 effective profile mismatch');
    this.#redactor.assertSafeContract(trace);
    this.#redactor.assertSafeContract(capture);
    for (const record of trace.successfulPath) {
      if (record.type === 'verification_goal') continue;
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(source.testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attempt.explorationAttemptId ||
            descriptor.originStepId !== record.originStepId)
          throw new Error('V4 evidence correlation failure');
      }
    }
    const branchDirectory = this.#file(source.testSpecId, 'developer-diagnostics',
      attempt.explorationAttemptId);
    let branchNames: string[] = [];
    try { branchNames = await readdir(branchDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of branchNames.filter((entry) => /^branch-[1-9][0-9]*\.json$/.test(entry))) {
      const branch = parseExplorationBranchDiagnosticV1(
        await readJson(path.join(branchDirectory, name)), source, attempt);
      if ((branch.sessionId !== trace.sessionId && !branch.recoveredToRecordId) ||
          (branch.recoveredToRecordId && !trace.successfulPath.some((record) =>
            record.recordId === branch.recoveredToRecordId)))
        throw new Error('V4 branch linkage mismatch');
    }
    const envelope = { attempt, trace, capture, sourceDigest: hashJson(source),
      attemptDigest: hashJson(attempt), traceDigest: hashJson(trace), captureDigest: hashJson(capture) };
    await this.#createJson(this.#file(source.testSpecId, 'agentic-explorations-v4',
      `${attempt.explorationAttemptId}.json`), envelope);
    return this.readSuccessfulExplorationV4(source.testSpecId, attempt.explorationAttemptId);
  }

  async readSuccessfulExplorationV4(testSpecId: string, attemptId: string): Promise<{
    attempt: ExplorationAttemptV3; trace: SuccessfulExplorationTraceV4;
  }> {
    const { source, profile } = await this.readJob(testSpecId);
    if (source.schemaVersion !== '5') throw new Error('V4 trace requires TestSpec v5');
    const raw = await readJson(this.#file(testSpecId, 'agentic-explorations-v4',
      `${id.parse(attemptId)}.json`)) as Record<string, unknown>;
    if (raw.sourceDigest !== hashJson(source) || raw.attemptDigest !== hashJson(raw.attempt) ||
        raw.traceDigest !== hashJson(raw.trace) || raw.captureDigest !== hashJson(raw.capture))
      throw new Error('Stored v4 artifact digest mismatch');
    const attempt = parseExplorationAttemptV3(raw.attempt, source);
    const traceInput = SuccessfulExplorationTraceV4Schema.parse(raw.trace);
    const proof = parseProtectedTraceCaptureBundleV4(raw.capture, traceInput);
    const trace = parseSuccessfulExplorationTraceV4(traceInput, source, attempt, proof.source);
    if (attempt.explorationAttemptId !== attemptId || attempt.status !== 'path_established' ||
        attempt.profileFingerprint !== profile.fingerprint || trace.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored v4 artifact ownership mismatch');
    for (const record of trace.successfulPath) {
      if (record.type === 'verification_goal') continue;
      for (const ref of record.evidenceRefs ?? []) {
        const descriptor = await this.readEvidence(testSpecId, ref);
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attemptId ||
            descriptor.originStepId !== record.originStepId)
          throw new Error('Stored v4 evidence correlation failure');
      }
    }
    return { attempt, trace };
  }

  /** Compiler handoff reads only validated protected v4 capture, never model output. */
  async readSuccessfulExplorationV4Proof(testSpecId: string, attemptId: string):
    Promise<ProtectedTraceActionIdentitySourceV4> {
    const { trace } = await this.readSuccessfulExplorationV4(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-explorations-v4',
      `${id.parse(attemptId)}.json`)) as { capture: unknown };
    return parseProtectedTraceCaptureBundleV4(raw.capture, trace).source;
  }

  /** V5/v4 compiler artifacts are isolated from the phrase-based v4/v3/v7 route. */
  async writeCompilerAttemptV3(input: unknown): Promise<CompilerAttemptV3> {
    const candidate = input as { testSpecId?: string; explorationAttemptId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const attemptId = id.parse(candidate.explorationAttemptId);
    const { attempt, trace } = await this.readSuccessfulExplorationV4(source.testSpecId, attemptId);
    const proof = await this.readSuccessfulExplorationV4Proof(source.testSpecId, attemptId);
    const compiler = parseCompilerAttemptV3(input, source, attempt, trace, proof);
    if (compiler.result.status !== 'rejected' || compiler.profileFingerprint !== profile.fingerprint)
      throw new Error('Standalone compiler v3 must be a same-profile rejection');
    this.#redactor.assertSafeContract(compiler);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts-v3',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), compiler);
    return this.readCompilerAttemptV3(source.testSpecId, attemptId, compiler.compilerAttemptId);
  }

  async readCompilerAttemptV3(testSpecId: string, attemptId: string,
    compilerId: string): Promise<CompilerAttemptV3> {
    const { source, profile } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExplorationV4(testSpecId, attemptId);
    const proof = await this.readSuccessfulExplorationV4Proof(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts-v3',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as { compiler?: unknown; resolved?: unknown };
    const compiler = parseCompilerAttemptV3(raw.compiler ?? raw, source, attempt, trace, proof);
    if (compiler.compilerAttemptId !== compilerId || compiler.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored compiler v3 linkage mismatch');
    if (compiler.result.status === 'accepted') {
      if (!raw.resolved) throw new Error('Accepted compiler v3 lacks v8 artifact');
      parseResolvedTestSpecV8(raw.resolved, source, attempt, trace, proof, compiler);
    } else if (raw.resolved) throw new Error('Rejected compiler v3 cannot carry v8');
    return compiler;
  }

  async writeCompiledExplorationV8(input: { compiler: unknown; resolved: unknown }): Promise<{
    compiler: CompilerAttemptV3; resolved: ResolvedTestSpecV8;
  }> {
    const candidate = input.compiler as { testSpecId?: string; explorationAttemptId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const attemptId = id.parse(candidate.explorationAttemptId);
    const { attempt, trace } = await this.readSuccessfulExplorationV4(source.testSpecId, attemptId);
    const proof = await this.readSuccessfulExplorationV4Proof(source.testSpecId, attemptId);
    const compiler = parseCompilerAttemptV3(input.compiler, source, attempt, trace, proof);
    const resolved = parseResolvedTestSpecV8(input.resolved, source, attempt, trace, proof, compiler);
    if (compiler.result.status !== 'accepted' || compiler.profileFingerprint !== profile.fingerprint ||
        resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Compiled v8 profile mismatch');
    this.#redactor.assertSafeContract(compiler);
    this.#redactor.assertSafeContract(resolved);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts-v3',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), { compiler, resolved });
    return this.readCompiledExplorationV8(source.testSpecId, attemptId, compiler.compilerAttemptId);
  }

  async readCompiledExplorationV8(testSpecId: string, attemptId: string,
    compilerId: string): Promise<{ compiler: CompilerAttemptV3; resolved: ResolvedTestSpecV8 }> {
    const { source, profile } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExplorationV4(testSpecId, attemptId);
    const proof = await this.readSuccessfulExplorationV4Proof(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts-v3',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as { compiler: unknown; resolved: unknown };
    const compiler = parseCompilerAttemptV3(raw.compiler, source, attempt, trace, proof);
    const resolved = parseResolvedTestSpecV8(raw.resolved, source, attempt, trace, proof, compiler);
    if (compiler.compilerAttemptId !== compilerId || compiler.profileFingerprint !== profile.fingerprint ||
        resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored compiled v8 linkage mismatch');
    return { compiler, resolved };
  }

  /** Private compiler proof lookup, reconstructed only after immutable v3 readback. */
  async readSuccessfulExplorationV3Proof(testSpecId: string, attemptId: string):
    Promise<ProtectedTraceObservationSourceV3> {
    const { trace } = await this.readSuccessfulExplorationV3(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-explorations-v3',
      `${id.parse(attemptId)}.json`)) as { capture: unknown };
    return parseProtectedTraceCaptureBundleV3(raw.capture, trace).source;
  }

  /** Rejections and accepted v7 artifacts live outside the released v1/v6 compiler namespace. */
  async writeCompilerAttemptV2(input: unknown): Promise<CompilerAttemptV2> {
    const candidate = input as { testSpecId?: string; explorationAttemptId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const attemptId = id.parse(candidate.explorationAttemptId);
    const { attempt, trace } = await this.readSuccessfulExplorationV3(source.testSpecId, attemptId);
    const raw = await readJson(this.#file(source.testSpecId, 'agentic-explorations-v3', `${attemptId}.json`)) as
      { capture: unknown };
    const proof = parseProtectedTraceCaptureBundleV3(raw.capture, trace);
    const compiler = parseCompilerAttemptV2(input, source, attempt, trace, proof.source);
    if (compiler.result.status !== 'rejected' || compiler.profileFingerprint !== profile.fingerprint)
      throw new Error('Standalone v2 compiler attempt must be a same-profile rejection');
    this.#redactor.assertSafeContract(compiler);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts-v2',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), compiler);
    return compiler;
  }

  async readCompilerAttemptV2(testSpecId: string, attemptId: string,
    compilerId: string): Promise<CompilerAttemptV2> {
    const { source, profile } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExplorationV3(testSpecId, attemptId);
    const proof = await this.readSuccessfulExplorationV3Proof(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts-v2',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as
      { compiler?: unknown; resolved?: unknown };
    const compiler = parseCompilerAttemptV2(raw.compiler ?? raw, source, attempt, trace, proof);
    if (compiler.compilerAttemptId !== compilerId || compiler.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored compiler v2 correlation failure');
    if (compiler.result.status === 'accepted') {
      if (!raw.resolved) throw new Error('Accepted compiler v2 lacks resolved v7 artifact');
      parseResolvedTestSpecV7(raw.resolved, source, attempt, trace, proof, compiler);
    } else if (raw.resolved) throw new Error('Rejected compiler v2 cannot carry resolved v7 artifact');
    return compiler;
  }

  async writeCompiledExplorationV7(input: { compiler: unknown; resolved: unknown }): Promise<{
    compiler: CompilerAttemptV2; resolved: ResolvedTestSpecV7;
  }> {
    const candidate = input.compiler as { testSpecId?: string; explorationAttemptId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const attemptId = id.parse(candidate.explorationAttemptId);
    const { attempt, trace } = await this.readSuccessfulExplorationV3(source.testSpecId, attemptId);
    const raw = await readJson(this.#file(source.testSpecId, 'agentic-explorations-v3', `${attemptId}.json`)) as
      { capture: unknown };
    const proof = parseProtectedTraceCaptureBundleV3(raw.capture, trace);
    const compiler = parseCompilerAttemptV2(input.compiler, source, attempt, trace, proof.source);
    const resolved = parseResolvedTestSpecV7(input.resolved, source, attempt, trace, proof.source, compiler);
    if (compiler.result.status !== 'accepted' || compiler.profileFingerprint !== profile.fingerprint ||
        resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Compiled v7 effective profile mismatch');
    this.#redactor.assertSafeContract(compiler);
    this.#redactor.assertSafeContract(resolved);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts-v2',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), { compiler, resolved });
    return { compiler, resolved };
  }

  async readCompiledExplorationV7(testSpecId: string, attemptId: string, compilerId: string): Promise<{
    compiler: CompilerAttemptV2; resolved: ResolvedTestSpecV7;
  }> {
    const { source, profile } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExplorationV3(testSpecId, attemptId);
    const rawTrace = await readJson(this.#file(testSpecId, 'agentic-explorations-v3', `${id.parse(attemptId)}.json`)) as
      { capture: unknown };
    const proof = parseProtectedTraceCaptureBundleV3(rawTrace.capture, trace);
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts-v2',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as { compiler?: unknown; resolved?: unknown };
    const compiler = parseCompilerAttemptV2(raw.compiler, source, attempt, trace, proof.source);
    const resolved = parseResolvedTestSpecV7(raw.resolved, source, attempt, trace, proof.source, compiler);
    if (compiler.compilerAttemptId !== compilerId || compiler.profileFingerprint !== profile.fingerprint ||
        resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored compiled v7 correlation failure');
    return { compiler, resolved };
  }

  /** Closed branch records are private diagnostics, never path records or evidence refs. */
  async writeExplorationBranchDiagnostic(input: unknown): Promise<ExplorationBranchDiagnosticV1> {
    const diagnostic = ExplorationBranchDiagnosticV1Schema.parse(input);
    const { source, profile } = await this.readJob(diagnostic.testSpecId);
    if (diagnostic.profileFingerprint !== profile.fingerprint ||
      !same(diagnostic.executionProfileRef, source.executionProfileRef) ||
      !source.steps.some((step) => step.id === diagnostic.originStepId))
      throw new Error('Exploration branch diagnostic owner or goal mismatch');
    let established: SuccessfulExplorationTraceV1 | SuccessfulExplorationTraceV2 | undefined;
    try {
      established = (await this.readSuccessfulExploration(source.testSpecId, diagnostic.explorationAttemptId)).trace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let establishedV3 = false;
    try {
      await this.readSuccessfulExplorationV3(source.testSpecId, diagnostic.explorationAttemptId);
      establishedV3 = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (established || establishedV3)
      throw new Error('Exploration branch diagnostics closed after trace finalization');
    this.#redactor.assertSafeContract(diagnostic);
    const file = this.#file(source.testSpecId, 'developer-diagnostics', diagnostic.explorationAttemptId,
      `branch-${diagnostic.branchOrdinal}.json`);
    await this.#createJson(file, diagnostic);
    return diagnostic;
  }

  async readExplorationBranchDiagnostics(testSpecId: string, attemptId: string): Promise<ExplorationBranchDiagnosticV1[]> {
    const { source } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExploration(testSpecId, attemptId);
    const directory = this.#file(testSpecId, 'developer-diagnostics', id.parse(attemptId));
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => /^branch-[1-9][0-9]*\.json$/.test(name))
      .map(async (name) => parseExplorationBranchDiagnosticV1(await readJson(path.join(directory, name)), source, attempt)));
    if (records.some((record) => record.sessionId !== trace.sessionId &&
      (!record.recoveredToRecordId || !trace.successfulPath.some((step) => step.recordId === record.recoveredToRecordId))))
      throw new Error('Exploration branch session mismatch');
    return records.sort((a, b) => a.branchOrdinal - b.branchOrdinal);
  }

  async writeCompilerAttemptV1(input: unknown): Promise<CompilerAttemptV1> {
    const candidate = input as { testSpecId?: string; explorationAttemptId?: string };
    const { source } = await this.readJob(id.parse(candidate.testSpecId));
    const { attempt, trace } = await this.readSuccessfulExploration(source.testSpecId,
      id.parse(candidate.explorationAttemptId));
    const compiler = parseCompilerAttemptV1(input, trace, source, attempt);
    this.#redactor.assertSafeContract(compiler);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), compiler);
    return compiler;
  }

  async readCompilerAttemptV1(testSpecId: string, attemptId: string, compilerId: string): Promise<CompilerAttemptV1> {
    const { source } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExploration(testSpecId, attemptId);
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as Record<string, unknown>;
    return parseCompilerAttemptV1(raw.compiler ?? raw, trace, source, attempt);
  }

  /** The accepted attempt and v6 artifact are atomically created together. */
  async writeCompiledExplorationV6(input: { compiler: unknown; resolved: unknown }): Promise<{
    compiler: CompilerAttemptV1; resolved: ResolvedTestSpecV6;
  }> {
    const candidate = input.compiler as { testSpecId?: string; explorationAttemptId?: string };
    const { source, profile } = await this.readJob(id.parse(candidate.testSpecId));
    const { attempt, trace } = await this.readSuccessfulExploration(source.testSpecId,
      id.parse(candidate.explorationAttemptId));
    if (trace.traceVersion === '1' && trace.bindings.length > 0)
      throw new Error('Targeted v1 trace lacks durable frame-owner provenance');
    const compiler = parseCompilerAttemptV1(input.compiler, trace, source, attempt);
    const resolved = parseResolvedTestSpecV6(input.resolved, source, attempt, trace, compiler);
    if (compiler.result.status !== 'accepted' ||
      compiler.profileFingerprint !== profile.fingerprint || resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Compiled v6 effective profile mismatch');
    this.#redactor.assertSafeContract(compiler);
    this.#redactor.assertSafeContract(resolved);
    await this.#createJson(this.#file(source.testSpecId, 'agentic-compiler-attempts',
      trace.successfulTraceId, `${compiler.compilerAttemptId}.json`), { compiler, resolved });
    return { compiler, resolved };
  }

  async readCompiledExplorationV6(testSpecId: string, attemptId: string, compilerId: string): Promise<{
    compiler: CompilerAttemptV1; resolved: ResolvedTestSpecV6;
  }> {
    const { source, profile } = await this.readJob(testSpecId);
    const { attempt, trace } = await this.readSuccessfulExploration(testSpecId, attemptId);
    if (trace.traceVersion === '1' && trace.bindings.length > 0)
      throw new Error('Targeted v1 trace lacks durable frame-owner provenance');
    const raw = await readJson(this.#file(testSpecId, 'agentic-compiler-attempts',
      trace.successfulTraceId, `${id.parse(compilerId)}.json`)) as { compiler?: unknown; resolved?: unknown };
    const compiler = parseCompilerAttemptV1(raw.compiler, trace, source, attempt);
    const resolved = parseResolvedTestSpecV6(raw.resolved, source, attempt, trace, compiler);
    if (compiler.profileFingerprint !== profile.fingerprint || resolved.profileFingerprint !== profile.fingerprint)
      throw new Error('Stored compiled v6 effective profile mismatch');
    return { compiler, resolved };
  }

  /** Internal, private decision trace. It is intentionally outside evidence refs and report projection. */
  async writeM7DecisionDiagnostic(testSpecId: string, input: unknown): Promise<M7DecisionDiagnostic> {
    const diagnostic = M7DecisionDiagnosticSchema.parse(input);
    await this.readJob(testSpecId);
    const directory = this.#file(testSpecId, 'developer-diagnostics', diagnostic.explorationAttemptId);
    await this.#createJson(path.join(directory, `decision-${diagnostic.callOrdinal}.json`), diagnostic);
    return diagnostic;
  }

  async readM7DecisionDiagnostics(testSpecId: string, attemptId: string): Promise<M7DecisionDiagnostic[]> {
    await this.readJob(testSpecId);
    const directory = this.#file(testSpecId, 'developer-diagnostics', id.parse(attemptId));
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => /^decision-[1-9][0-9]*\.json$/.test(name))
      .map(async (name) => M7DecisionDiagnosticSchema.parse(await readJson(path.join(directory, name)))));
    if (records.some((record) => record.explorationAttemptId !== attemptId)) throw new Error('M7 diagnostic attempt mismatch');
    return records.sort((a, b) => a.callOrdinal - b.callOrdinal);
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
    return this.#writeRunForResolved(testSpecId, resolved, run);
  }

  /** V6 runs are linked to the immutable accepted compiler record, never to a legacy resolved file. */
  async writeAgenticRunV6(testSpecId: string, attemptId: string, compilerId: string,
    run: ExecutionRun): Promise<StoredRun> {
    const { resolved } = await this.readCompiledExplorationV6(testSpecId, attemptId, compilerId);
    return this.#writeRunForResolved(testSpecId, resolved, run);
  }

  /** V7 runs are accepted only through the v3/compiler-v2 namespace. */
  async writeAgenticRunV7(testSpecId: string, attemptId: string, compilerId: string,
    run: ExecutionRun): Promise<StoredRun> {
    const { resolved } = await this.readCompiledExplorationV7(testSpecId, attemptId, compilerId);
    return this.#writeRunForResolved(testSpecId, resolved, run);
  }

  /** V8 runs are accepted only through the v4/compiler-v3 namespace. */
  async writeAgenticRunV8(testSpecId: string, attemptId: string, compilerId: string,
    run: ExecutionRun): Promise<StoredRun> {
    const { resolved } = await this.readCompiledExplorationV8(testSpecId, attemptId, compilerId);
    return this.#writeRunForResolved(testSpecId, resolved, run);
  }

  async #writeRunForResolved(testSpecId: string, resolved: ResolvedTestSpec | ResolvedTestSpecV6 | ResolvedTestSpecV7 | ResolvedTestSpecV8,
    run: ExecutionRun): Promise<StoredRun> {
    const resolvedSpecId = resolved.resolvedSpecId;
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

  /** A terminal summary is immutable and separate from legacy step results. */
  async writeAgenticTerminalV2(input: unknown): Promise<ResultRecordV2> {
    const terminal = parseResultRecordV2(input);
    if (terminal.workflowVersion === 'deferred-action-v1') throw new Error('Deferred results require authenticated replay-v9 storage');
    const { source, profile } = await this.readJob(terminal.testSpecId);
    if (!same(source.executionProfileRef, terminal.executionProfileRef) ||
      profile.fingerprint !== terminal.profileFingerprint)
      throw new Error('Agentic terminal source/profile mismatch');
    this.#redactor.assertSafeContract(terminal);
    await this.#createJson(this.#file(terminal.testSpecId, 'agentic-terminal-v2.json'), terminal);
    return terminal;
  }

  async readAgenticTerminalV2(testSpecId: string): Promise<ResultRecordV2> {
    const { source, profile } = await this.readJob(testSpecId);
    const terminal = parseResultRecordV2(await readJson(this.#file(testSpecId, 'agentic-terminal-v2.json')));
    if (terminal.workflowVersion === 'deferred-action-v1') throw new Error('Deferred results require authenticated replay-v9 storage');
    if (terminal.testSpecId !== testSpecId || !same(terminal.executionProfileRef, source.executionProfileRef) ||
      terminal.profileFingerprint !== profile.fingerprint)
      throw new Error('Agentic terminal source/profile mismatch');
    return terminal;
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

  /** Bound all bytes the report reader may touch before reconstructing a UI projection. */
  async assertProjectionReadBudget(testSpecId: string, maxBytes: number, maxFiles: number): Promise<void> {
    await this.#privateRoot();
    const job = this.#job(id.parse(testSpecId));
    let files = 0;
    let bytes = 0;
    const scan = async (target: string): Promise<void> => {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Unsafe projection artifact link');
      if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > maxFiles || bytes > maxBytes) throw new Error('Projection artifact budget exceeded');
        return;
      }
      if (!info.isDirectory()) throw new Error('Unsafe projection artifact type');
      for (const name of await readdir(target)) await scan(path.join(target, name));
    };
    await scan(job);
    const interpretation = path.join(this.#root, '.interpretations', `${testSpecId}.json`);
    try { await scan(interpretation); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
