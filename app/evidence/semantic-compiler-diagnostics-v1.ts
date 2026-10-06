import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { requireTrustedSemanticIntentAdmissionV3, type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { parseSemanticGroundedTraceV1, requireIssuedSemanticGroundedTraceV1,
  type SemanticGroundedTraceV1, type SemanticCompilerAttemptV5 } from '../domain/semantic-resolved-v10.js';
import { requireSemanticCompilerRejectionV1, type SemanticCompilerRejectionV1 } from
  '../exploration/semantic-trace-compiler-v5.js';
import { requireIssuedSemanticCompilationV5, requireSemanticCompilerSealedStepsV5 } from
  '../exploration/semantic-trace-compiler-v5.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.enum(['SOURCE_WITNESS_EXPIRED', 'TRACE_LINEAGE_MISMATCH', 'TRACE_VERSION_MISMATCH',
  'STEP_CORRELATION_MISMATCH', 'CANDIDATE_DOMAIN_INVALID', 'ORDINAL_PROOF_INVALID',
  'RELATIONSHIP_PROOF_INVALID', 'MECHANIC_CAPABILITY_MISMATCH', 'ACTION_RECEIPT_INVALID',
  'OBSERVATION_WITNESS_INVALID', 'ASSERTION_PROJECTION_UNSUPPORTED', 'OPTION_VALUE_MISMATCH',
  'FRESHNESS_INVALID', 'INTEGRITY_FAILURE', 'UNKNOWN_COMPILER_REJECTION',
  'CURRENT_EVIDENCE_EXPIRED', 'FRESH_BROWSER_EVIDENCE_UNAVAILABLE',
  'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH', 'CURRENT_CANDIDATE_DOMAIN_DRIFT',
  'CURRENT_RELATIONSHIP_ORDINAL_DRIFT']);
const reason = z.enum(['SOURCE_MISMATCH', 'STALE_EVIDENCE', 'DOMAIN_MISMATCH', 'TARGET_MISMATCH',
  'CAPABILITY_MISMATCH', 'MECHANIC_MISMATCH', 'OPTION_MISMATCH', 'OBSERVATION_MISMATCH',
  'UNSUPPORTED_RELATIONSHIP', 'ENVIRONMENT_UNAVAILABLE', 'CLEANUP_UNVERIFIED']);
const phase = z.enum(['trace_lineage', 'protected_session', 'step_correlation', 'source_witness',
  'candidate_domain', 'source_freshness', 'action_mechanic', 'fresh_grounding', 'action_receipt',
  'observation_witness', 'assertion_projection', 'current_evidence_validation',
  'source_current_correspondence', 'current_freshness']);
const witnessVersion = z.enum(['semantic_action_grounding_v1', 'semantic_verification_grounding_v1']);
const mechanic = z.enum(['click', 'check', 'uncheck', 'select_option', 'fill']);
const observation = z.enum(['complete_count', 'boolean_property', 'value_property', 'url',
  'native_selected_option']);
const property = z.enum(['exists', 'visible', 'enabled', 'checked', 'selected', 'value', 'url',
  'cardinality']);
const safeStep = z.strictObject({ stepId: id, recordType: z.enum(['navigate', 'action', 'verification']),
  witnessVersion: witnessVersion.nullable(), evidenceVersion: z.literal('semantic_grounding_evidence_v1').nullable(),
  issuedAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime().nullable(),
  candidateCount: z.number().int().min(0).max(100).nullable(),
  selectedIndex: z.number().int().min(0).max(99).nullable(), ordinalProof: z.boolean(),
  authoredOrdinal: z.number().int().min(1).max(100).nullable(),
  ordinalCompleteCount: z.number().int().min(0).max(100).nullable(),
  relationshipProof: z.boolean(), relationshipKind: z.enum(['same_as_step', 'created_by_step']).nullable(),
  relatedStepId: id.nullable(), selectedIdentity: digest.nullable(),
  domainComplete: z.boolean(), mcpRevision: z.number().int().nonnegative().nullable(),
  dependencyReceiptDigest: digest.nullable(), mechanic: mechanic.nullable(), observation: observation.nullable(),
  property: property.nullable(), boundedSettlingAuthorized: z.boolean(),
  observedBoolean: z.boolean().nullable(), observedCount: z.number().int().min(0).max(10000).nullable(),
  expectedSatisfied: z.boolean().nullable(), settled: z.boolean().nullable(),
  actionEffect: z.enum(['delivery_only', 'state_proven']).nullable() });
const traceData = z.strictObject({ recordVersion: z.literal('semantic_compiler_trace_diagnostic_v1'),
  workflowVersion: z.literal('semantic-general-v1'), traceVersion: z.literal('semantic_grounded_trace_v1'),
  traceId: id, traceDigest: digest, testSpecId: id, groundingAttemptId: id,
  profileFingerprint: digest, admissionDigest: digest, steps: z.array(safeStep).min(1).max(100) });
const rejectionData = z.strictObject({ recordVersion: z.literal('semantic_compiler_rejection_diagnostic_v1'),
  workflowVersion: z.literal('semantic-general-v1'), compilerVersion: z.literal('5'),
  compilerAttemptId: id, traceId: id, traceDigest: digest, testSpecId: id,
  attemptDigest: digest, failingStepId: id.nullable(), phase, code, category: reason,
  witnessVersion: witnessVersion.nullable(), witnessIssuedAt: z.iso.datetime().nullable(),
  witnessExpiresAt: z.iso.datetime().nullable(), validatedAt: z.iso.datetime(),
  ageMs: z.number().finite().nullable(), lifetimeMs: z.number().finite().nullable(),
  expired: z.boolean().nullable(), expectedIdentity: z.string().max(80).nullable(),
  actualIdentity: z.string().max(80).nullable(), candidateCount: z.number().int().min(0).max(100).nullable(),
  selectedIndex: z.number().int().min(0).max(99).nullable(), ordinalProof: z.boolean(),
  relationshipProof: z.boolean(), mechanic: mechanic.nullable(), expectedMechanic: mechanic.nullable(),
  observation: observation.nullable(), property: property.nullable(), expectedProperty: property.nullable(),
  boundedSettlingAuthorized: z.boolean(), expectedSatisfied: z.boolean().nullable(),
  settled: z.boolean().nullable() });
const sealedStep = z.strictObject({
  compilerAttemptId: id, testSpecId: id, traceDigest: digest, stepId: id,
  recordType: z.enum(['navigate', 'action', 'verification']),
  sourceWitnessDigest: digest, currentWitnessDigest: digest.nullable(),
  currentEvidenceIssuedAt: z.iso.datetime().nullable(),
  currentEvidenceExpiresAt: z.iso.datetime().nullable(),
  currentEvidenceAgeAtUseMs: z.number().finite().nullable(),
  validatedAt: z.iso.datetime(), sourceCurrentCorrespondence: z.boolean().nullable(),
  resolvedStepDigest: digest, sealDigest: digest,
});
const rejectionDataV2 = rejectionData.omit({ recordVersion: true }).extend({
  recordVersion: z.literal('semantic_compiler_rejection_diagnostic_v2'),
  currentEvidenceIssuedAt: z.iso.datetime().nullable(),
  currentEvidenceExpiresAt: z.iso.datetime().nullable(),
  currentEvidenceValidatedAt: z.iso.datetime().nullable(),
  currentEvidenceAgeMs: z.number().finite().nullable(),
  currentEvidenceExpired: z.boolean().nullable(),
  sourceCurrentCorrespondence: z.boolean().nullable(),
  // Optional for authenticated v2 records written before point-of-use sealing.
  sealedSteps: z.array(sealedStep).max(100).optional(),
  allStepsSealed: z.boolean().optional(),
  consumedEvidenceRefreshedAtFinalSeal: z.literal(false).optional(),
});
const sealData = z.strictObject({ recordVersion: z.literal('semantic_compiler_seal_diagnostic_v1'),
  workflowVersion: z.literal('semantic-general-v1'), compilerVersion: z.literal('5'),
  compilerAttemptId: id, traceId: id, traceDigest: digest, testSpecId: id,
  attemptDigest: digest, allStepsSealed: z.literal(true),
  consumedEvidenceRefreshedAtFinalSeal: z.literal(false),
  sealedSteps: z.array(sealedStep).min(1).max(100) });
const data = z.discriminatedUnion('recordVersion', [traceData, rejectionData, rejectionDataV2, sealData]);
const envelope = z.strictObject({ data, authentication: digest });
export type SemanticCompilerDiagnosticReadbackV1 = z.infer<typeof data>;
export type SemanticCompilerDiagnosticQueryV1 = { compilerAttemptId?: string; traceId?: string; testSpecId?: string };
const namespace = 'semantic-compiler-diagnostics-v1';
const maxPerKind = 64;

function projectTrace(trace: SemanticGroundedTraceV1): z.infer<typeof traceData> {
  return traceData.parse({ recordVersion: 'semantic_compiler_trace_diagnostic_v1',
    workflowVersion: 'semantic-general-v1', traceVersion: trace.traceVersion,
    traceId: `semantic-trace-${trace.traceDigest.slice(0, 32)}`, traceDigest: trace.traceDigest,
    testSpecId: trace.testSpecId, groundingAttemptId: trace.attemptId,
    profileFingerprint: trace.profileFingerprint, admissionDigest: trace.admissionDigest,
    steps: trace.records.map(record => {
      if (record.type === 'navigate') return { stepId: record.step.id, recordType: 'navigate',
        witnessVersion: null, evidenceVersion: null, issuedAt: null, expiresAt: null,
        candidateCount: null, selectedIndex: null, ordinalProof: false, authoredOrdinal: null,
        ordinalCompleteCount: null, relationshipProof: false, relationshipKind: null,
        relatedStepId: null, selectedIdentity: null, domainComplete: false, mcpRevision: null,
        dependencyReceiptDigest: null,
        mechanic: null, observation: null, property: null, boundedSettlingAuthorized: false,
        observedBoolean: null, observedCount: null, expectedSatisfied: null,
        settled: null, actionEffect: null };
      const witness = record.witness, evidence = witness.evidence;
      return { stepId: witness.step.id, recordType: record.type, witnessVersion: witness.witnessVersion,
        evidenceVersion: evidence.evidenceVersion, issuedAt: evidence.observedAt, expiresAt: evidence.expiresAt,
        candidateCount: evidence.candidates.length, selectedIndex: evidence.selectedDomainIndex,
        ordinalProof: evidence.ordinalProof !== null,
        authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? null,
        ordinalCompleteCount: evidence.ordinalProof?.completeDomainCount ?? null,
        relationshipProof: evidence.relationProof !== null,
        relationshipKind: evidence.relationProof?.kind ?? null,
        relatedStepId: evidence.relationProof?.relatedStepId ?? null,
        selectedIdentity: evidence.selectedDomainIndex === null ? null :
          evidence.candidates[evidence.selectedDomainIndex]?.identity ?? null,
        domainComplete: evidence.domainComplete, mcpRevision: evidence.mcpRevision,
        dependencyReceiptDigest: evidence.dependentActionReceiptDigest,
        mechanic: witness.witnessVersion === 'semantic_action_grounding_v1' ? witness.mechanic : null,
        observation: witness.witnessVersion === 'semantic_verification_grounding_v1' ? witness.observation : null,
        property: witness.witnessVersion === 'semantic_verification_grounding_v1' ? witness.property : null,
        boundedSettlingAuthorized: witness.step.dependsOnStepId !== null,
        observedBoolean: witness.witnessVersion === 'semantic_verification_grounding_v1' &&
          typeof witness.observed === 'boolean' ? witness.observed : null,
        observedCount: witness.witnessVersion === 'semantic_verification_grounding_v1' &&
          typeof witness.observed === 'number' ? witness.observed : null,
        expectedSatisfied: witness.witnessVersion === 'semantic_verification_grounding_v1' ?
          witness.expectedSatisfied : null,
        settled: witness.witnessVersion === 'semantic_verification_grounding_v1' ? witness.settled : null,
        actionEffect: record.type === 'action' ? record.receipt.effectStatus : null };
    }) });
}

function projectRejection(trace: SemanticGroundedTraceV1, attempt: SemanticCompilerAttemptV5,
  diagnostic: SemanticCompilerRejectionV1): z.infer<typeof rejectionDataV2> {
  if (attempt.result.status !== 'rejected' || attempt.traceDigest !== trace.traceDigest ||
      attempt.testSpecId !== trace.testSpecId || attempt.compilerVersion !== '5')
    throw new Error('INVALID_SEMANTIC_REJECTION_CORRELATION');
  return rejectionDataV2.parse({ recordVersion: 'semantic_compiler_rejection_diagnostic_v2',
    workflowVersion: 'semantic-general-v1', compilerVersion: '5',
    compilerAttemptId: attempt.compilerAttemptId, traceId: `semantic-trace-${trace.traceDigest.slice(0, 32)}`,
    traceDigest: trace.traceDigest, testSpecId: trace.testSpecId, attemptDigest: attempt.attemptDigest,
    failingStepId: diagnostic.stepId, phase: diagnostic.phase, code: diagnostic.code,
    category: diagnostic.category, witnessVersion: diagnostic.witnessVersion,
    witnessIssuedAt: diagnostic.witnessIssuedAt, witnessExpiresAt: diagnostic.witnessExpiresAt,
    validatedAt: diagnostic.validatedAt, ageMs: diagnostic.ageMs, lifetimeMs: diagnostic.lifetimeMs,
    expired: diagnostic.expired, expectedIdentity: diagnostic.expectedIdentity,
    actualIdentity: diagnostic.actualIdentity, candidateCount: diagnostic.candidateCount,
    selectedIndex: diagnostic.selectedIndex, ordinalProof: diagnostic.ordinalProof,
    relationshipProof: diagnostic.relationshipProof, mechanic: diagnostic.mechanic,
    expectedMechanic: diagnostic.expectedMechanic, observation: diagnostic.observation,
    property: diagnostic.property, expectedProperty: diagnostic.expectedProperty,
    boundedSettlingAuthorized: diagnostic.boundedSettlingAuthorized,
    expectedSatisfied: diagnostic.expectedSatisfied,
    settled: diagnostic.settled,
    currentEvidenceIssuedAt: diagnostic.currentEvidenceIssuedAt,
    currentEvidenceExpiresAt: diagnostic.currentEvidenceExpiresAt,
    currentEvidenceValidatedAt: diagnostic.currentEvidenceValidatedAt,
    currentEvidenceAgeMs: diagnostic.currentEvidenceAgeMs,
    currentEvidenceExpired: diagnostic.currentEvidenceExpired,
    sourceCurrentCorrespondence: diagnostic.sourceCurrentCorrespondence,
    sealedSteps: diagnostic.sealedSteps, allStepsSealed: diagnostic.allStepsSealed,
    consumedEvidenceRefreshedAtFinalSeal: diagnostic.consumedEvidenceRefreshedAtFinalSeal });
}
function projectAcceptedSeal(trace: SemanticGroundedTraceV1,
  compilation: object & { compiler: SemanticCompilerAttemptV5 }): z.infer<typeof sealData> {
  requireIssuedSemanticCompilationV5(compilation);
  const attempt = compilation.compiler;
  if (attempt.result.status !== 'accepted' || attempt.traceDigest !== trace.traceDigest ||
      attempt.testSpecId !== trace.testSpecId || attempt.compilerVersion !== '5')
    throw new Error('INVALID_SEMANTIC_SEAL_CORRELATION');
  const seals = requireSemanticCompilerSealedStepsV5(compilation);
  if (seals.length !== trace.records.length) throw new Error('INCOMPLETE_SEMANTIC_COMPILER_SEALS');
  return sealData.parse({ recordVersion: 'semantic_compiler_seal_diagnostic_v1',
    workflowVersion: 'semantic-general-v1', compilerVersion: '5',
    compilerAttemptId: attempt.compilerAttemptId,
    traceId: `semantic-trace-${trace.traceDigest.slice(0, 32)}`,
    traceDigest: trace.traceDigest, testSpecId: trace.testSpecId,
    attemptDigest: attempt.attemptDigest, allStepsSealed: true,
    consumedEvidenceRefreshedAtFinalSeal: false, sealedSteps: seals });
}

/** Private, bounded, authenticated diagnostics; never confers resolved artifact or QA authority. */
export class SemanticCompilerDiagnosticsV1Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(create: boolean): Promise<string> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Diagnostic root symlink');
    const directory = path.join(this.#root, namespace);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of [this.#root, directory]) {
      const info = await lstat(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid diagnostic directory');
    }
    return directory;
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(true);
      const file = path.join(this.#root, '.semantic-compiler-v5-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error('Invalid diagnostic authority');
      return readFile(file);
    })();
    return this.#key;
  }
  async #write(prefix: 'trace' | 'rejection' | 'seal', name: string,
    value: SemanticCompilerDiagnosticReadbackV1): Promise<void> {
    const directory = await this.#directory(true);
    const file = path.join(directory, `${prefix}-${id.parse(name)}.json`);
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(value)).digest('hex');
    const temp = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ data: value, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await link(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          JSON.stringify(await this.#read(file)) !== JSON.stringify(value)) throw error;
    } finally { await unlink(temp); }
    await this.#prune(prefix, directory);
  }
  async #prune(prefix: 'trace' | 'rejection' | 'seal', directory: string): Promise<void> {
    const names = (await readdir(directory)).filter(name => name.startsWith(`${prefix}-`) && name.endsWith('.json'));
    if (names.length <= maxPerKind) return;
    const ordered = await Promise.all(names.map(async name => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
    ordered.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
    for (const entry of ordered.slice(0, ordered.length - maxPerKind)) {
      const file = path.join(directory, entry.name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostic file');
      await unlink(file);
    }
  }
  async writeTrace(trace: SemanticGroundedTraceV1, admission: TrustedSemanticIntentAdmissionV3): Promise<void> {
    requireTrustedSemanticIntentAdmissionV3(admission);
    requireIssuedSemanticGroundedTraceV1(trace);
    await this.#write('trace', `semantic-trace-${trace.traceDigest.slice(0, 32)}`,
      projectTrace(parseSemanticGroundedTraceV1(trace, admission)));
  }
  async writeRejection(compilation: object & { compiler: SemanticCompilerAttemptV5 },
    trace: SemanticGroundedTraceV1): Promise<void> {
    requireIssuedSemanticGroundedTraceV1(trace);
    await this.#write('rejection', compilation.compiler.compilerAttemptId,
      projectRejection(trace, compilation.compiler, requireSemanticCompilerRejectionV1(compilation)));
  }
  async writeAcceptedSeal(compilation: object & { compiler: SemanticCompilerAttemptV5 },
    trace: SemanticGroundedTraceV1): Promise<void> {
    requireIssuedSemanticGroundedTraceV1(trace);
    await this.#write('seal', compilation.compiler.compilerAttemptId,
      projectAcceptedSeal(trace, compilation));
  }
  async #read(file: string): Promise<SemanticCompilerDiagnosticReadbackV1> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('Invalid diagnostic file');
    const record = envelope.parse(JSON.parse((await readFile(file)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(record.data)).digest();
    if (!timingSafeEqual(Buffer.from(record.authentication, 'hex'), expected))
      throw new Error('INVALID_SEMANTIC_DIAGNOSTIC_AUTHENTICATION');
    return record.data;
  }
  /** Trusted caller only: bounded safe fields; no raw trace, candidate text, DOM, or errors. */
  async readByCorrelation(query: SemanticCompilerDiagnosticQueryV1): Promise<SemanticCompilerDiagnosticReadbackV1[]> {
    if (!query.compilerAttemptId && !query.traceId && !query.testSpecId)
      throw new Error('Semantic diagnostic correlation required');
    for (const value of [query.compilerAttemptId, query.traceId, query.testSpecId]) if (value) id.parse(value);
    const directory = await this.#directory(false);
    const names = (await readdir(directory)).filter(name => /^(trace|rejection|seal)-[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name));
    const results: SemanticCompilerDiagnosticReadbackV1[] = [];
    for (const name of names) {
      const record = await this.#read(path.join(directory, name));
       if (query.compilerAttemptId && (record.recordVersion !== 'semantic_compiler_rejection_diagnostic_v1' &&
           record.recordVersion !== 'semantic_compiler_rejection_diagnostic_v2' &&
           record.recordVersion !== 'semantic_compiler_seal_diagnostic_v1' ||
          record.compilerAttemptId !== query.compilerAttemptId) ||
        query.traceId && record.traceId !== query.traceId ||
        query.testSpecId && record.testSpecId !== query.testSpecId) continue;
      results.push(record);
    }
    return results;
  }
}
