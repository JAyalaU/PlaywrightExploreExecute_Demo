import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { admitSemanticIntentV3, requireTrustedSemanticIntentAdmissionV3,
  SemanticIntentAdmissionRecordV3Schema, SemanticIntentTestSpecV3Schema,
  type SemanticIntentTestSpecV3, type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { canonicalizeSemanticRelationsV3,
  semanticIntentCanonicalDigestV3 } from '../interpretation/semantic-intent-v3-relations.js';

const namespace = 'admitted-semantic-test-spec-v7';
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const provenance = z.strictObject({
  relationCanonicalizationVersion: z.literal('semantic_relation_canonicalization_v1'),
  canonicalValidationVersion: z.literal('semantic_intent_canonical_validation_v3'),
  fidelityContractVersion: z.literal('qa_deferred_semantic_intent_fidelity_v2'),
  admissionContractVersion: z.literal('3'),
});
const envelope = z.strictObject({
  storageVersion: z.literal('1'), namespace: z.literal(namespace), testSpecId: id,
  semanticSchemaVersion: z.literal('7'), sourceContractVersion: z.literal('3'),
  sourceBinding: z.strictObject({ sourceDigest: digest, testSpecId: id,
    sourceContractVersion: z.literal('3') }),
  canonicalSemanticDigest: digest, provenance,
  spec: SemanticIntentTestSpecV3Schema, admission: SemanticIntentAdmissionRecordV3Schema,
  authentication: digest,
});
type Envelope = z.infer<typeof envelope>;
type Data = Omit<Envelope, 'authentication'>;
export type AdmittedSemanticTestSpecV7ArtifactRef = Readonly<{
  testSpecId: string; path: string; canonicalSemanticDigest: string;
}>;

function sourceOf(spec: SemanticIntentTestSpecV3) {
  return { testSpecId: spec.testSpecId, sourceInstruction: spec.sourceInstruction,
    executionProfileRef: spec.executionProfileRef, startState: spec.startState };
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
}
function reissueAndCheck(spec: SemanticIntentTestSpecV3, record: Envelope['admission']):
  TrustedSemanticIntentAdmissionV3 {
  if (!equal(canonicalizeSemanticRelationsV3(sourceOf(spec), spec), spec))
    throw new Error('NONCANONICAL_ADMITTED_SEMANTIC_SPEC');
  const issued = admitSemanticIntentV3(sourceOf(spec), spec, { verdict: 'faithful', issues: [] });
  if (!equal(issued.record, record)) throw new Error('SEMANTIC_ADMISSION_PROVENANCE_MISMATCH');
  deepFreeze(issued.spec);
  deepFreeze(issued.record);
  return issued;
}
async function regular(file: string, limit: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('INVALID_ADMITTED_SEMANTIC_FILE');
  return readFile(file);
}

/** Root-local authenticated, immutable admitted semantic intent. No browser evidence is stored. */
export class AdmittedSemanticTestSpecV7Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(artifactRoot: string) { this.#root = path.resolve(artifactRoot); }

  async #directory(directory: string, create: boolean): Promise<void> {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '')
      throw new Error('ADMITTED_SEMANTIC_ROOT_SYMLINK');
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('ADMITTED_SEMANTIC_PATH_OUTSIDE_ROOT');
    let checked = this.#root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) checked = path.join(checked, segment);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('INVALID_ADMITTED_SEMANTIC_DIRECTORY');
    }
  }

  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(this.#root, true);
      const file = path.join(this.#root, '.admitted-semantic-v7-authority');
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const key = await regular(file, 32);
      if (key.length !== 32) throw new Error('INVALID_ADMITTED_SEMANTIC_AUTHORITY');
      return key;
    })();
    return this.#key;
  }

  #file(testSpecId: string): string {
    return path.join(this.#root, namespace, `${id.parse(testSpecId)}.json`);
  }

  async writeAdmittedV7(admission: TrustedSemanticIntentAdmissionV3):
    Promise<AdmittedSemanticTestSpecV7ArtifactRef> {
    requireTrustedSemanticIntentAdmissionV3(admission);
    const spec = SemanticIntentTestSpecV3Schema.parse(structuredClone(admission.spec));
    const record = SemanticIntentAdmissionRecordV3Schema.parse(structuredClone(admission.record));
    // The issued capability is shallow frozen; reject mutation of nested steps after admission.
    reissueAndCheck(spec, record);
    const data: Data = {
      storageVersion: '1', namespace, testSpecId: spec.testSpecId,
      semanticSchemaVersion: spec.schemaVersion, sourceContractVersion: spec.sourceContractVersion,
      sourceBinding: { sourceDigest: record.sourceDigest, testSpecId: spec.testSpecId,
        sourceContractVersion: spec.sourceContractVersion },
      canonicalSemanticDigest: semanticIntentCanonicalDigestV3(spec), provenance: {
        relationCanonicalizationVersion: 'semantic_relation_canonicalization_v1',
        canonicalValidationVersion: 'semantic_intent_canonical_validation_v3',
        fidelityContractVersion: 'qa_deferred_semantic_intent_fidelity_v2',
        admissionContractVersion: '3',
      }, spec, admission: record,
    };
    const authentication = createHmac('sha256', await this.#authority())
      .update(JSON.stringify(data)).digest('hex');
    const file = this.#file(spec.testSpecId);
    await this.#directory(path.dirname(file), true);
    const pending = path.join(path.dirname(file), `.pending-${randomUUID()}`);
    const handle = await open(pending, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(pending, file); } finally { await unlink(pending); }
    await this.readAdmittedV7(spec.testSpecId);
    return Object.freeze({ testSpecId: spec.testSpecId, path: file,
      canonicalSemanticDigest: data.canonicalSemanticDigest });
  }

  async readAdmittedV7(testSpecId: string): Promise<TrustedSemanticIntentAdmissionV3> {
    const file = this.#file(testSpecId);
    await this.#directory(path.dirname(file), false);
    const parsed: unknown = JSON.parse((await regular(file, 1024 * 1024)).toString('utf8'));
    const artifact = envelope.parse(parsed);
    const { authentication, ...data } = artifact;
    const expected = createHmac('sha256', await this.#authority())
      .update(JSON.stringify(data)).digest();
    if (!timingSafeEqual(Buffer.from(authentication, 'hex'), expected))
      throw new Error('UNAUTHENTICATED_ADMITTED_SEMANTIC_ARTIFACT');
    if (artifact.testSpecId !== testSpecId || artifact.spec.testSpecId !== testSpecId ||
        artifact.sourceBinding.testSpecId !== testSpecId ||
        artifact.semanticSchemaVersion !== artifact.spec.schemaVersion ||
        artifact.sourceContractVersion !== artifact.spec.sourceContractVersion ||
        artifact.sourceBinding.sourceContractVersion !== artifact.spec.sourceContractVersion ||
        artifact.sourceBinding.sourceDigest !== artifact.admission.sourceDigest)
      throw new Error('ADMITTED_SEMANTIC_OWNER_MISMATCH');
    if (semanticIntentCanonicalDigestV3(artifact.spec) !== artifact.canonicalSemanticDigest)
      throw new Error('ADMITTED_SEMANTIC_DIGEST_MISMATCH');
    return reissueAndCheck(artifact.spec, artifact.admission);
  }
}
