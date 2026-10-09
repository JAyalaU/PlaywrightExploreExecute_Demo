import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { admitSemanticIntentV3, requireTrustedSemanticIntentAdmissionV3,
  type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { issueSemanticGroundedTraceV1, parseSemanticGroundedTraceV1,
  requireIssuedSemanticGroundedTraceV1, SemanticGroundedTraceV1Schema,
  type SemanticGroundedTraceV1 } from '../domain/semantic-resolved-v10.js';
import { semanticIntentCanonicalDigestV3 } from '../interpretation/semantic-intent-v3-relations.js';
import { canonicalizeSemanticRelationsV3 } from '../interpretation/semantic-intent-v3-relations.js';

const namespace = 'semantic-grounded-trace-v1';
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z.strictObject({
  storageVersion: z.literal('1'), namespace: z.literal(namespace),
  testSpecId: id, attemptId: id, traceDigest: digest,
  sourceBinding: z.strictObject({
    sourceDigest: digest, specDigest: digest, canonicalSemanticDigest: digest,
    semanticSchemaVersion: z.literal('7'), sourceContractVersion: z.literal('3'),
    admissionVersion: z.literal('3'),
  }),
  profileBinding: z.strictObject({
    profileId: id, profileVersion: z.string().min(1).max(128), profileFingerprint: digest,
  }),
  trace: SemanticGroundedTraceV1Schema, authentication: digest,
});
type Envelope = z.infer<typeof envelope>;
type Data = Omit<Envelope, 'authentication'>;
export type SemanticGroundedTraceV1ArtifactRef = Readonly<{
  testSpecId: string; attemptId: string; traceId: string; traceDigest: string; path: string;
}>;
const traceIdOf = (traceDigest: string): string => `semanticTrace${traceDigest.slice(0, 32)}`;

async function regular(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('INVALID_SEMANTIC_GROUNDED_TRACE_FILE');
  return readFile(file);
}

function validateAdmission(admission: TrustedSemanticIntentAdmissionV3): void {
  requireTrustedSemanticIntentAdmissionV3(admission);
  const spec = structuredClone(admission.spec);
  const source = { testSpecId: spec.testSpecId, sourceInstruction: spec.sourceInstruction,
    executionProfileRef: spec.executionProfileRef, startState: spec.startState };
  const check = admitSemanticIntentV3(source, spec, { verdict: 'faithful', issues: [] });
  if (JSON.stringify(check.record) !== JSON.stringify(admission.record) ||
      JSON.stringify(canonicalizeSemanticRelationsV3(source, spec)) !== JSON.stringify(spec))
    throw new Error('SEMANTIC_GROUNDED_TRACE_ADMISSION_MISMATCH');
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
}

/** Immutable, root-local historical compiler source. It never restores a browser session. */
export class SemanticGroundedTraceV1Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(artifactRoot: string) { this.#root = path.resolve(artifactRoot); }

  async #directory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '')
      throw new Error('SEMANTIC_GROUNDED_TRACE_ROOT_SYMLINK');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('SEMANTIC_GROUNDED_TRACE_PATH_OUTSIDE_ROOT');
    let checked = this.#root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('INVALID_SEMANTIC_GROUNDED_TRACE_DIRECTORY');
    }
  }

  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.semantic-grounded-trace-v1-authority');
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const key = await regular(file, 32);
      if (key.length !== 32) throw new Error('INVALID_SEMANTIC_GROUNDED_TRACE_AUTHORITY');
      return key;
    })();
    return this.#key;
  }

  #file(testSpecId: string, attemptId: string): string {
    return path.join(this.#root, namespace, id.parse(testSpecId), `${id.parse(attemptId)}.json`);
  }

  async writeSuccessfulGroundingV1(admission: TrustedSemanticIntentAdmissionV3,
    issuedTrace: SemanticGroundedTraceV1): Promise<SemanticGroundedTraceV1ArtifactRef> {
    validateAdmission(admission);
    requireIssuedSemanticGroundedTraceV1(issuedTrace);
    const trace = parseSemanticGroundedTraceV1(structuredClone(issuedTrace), admission);
    const data: Data = {
      storageVersion: '1', namespace, testSpecId: trace.testSpecId,
      attemptId: trace.attemptId, traceDigest: trace.traceDigest,
      sourceBinding: {
        sourceDigest: admission.record.sourceDigest, specDigest: admission.record.specDigest,
        canonicalSemanticDigest: semanticIntentCanonicalDigestV3(admission.spec),
        semanticSchemaVersion: admission.spec.schemaVersion,
        sourceContractVersion: admission.spec.sourceContractVersion,
        admissionVersion: admission.record.admissionVersion,
      },
      profileBinding: {
        profileId: admission.spec.executionProfileRef.id,
        profileVersion: admission.spec.executionProfileRef.version,
        profileFingerprint: trace.profileFingerprint,
      }, trace,
    };
    const authentication = createHmac('sha256', await this.#authority())
      .update(JSON.stringify(data)).digest('hex');
    const file = this.#file(trace.testSpecId, trace.attemptId);
    await this.#directory(path.dirname(file), true);
    const pending = path.join(path.dirname(file), `.pending-${randomUUID()}`);
    const handle = await open(pending, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(pending, file); } finally { await unlink(pending); }
    await this.readSuccessfulGroundingV1(trace.testSpecId, trace.attemptId, admission);
    return Object.freeze({ testSpecId: trace.testSpecId, attemptId: trace.attemptId,
      traceId: traceIdOf(trace.traceDigest), traceDigest: trace.traceDigest, path: file });
  }

  async readSuccessfulGroundingV1(testSpecId: string, attemptId: string,
    admission: TrustedSemanticIntentAdmissionV3): Promise<SemanticGroundedTraceV1> {
    validateAdmission(admission);
    const file = this.#file(testSpecId, attemptId);
    await this.#directory(path.dirname(file), false);
    const raw: unknown = JSON.parse((await regular(file, 32 * 1024 * 1024)).toString('utf8'));
    const artifact = envelope.parse(raw);
    const { authentication, ...data } = artifact;
    const expected = createHmac('sha256', await this.#authority())
      .update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected))
      throw new Error('UNAUTHENTICATED_SEMANTIC_GROUNDED_TRACE');
    if (artifact.testSpecId !== testSpecId || artifact.attemptId !== attemptId ||
        artifact.trace.testSpecId !== testSpecId || artifact.trace.attemptId !== attemptId ||
        artifact.trace.traceDigest !== artifact.traceDigest ||
        artifact.sourceBinding.sourceDigest !== admission.record.sourceDigest ||
        artifact.sourceBinding.specDigest !== admission.record.specDigest ||
        artifact.sourceBinding.canonicalSemanticDigest !== semanticIntentCanonicalDigestV3(admission.spec) ||
        artifact.sourceBinding.semanticSchemaVersion !== admission.spec.schemaVersion ||
        artifact.sourceBinding.sourceContractVersion !== admission.spec.sourceContractVersion ||
        artifact.sourceBinding.admissionVersion !== admission.record.admissionVersion ||
        artifact.profileBinding.profileId !== admission.spec.executionProfileRef.id ||
        artifact.profileBinding.profileVersion !== admission.spec.executionProfileRef.version ||
        artifact.profileBinding.profileFingerprint !== artifact.trace.profileFingerprint)
      throw new Error('SEMANTIC_GROUNDED_TRACE_BINDING_MISMATCH');
    const parsed = parseSemanticGroundedTraceV1(artifact.trace, admission);
    // The domain issuer validates inline witness/evidence/receipt digests and gives the
    // parsed historical trace a new in-process issuer mark. It grants no browser authority.
    const reissued = issueSemanticGroundedTraceV1(admission, {
      attemptId: parsed.attemptId, sessionId: parsed.sessionId,
      profileFingerprint: parsed.profileFingerprint, records: parsed.records,
    });
    if (reissued.traceDigest !== parsed.traceDigest)
      throw new Error('SEMANTIC_GROUNDED_TRACE_REISSUE_MISMATCH');
    deepFreeze(admission.spec);
    deepFreeze(admission.record);
    deepFreeze(reissued);
    return reissued;
  }
}
