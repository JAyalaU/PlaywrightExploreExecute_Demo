import { randomUUID } from 'node:crypto';
import type { TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { requireTrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { parseSemanticGroundingWitnessV1, semanticGroundingDigestV1 as hash,
  type SemanticGroundingWitnessV1, type SemanticGroundingCandidateV1 } from '../domain/semantic-grounding-v1.js';
import { parseSemanticGroundedTraceV1, requireIssuedSemanticGroundedTraceV1,
  sealSemanticCompilerAttemptV5, sealSemanticResolvedTestSpecV10, parseSemanticResolvedTestSpecV10,
  semanticResolvedRolesV10, SemanticResolvedStepV10Schema,
  type SemanticGroundedTraceV1, type SemanticResolvedStepV10,
  type SemanticCompilerAttemptV5, type SemanticResolvedTestSpecV10 } from '../domain/semantic-resolved-v10.js';
import { ProtectedContextFactory } from '../profile/index.js';
import { McpExplorationSession } from './mcp.js';
import { SemanticGroundingSessionV1, SemanticGroundingStopV1 } from './semantic-grounding-v1.js';

type Reason = Extract<SemanticCompilerAttemptV5['result'], { status: 'rejected' }>['reason'];
export type SemanticCompilerRejectionCodeV1 = 'SOURCE_WITNESS_EXPIRED' | 'TRACE_LINEAGE_MISMATCH' |
  'TRACE_VERSION_MISMATCH' | 'STEP_CORRELATION_MISMATCH' | 'CANDIDATE_DOMAIN_INVALID' |
  'ORDINAL_PROOF_INVALID' | 'RELATIONSHIP_PROOF_INVALID' | 'MECHANIC_CAPABILITY_MISMATCH' |
  'ACTION_RECEIPT_INVALID' | 'OBSERVATION_WITNESS_INVALID' | 'ASSERTION_PROJECTION_UNSUPPORTED' |
  'OPTION_VALUE_MISMATCH' | 'FRESHNESS_INVALID' | 'INTEGRITY_FAILURE' | 'UNKNOWN_COMPILER_REJECTION' |
  'CURRENT_EVIDENCE_EXPIRED' | 'FRESH_BROWSER_EVIDENCE_UNAVAILABLE' |
  'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH' | 'CURRENT_CANDIDATE_DOMAIN_DRIFT' |
  'CURRENT_RELATIONSHIP_ORDINAL_DRIFT';
export type SemanticCompilerRejectionV1 = {
  code: SemanticCompilerRejectionCodeV1; category: Reason; phase: string;
  stepId: string | null; witnessVersion: string | null; witnessIssuedAt: string | null;
  witnessExpiresAt: string | null; validatedAt: string; ageMs: number | null;
  lifetimeMs: number | null; expired: boolean | null; expectedIdentity: string | null;
  actualIdentity: string | null; candidateCount: number | null; selectedIndex: number | null;
  ordinalProof: boolean; relationshipProof: boolean; mechanic: string | null;
  expectedMechanic: string | null; observation: string | null; property: string | null;
  expectedProperty: string | null; boundedSettlingAuthorized: boolean;
  expectedSatisfied: boolean | null; settled: boolean | null;
  currentEvidenceIssuedAt: string | null; currentEvidenceExpiresAt: string | null;
  currentEvidenceValidatedAt: string | null; currentEvidenceAgeMs: number | null;
  currentEvidenceExpired: boolean | null; sourceCurrentCorrespondence: boolean | null;
  sealedSteps: SemanticCompilerSealedStepV5[]; allStepsSealed: boolean;
  consumedEvidenceRefreshedAtFinalSeal: false;
};
export type SemanticCompilerSealedStepV5 = Readonly<{
  compilerAttemptId: string; testSpecId: string; traceDigest: string;
  stepId: string; recordType: SemanticGroundedTraceV1['records'][number]['type'];
  sourceWitnessDigest: string; currentWitnessDigest: string | null;
  currentEvidenceIssuedAt: string | null; currentEvidenceExpiresAt: string | null;
  currentEvidenceAgeAtUseMs: number | null; validatedAt: string;
  sourceCurrentCorrespondence: boolean | null; resolvedStepDigest: string;
  sealDigest: string;
}>;
type SealData = Omit<SemanticCompilerSealedStepV5, 'sealDigest'>;
function sealStep(data: SealData): SemanticCompilerSealedStepV5 {
  return Object.freeze({ ...data, sealDigest: hash(data) });
}
/** In-process compiler integrity check; seals are never an external artifact or QA authority. */
export function validateSemanticCompilerSealedSequenceV5(records: SemanticGroundedTraceV1['records'],
  steps: SemanticResolvedStepV10[], seals: readonly SemanticCompilerSealedStepV5[],
  compilerAttemptId: string, testSpecId: string, traceDigest: string): void {
  if (records.length !== steps.length || seals.length !== steps.length)
    fail('SOURCE_MISMATCH', 'INTEGRITY_FAILURE');
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!, step = steps[index]!, seal = seals[index]!;
    const { sealDigest, ...data } = seal;
    if (sealDigest !== hash(data) || seal.compilerAttemptId !== compilerAttemptId ||
        seal.testSpecId !== testSpecId || seal.traceDigest !== traceDigest ||
        seal.stepId !== step.stepId || seal.stepId !== (record.type === 'navigate' ?
          record.step.id : record.witness.step.id) ||
        seal.recordType !== record.type || seal.resolvedStepDigest !== hash(step) ||
        seal.sourceWitnessDigest !== step.sourceWitnessDigest ||
        seal.sourceWitnessDigest !== (record.type === 'navigate' ? hash(record) : record.witness.witnessDigest) ||
        !Number.isFinite(Date.parse(seal.validatedAt)))
      fail('SOURCE_MISMATCH', 'INTEGRITY_FAILURE');
    if (record.type === 'navigate') {
      if (seal.currentWitnessDigest !== null || seal.currentEvidenceIssuedAt !== null ||
          seal.currentEvidenceExpiresAt !== null || seal.currentEvidenceAgeAtUseMs !== null ||
          seal.sourceCurrentCorrespondence !== null) fail('SOURCE_MISMATCH', 'INTEGRITY_FAILURE');
    } else if (!seal.currentWitnessDigest || seal.sourceCurrentCorrespondence !== true ||
        !seal.currentEvidenceIssuedAt || !seal.currentEvidenceExpiresAt ||
        seal.currentEvidenceAgeAtUseMs === null || seal.currentEvidenceAgeAtUseMs < 0 ||
        seal.currentEvidenceAgeAtUseMs > 10_000 ||
        Date.parse(seal.currentEvidenceExpiresAt) - Date.parse(seal.currentEvidenceIssuedAt) !== 10_000 ||
        Date.parse(seal.validatedAt) - Date.parse(seal.currentEvidenceIssuedAt) !==
          seal.currentEvidenceAgeAtUseMs)
      fail('SOURCE_MISMATCH', 'INTEGRITY_FAILURE');
  }
}
class Stop extends Error {
  constructor(readonly reason: Reason, readonly code?: SemanticCompilerRejectionCodeV1) { super(reason); }
}
const fail = (reason: Reason, code?: SemanticCompilerRejectionCodeV1): never => { throw new Stop(reason, code); };
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const issuedCompilations = new WeakSet<object>();
const acceptedSeals = new WeakMap<object, readonly SemanticCompilerSealedStepV5[]>();
const rejectedDiagnostics = new WeakMap<object, SemanticCompilerRejectionV1>();
export function requireSemanticCompilerRejectionV1(compilation: object): SemanticCompilerRejectionV1 {
  const diagnostic = rejectedDiagnostics.get(compilation);
  if (!diagnostic) throw new Error('UNTRUSTED_SEMANTIC_COMPILER_REJECTION');
  return structuredClone(diagnostic);
}
function rejectionCode(reason: Reason, phase: string): SemanticCompilerRejectionCodeV1 {
  if (phase === 'trace_lineage') return 'TRACE_LINEAGE_MISMATCH';
  if (phase === 'action_receipt') return 'ACTION_RECEIPT_INVALID';
  if (phase === 'assertion_projection') return 'ASSERTION_PROJECTION_UNSUPPORTED';
  switch (reason) {
    case 'DOMAIN_MISMATCH': case 'TARGET_MISMATCH': return 'CANDIDATE_DOMAIN_INVALID';
    case 'UNSUPPORTED_RELATIONSHIP': return 'RELATIONSHIP_PROOF_INVALID';
    case 'MECHANIC_MISMATCH': case 'CAPABILITY_MISMATCH': return 'MECHANIC_CAPABILITY_MISMATCH';
    case 'OPTION_MISMATCH': return 'OPTION_VALUE_MISMATCH';
    case 'OBSERVATION_MISMATCH': return 'OBSERVATION_WITNESS_INVALID';
    case 'STALE_EVIDENCE': return 'FRESHNESS_INVALID';
    case 'SOURCE_MISMATCH': return 'STEP_CORRELATION_MISMATCH';
    default: return 'UNKNOWN_COMPILER_REJECTION';
  }
}
/** In-process compiler origin for the v10 trusted handoff; a digest alone is not authority. */
export function requireIssuedSemanticCompilationV5(value: object): void {
  if (!issuedCompilations.has(value)) throw new Error('UNTRUSTED_SEMANTIC_COMPILATION_V5');
}
export function requireSemanticCompilerSealedStepsV5(compilation: object): readonly SemanticCompilerSealedStepV5[] {
  const seals = acceptedSeals.get(compilation);
  if (!seals || !issuedCompilations.has(compilation))
    throw new Error('UNTRUSTED_SEMANTIC_COMPILER_SEALS');
  return structuredClone(seals);
}

function expectedIdentity(candidate: SemanticGroundingCandidateV1): string {
  return hash({ frameIndex: candidate.frameIndex, frameUrl: candidate.frameUrl,
    path: candidate.domPath, role: candidate.role, name: candidate.name,
    tag: candidate.tag, inputType: candidate.inputType });
}
function selected(witness: SemanticGroundingWitnessV1): SemanticGroundingCandidateV1 {
  const index = witness.evidence.selectedDomainIndex;
  if (index === null) throw new Stop('TARGET_MISMATCH');
  const candidate = witness.evidence.candidates[index];
  if (!candidate || candidate.domainIndex !== index) throw new Stop('TARGET_MISMATCH');
  return candidate;
}
function validateEvidence(witness: SemanticGroundingWitnessV1): void {
  const { evidence, step } = witness;
  const target = step.type === 'action_intent' ? step.target :
    step.type === 'verification_intent' ? step.subject : null;
  if (!same(evidence.target, target) && !(step.type === 'verification_intent' &&
      step.observable === 'selected')) fail('SOURCE_MISMATCH');
  if (evidence.candidates.some((candidate, index) => candidate.domainIndex !== index ||
      candidate.frameIndex !== 0 || candidate.frameUrl !== evidence.pageUrl ||
      candidate.identity !== expectedIdentity(candidate))) fail('DOMAIN_MISMATCH');
  if (new Set(evidence.candidates.map((candidate) => candidate.identity)).size !== evidence.candidates.length)
    fail('DOMAIN_MISMATCH');
  const index = evidence.selectedDomainIndex;
  if (index !== null && index >= evidence.candidates.length) fail('TARGET_MISMATCH');
  if (target?.ordinal !== null && target?.ordinal !== undefined) {
    if (!evidence.ordinalProof || evidence.ordinalProof.authoredOrdinal !== target.ordinal ||
        evidence.ordinalProof.completeDomainCount !== evidence.candidates.length ||
        evidence.ordinalProof.selectedDomainIndex !== target.ordinal - 1 || index !== target.ordinal - 1)
      fail('DOMAIN_MISMATCH', 'ORDINAL_PROOF_INVALID');
  } else if (evidence.ordinalProof) fail('SOURCE_MISMATCH');
  if (target?.relation === 'same_as_step' || target?.relation === 'created_by_step') {
    if (!evidence.relationProof || evidence.relationProof.kind !== target.relation ||
        evidence.relationProof.relatedStepId !== target.relatedStepId ||
        evidence.relationProof.identity !== selected(witness).identity) fail('UNSUPPORTED_RELATIONSHIP');
  } else if (evidence.relationProof) fail('SOURCE_MISMATCH');
  if (step.type === 'action_intent' && index === null) fail('TARGET_MISMATCH');
  if (step.type === 'verification_intent' &&
      ['exists', 'cardinality', 'url'].includes(step.observable) && index !== null) fail('SOURCE_MISMATCH');
  if (step.type === 'verification_intent' &&
      !['exists', 'cardinality', 'url'].includes(step.observable) && index === null)
    fail('TARGET_MISMATCH');
}
function validateAction(witness: Extract<SemanticGroundingWitnessV1,
  { witnessVersion: 'semantic_action_grounding_v1' }>): void {
  if (witness.step.type !== 'action_intent') throw new Stop('SOURCE_MISMATCH');
  const step = witness.step, candidate = selected(witness);
  const mechanic = step.desiredEffect === 'activate' ? 'click' :
    step.desiredEffect === 'set_checked' ? step.checkedState ? 'check' : 'uncheck' :
    step.desiredEffect === 'choose' ? 'select_option' : 'fill';
  if (witness.mechanic !== mechanic || step.authoredMechanic && step.authoredMechanic !== mechanic)
    fail('MECHANIC_MISMATCH', 'MECHANIC_CAPABILITY_MISMATCH');
  if (!candidate.visible || !candidate.enabled) fail('CAPABILITY_MISMATCH');
  if (mechanic === 'click' && !['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch']
    .includes(candidate.role)) fail('CAPABILITY_MISMATCH');
  if (mechanic === 'check' || mechanic === 'uncheck') {
    if (candidate.tag !== 'input' || !['checkbox', 'radio'].includes(candidate.inputType) ||
        candidate.checked === null || mechanic === 'uncheck' && candidate.inputType === 'radio' ||
        witness.requestedChecked !== step.checkedState || witness.currentChecked !== candidate.checked ||
        witness.argument !== null || witness.optionProof !== null) fail('CAPABILITY_MISMATCH');
  } else if (mechanic === 'select_option') {
    const options = candidate.options.filter((option) => option.label === step.value && !option.disabled);
    if (!candidate.nativeSelect || candidate.multiple || options.length !== 1 || !witness.optionProof ||
        candidate.options.filter((option) => option.value === options[0]!.value).length !== 1 ||
        witness.argument !== options[0]!.value || witness.optionProof?.label !== step.value ||
        witness.optionProof.value !== witness.argument ||
        witness.optionProof.ownerIdentity !== candidate.identity || witness.optionProof.matchCount !== 1)
      fail('OPTION_MISMATCH');
  } else if (mechanic === 'fill') {
    if (!candidate.editable || candidate.value === null || witness.argument !== step.value ||
        witness.optionProof !== null) fail('CAPABILITY_MISMATCH');
  } else if (witness.argument !== null || witness.optionProof !== null) fail('SOURCE_MISMATCH');
}
function validateVerification(witness: Extract<SemanticGroundingWitnessV1,
  { witnessVersion: 'semantic_verification_grounding_v1' }>): void {
  if (witness.step.type !== 'verification_intent') throw new Stop('SOURCE_MISMATCH');
  const step = witness.step, candidates = witness.evidence.candidates;
  const observation = step.observable === 'exists' || step.observable === 'cardinality' ? 'complete_count' :
    step.observable === 'url' ? 'url' : step.observable === 'selected' ? 'native_selected_option' :
    step.observable === 'value' ? 'value_property' : 'boolean_property';
  if (witness.property !== step.observable || witness.observation !== observation)
    fail('OBSERVATION_MISMATCH');
  const observed = step.observable === 'exists' ? candidates.length > 0 :
    step.observable === 'cardinality' ? candidates.length : step.observable === 'url' ? witness.evidence.pageUrl :
    step.observable === 'selected' ? (() => {
      const candidate = selected(witness);
      if (!candidate.nativeSelect) fail('CAPABILITY_MISMATCH');
      const options = candidate.options.filter((option) => option.label === step.subject?.exactName);
      if (options.length !== 1) fail('OPTION_MISMATCH');
      return options[0]!.selected;
    })() : step.observable === 'value' ? selected(witness).value :
    step.observable === 'visible' ? selected(witness).visible :
    step.observable === 'enabled' ? selected(witness).enabled : selected(witness).checked;
  if (observed === null || witness.observed !== observed) fail('OBSERVATION_MISMATCH');
  const satisfied = step.comparator === 'equals' ? observed === step.expected :
    typeof observed === 'number' && typeof step.expected === 'number' &&
    (step.comparator === 'at_least' ? observed >= step.expected : observed <= step.expected);
  if (witness.expectedSatisfied !== satisfied || witness.settled && !satisfied)
    fail('OBSERVATION_MISMATCH');
}
function domainFor(witness: SemanticGroundingWitnessV1) {
  const evidence = witness.evidence;
  const target = witness.step.type === 'action_intent' ? witness.step.target :
    witness.step.type === 'verification_intent' ? witness.step.subject : null;
  const roles = witness.step.type === 'verification_intent' && witness.step.observable === 'selected' ?
    [...new Set(evidence.candidates.map((candidate) => candidate.role))] :
    semanticResolvedRolesV10(target, evidence.candidates.map((candidate) => candidate.role));
  if (!roles.length || evidence.candidates.some((candidate) => !roles.includes(candidate.role)) ||
      witness.step.type === 'verification_intent' &&
        ['exists', 'cardinality'].includes(witness.step.observable) && roles.includes('option'))
    fail('CAPABILITY_MISMATCH', 'ASSERTION_PROJECTION_UNSUPPORTED');
  return { domainVersion: 'semantic_candidate_domain_v1' as const, completeRequired: true as const,
    roles, exactName: witness.step.type === 'verification_intent' && witness.step.observable === 'selected' ?
      null : target?.exactName ?? null,
    context: witness.step.type === 'verification_intent' && witness.step.observable === 'selected' ?
      null : target?.context ?? null, groundedCount: evidence.candidates.length,
    requireGroundedCount: witness.step.type === 'action_intent' ||
      witness.step.type === 'verification_intent' && !['exists', 'cardinality'].includes(witness.step.observable),
    orderedIdentities: evidence.candidates.map((candidate) => candidate.identity),
    orderedDomPaths: evidence.candidates.map((candidate) => candidate.domPath),
    selectedIndex: evidence.selectedDomainIndex, ordinal: target?.ordinal ?? null,
    relation: evidence.relationProof ? { kind: evidence.relationProof.kind,
      relatedStepId: evidence.relationProof.relatedStepId,
      selectedIdentity: evidence.relationProof.identity } : null };
}
function targetFor(witness: SemanticGroundingWitnessV1) {
  const candidate = selected(witness);
  const target = witness.step.type === 'action_intent' ? witness.step.target :
    witness.step.type === 'verification_intent' ? witness.step.subject : null;
  const nativeSelected = witness.step.type === 'verification_intent' &&
    witness.step.observable === 'selected';
  return { role: candidate.role, name: candidate.name,
    exactName: nativeSelected ? null : target?.exactName ?? null,
    context: nativeSelected ? null : target?.context ?? null, contextProof: candidate.contextProof,
    frame: 'main' as const, domPath: candidate.domPath, identity: candidate.identity };
}
function resolvedFor(witness: SemanticGroundingWitnessV1): SemanticResolvedStepV10 {
  const base = { stepId: witness.step.id, source: 'authored' as const,
    sourceWitnessDigest: witness.witnessDigest };
  const domain = domainFor(witness);
  if (witness.witnessVersion === 'semantic_action_grounding_v1') return {
    ...base, type: 'action', operation: witness.mechanic,
    target: targetFor(witness), domain, argument: witness.argument,
    expectedChecked: witness.requestedChecked,
    option: witness.optionProof ? { label: witness.optionProof.label, value: witness.optionProof.value,
      ownerIdentity: witness.optionProof.ownerIdentity, uniqueOwnedMapping: true } : null };
  const step = witness.step;
  if (step.type !== 'verification_intent') throw new Stop('SOURCE_MISMATCH');
  const wait = { mode: step.dependsOnStepId ? 'bounded_resulting_state' as const : 'none' as const,
    timeoutSource: 'trusted_profile_wait_policy' as const };
  if (step.observable === 'url') return { ...base, type: 'assert_url', expected: step.expected as string, wait };
  if (step.observable === 'exists') return { ...base, type: 'assert_count', domain,
    operator: step.expected ? 'at_least' : 'equals', expected: step.expected ? 1 : 0, wait };
  if (step.observable === 'cardinality') return { ...base, type: 'assert_count', domain,
    operator: step.comparator, expected: step.expected as number, wait };
  if (step.observable === 'selected') {
    const candidate = selected(witness);
    const option = candidate.options.find((item) => item.label === step.subject?.exactName);
    if (!option) throw new Stop('OPTION_MISMATCH');
    return { ...base, type: 'assert_native_selected_option', domain, target: targetFor(witness),
      label: option.label, value: option.value, expected: step.expected as boolean, wait };
  }
  if (step.observable === 'value') return { ...base, type: 'assert_value', domain,
    target: targetFor(witness), expected: step.expected as string, wait };
  return { ...base, type: 'assert_boolean', domain, target: targetFor(witness),
    property: step.observable, expected: step.expected as boolean, wait };
}
function compareFresh(source: SemanticGroundingWitnessV1, fresh: SemanticGroundingWitnessV1): void {
  if (source.witnessVersion !== fresh.witnessVersion || !same(source.step, fresh.step))
    fail('SOURCE_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
  if (source.evidence.selectedDomainIndex !== fresh.evidence.selectedDomainIndex ||
      !same(source.evidence.ordinalProof, fresh.evidence.ordinalProof) ||
      !same(source.evidence.relationProof, fresh.evidence.relationProof))
    fail('DOMAIN_MISMATCH', 'CURRENT_RELATIONSHIP_ORDINAL_DRIFT');
  if (source.evidence.pageUrl !== fresh.evidence.pageUrl ||
      !same(source.evidence.candidates.map((c) => c.identity),
        fresh.evidence.candidates.map((c) => c.identity)))
    fail('DOMAIN_MISMATCH', 'CURRENT_CANDIDATE_DOMAIN_DRIFT');
  if (source.witnessVersion === 'semantic_action_grounding_v1' &&
      fresh.witnessVersion === 'semantic_action_grounding_v1') {
    if (source.mechanic !== fresh.mechanic)
      fail('MECHANIC_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
    if (source.argument !== fresh.argument || !same(source.optionProof, fresh.optionProof))
      fail('OPTION_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
  } else if (source.witnessVersion === 'semantic_verification_grounding_v1' &&
      fresh.witnessVersion === 'semantic_verification_grounding_v1') {
    if (source.observation !== fresh.observation || source.property !== fresh.property ||
        source.observed !== fresh.observed || source.expectedSatisfied !== fresh.expectedSatisfied)
      fail('OBSERVATION_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
    if (source.step.type === 'verification_intent' && source.step.observable === 'selected') {
      const label = source.step.subject?.exactName;
      const sourceOption = selected(source).options.filter((option) => option.label === label);
      const freshOption = selected(fresh).options.filter((option) => option.label === label);
      if (sourceOption.length !== 1 || freshOption.length !== 1 ||
          sourceOption[0]!.value !== freshOption[0]!.value)
        fail('OPTION_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
    }
  }
}
function validateCurrentEvidence(witness: SemanticGroundingWitnessV1, now = Date.now()): void {
  const issued = Date.parse(witness.evidence.observedAt);
  const expires = Date.parse(witness.evidence.expiresAt);
  if (issued > now || now > expires || expires - issued !== 10_000)
    fail('STALE_EVIDENCE', 'CURRENT_EVIDENCE_EXPIRED');
}
function groundingReason(error: SemanticGroundingStopV1): Reason {
  if (error.reason === 'STALE_EVIDENCE') return 'STALE_EVIDENCE';
  if (error.reason === 'EXPLICIT_MECHANIC_MISMATCH') return 'MECHANIC_MISMATCH';
  if (error.reason === 'UNSUPPORTED_CAPABILITY') return 'CAPABILITY_MISMATCH';
  if (error.reason === 'AMBIGUOUS_TARGET' || error.reason === 'ORDINAL_OUT_OF_BOUNDS')
    return 'DOMAIN_MISMATCH';
  if (error.reason === 'ENVIRONMENT_UNAVAILABLE' || error.reason === 'BROWSER_FAILURE')
    return 'ENVIRONMENT_UNAVAILABLE';
  return 'TARGET_MISMATCH';
}
/** Separate inactive compiler. Its fresh protected session re-grounds and executes the path, never issuing QA. */
export async function compileSemanticGroundedTraceV1(factory: ProtectedContextFactory,
  admission: TrustedSemanticIntentAdmissionV3, input: SemanticGroundedTraceV1): Promise<{
  kind: 'compiled' | 'compilation_stop'; compiler: SemanticCompilerAttemptV5;
  resolved?: SemanticResolvedTestSpecV10 }> {
  requireTrustedSemanticIntentAdmissionV3(admission);
  requireIssuedSemanticGroundedTraceV1(input);
  const compilerAttemptId = `semantic-compiler-${randomUUID()}`;
  const freshAttemptId = `semantic-compile-${randomUUID()}`;
  let trace: SemanticGroundedTraceV1 | undefined;
  let session: McpExplorationSession | undefined;
  let reason: Reason | undefined;
  let diagnostic: SemanticCompilerRejectionV1 | undefined;
  let phase = 'trace_lineage';
  let currentRecord: SemanticGroundedTraceV1['records'][number] | undefined;
  let currentWitness: SemanticGroundingWitnessV1 | undefined;
  let currentEvidenceValidatedAt: string | null = null;
  let sourceCurrentCorrespondence: boolean | null = null;
  let steps: SemanticResolvedStepV10[] = [];
  let cleanup: 'verified' | 'unverified' = 'verified';
  let freshSessionId = freshAttemptId;
  let observedFreshSessionId: string | null = null;
  const sealedSteps: SemanticCompilerSealedStepV5[] = [];
  try {
    trace = parseSemanticGroundedTraceV1(input, admission);
    phase = 'protected_session';
    session = await McpExplorationSession.open(factory, admission.spec.executionProfileRef,
      factory.catalog.resolve(admission.spec.executionProfileRef), freshAttemptId);
    if (freshSessionId === trace.sessionId ||
        session.browserSession.effectiveProfile.fingerprint !== trace.profileFingerprint)
      fail('SOURCE_MISMATCH');
    const grounding = new SemanticGroundingSessionV1(session, admission, freshAttemptId);
    for (const record of trace.records) {
      currentRecord = record;
      currentWitness = undefined;
      currentEvidenceValidatedAt = null;
      sourceCurrentCorrespondence = null;
      phase = 'step_correlation';
      if (record.type === 'navigate') {
        if (record.step.type !== 'navigate') throw new Stop('SOURCE_MISMATCH');
        await session.navigate(record.step.url);
        if (session.browserSession.context.pages().length !== 1 ||
            session.browserSession.context.pages()[0]!.url() !== record.observedUrl)
          fail('TARGET_MISMATCH');
        const closed = SemanticResolvedStepV10Schema.parse({ type: 'navigate' as const,
          stepId: record.step.id, source: 'authored' as const,
          sourceWitnessDigest: hash(record), url: record.step.url });
        steps.push(closed);
        sealedSteps.push(sealStep({ compilerAttemptId, testSpecId: trace.testSpecId,
          traceDigest: trace.traceDigest, stepId: record.step.id, recordType: record.type,
          sourceWitnessDigest: closed.sourceWitnessDigest, currentWitnessDigest: null,
          currentEvidenceIssuedAt: null, currentEvidenceExpiresAt: null,
          currentEvidenceAgeAtUseMs: null, validatedAt: new Date(Date.now()).toISOString(),
          sourceCurrentCorrespondence: null, resolvedStepDigest: hash(closed) }));
        continue;
      }
      phase = 'source_witness';
      const source = parseSemanticGroundingWitnessV1(record.witness);
      phase = 'candidate_domain';
      validateEvidence(source);
      if (record.type === 'action') {
        phase = 'action_mechanic';
        if (source.witnessVersion !== 'semantic_action_grounding_v1') throw new Stop('SOURCE_MISMATCH');
        validateAction(source);
        phase = 'fresh_grounding';
        const fresh = await grounding.groundAction(source.step.id);
        const currentAction = parseSemanticGroundingWitnessV1(fresh);
        currentWitness = currentAction;
        freshSessionId = fresh.evidence.sessionId;
        phase = 'current_evidence_validation';
        if (fresh.evidence.attemptId !== freshAttemptId ||
            fresh.evidence.testSpecId !== trace.testSpecId ||
            fresh.evidence.profileFingerprint !== trace.profileFingerprint ||
            fresh.evidence.sessionId === trace.sessionId ||
            observedFreshSessionId !== null && fresh.evidence.sessionId !== observedFreshSessionId)
          fail('SOURCE_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
        observedFreshSessionId = fresh.evidence.sessionId;
        currentEvidenceValidatedAt = new Date(Date.now()).toISOString();
        validateCurrentEvidence(currentWitness);
        validateEvidence(currentWitness);
        if (currentAction.witnessVersion === 'semantic_action_grounding_v1')
          validateAction(currentAction);
        else fail('SOURCE_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
        sourceCurrentCorrespondence = false;
        phase = 'source_current_correspondence';
        compareFresh(source, fresh);
        sourceCurrentCorrespondence = true;
        phase = 'action_receipt';
        const receipt = await grounding.executeGroundedAction(fresh);
        phase = 'current_freshness';
        currentEvidenceValidatedAt = new Date(Date.now()).toISOString();
        validateCurrentEvidence(currentWitness);
        phase = 'action_receipt';
        if (receipt.effectStatus !== record.receipt.effectStatus ||
            receipt.observedFinalState !== record.receipt.observedFinalState)
          fail('OBSERVATION_MISMATCH');
      } else {
        phase = 'observation_witness';
        if (source.witnessVersion !== 'semantic_verification_grounding_v1') throw new Stop('SOURCE_MISMATCH');
        validateVerification(source);
        phase = 'fresh_grounding';
        const fresh = await grounding.groundVerification(source.step.id);
        const currentVerification = parseSemanticGroundingWitnessV1(fresh);
        currentWitness = currentVerification;
        freshSessionId = fresh.evidence.sessionId;
        phase = 'current_evidence_validation';
        if (fresh.evidence.attemptId !== freshAttemptId ||
            fresh.evidence.testSpecId !== trace.testSpecId ||
            fresh.evidence.profileFingerprint !== trace.profileFingerprint ||
            fresh.evidence.sessionId === trace.sessionId ||
            observedFreshSessionId !== null && fresh.evidence.sessionId !== observedFreshSessionId)
          fail('SOURCE_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
        observedFreshSessionId = fresh.evidence.sessionId;
        currentEvidenceValidatedAt = new Date(Date.now()).toISOString();
        validateCurrentEvidence(currentWitness);
        validateEvidence(currentWitness);
        if (currentVerification.witnessVersion === 'semantic_verification_grounding_v1')
          validateVerification(currentVerification);
        else fail('SOURCE_MISMATCH', 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH');
        sourceCurrentCorrespondence = false;
        phase = 'source_current_correspondence';
        compareFresh(source, fresh);
        sourceCurrentCorrespondence = true;
      }
      phase = 'assertion_projection';
      const closed = SemanticResolvedStepV10Schema.parse(resolvedFor(source));
      if (!currentWitness) fail('SOURCE_MISMATCH', 'FRESH_BROWSER_EVIDENCE_UNAVAILABLE');
      phase = 'current_freshness';
      const consumedAt = Date.now();
      currentEvidenceValidatedAt = new Date(consumedAt).toISOString();
      validateCurrentEvidence(currentWitness, consumedAt);
      steps.push(closed);
      sealedSteps.push(sealStep({ compilerAttemptId, testSpecId: trace.testSpecId,
        traceDigest: trace.traceDigest, stepId: record.witness.step.id, recordType: record.type,
        sourceWitnessDigest: record.witness.witnessDigest,
        currentWitnessDigest: currentWitness.witnessDigest,
        currentEvidenceIssuedAt: currentWitness.evidence.observedAt,
        currentEvidenceExpiresAt: currentWitness.evidence.expiresAt,
        currentEvidenceAgeAtUseMs: consumedAt - Date.parse(currentWitness.evidence.observedAt),
        validatedAt: currentEvidenceValidatedAt, sourceCurrentCorrespondence,
        resolvedStepDigest: hash(closed) }));
    }
  } catch (error) {
    reason = error instanceof Stop ? error.reason : error instanceof SemanticGroundingStopV1 ?
      groundingReason(error) : phase === 'trace_lineage' ? 'SOURCE_MISMATCH' :
        phase === 'source_witness' || phase === 'current_evidence_validation' ?
          'SOURCE_MISMATCH' : 'ENVIRONMENT_UNAVAILABLE';
    const witness = currentRecord && currentRecord.type !== 'navigate' ? currentRecord.witness : null;
    const validationMs = Date.now();
    const validatedAt = new Date(validationMs).toISOString();
    const issuedAt = witness?.evidence?.observedAt ?? null;
    const expiresAt = witness?.evidence?.expiresAt ?? null;
    const issuedMs = issuedAt === null ? NaN : Date.parse(issuedAt);
    const expiresMs = expiresAt === null ? NaN : Date.parse(expiresAt);
    diagnostic = {
      code: error instanceof Stop && error.code ? error.code :
        phase === 'fresh_grounding' && error instanceof SemanticGroundingStopV1 ?
          error.reason === 'ENVIRONMENT_UNAVAILABLE' || error.reason === 'BROWSER_FAILURE' ?
            'FRESH_BROWSER_EVIDENCE_UNAVAILABLE' :
            error.reason === 'ORDINAL_OUT_OF_BOUNDS' ? 'CURRENT_RELATIONSHIP_ORDINAL_DRIFT' :
              error.reason === 'AMBIGUOUS_TARGET' ? 'CURRENT_CANDIDATE_DOMAIN_DRIFT' :
                error.reason === 'UNSUPPORTED_CAPABILITY' ||
                  error.reason === 'EXPLICIT_MECHANIC_MISMATCH' ? 'MECHANIC_CAPABILITY_MISMATCH' :
                error.reason === 'STALE_EVIDENCE' ? 'CURRENT_EVIDENCE_EXPIRED' :
                  'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH' :
        (phase === 'source_witness' || phase === 'current_evidence_validation') &&
          !(error instanceof Stop) ? 'INTEGRITY_FAILURE' :
          phase === 'trace_lineage' && input.traceVersion !== 'semantic_grounded_trace_v1' ?
            'TRACE_VERSION_MISMATCH' : rejectionCode(reason, phase),
      category: reason, phase,
      stepId: currentRecord ? currentRecord.type === 'navigate' ? currentRecord.step.id :
        currentRecord.witness.step.id : null,
      witnessVersion: witness?.witnessVersion ?? null,
      witnessIssuedAt: issuedAt, witnessExpiresAt: expiresAt, validatedAt,
      ageMs: Number.isFinite(issuedMs) ? validationMs - issuedMs : null,
      lifetimeMs: Number.isFinite(issuedMs) && Number.isFinite(expiresMs) ? expiresMs - issuedMs : null,
      expired: Number.isFinite(expiresMs) ? validationMs > expiresMs : null,
      expectedIdentity: phase === 'trace_lineage' ? 'semantic_grounded_trace_v1' :
        phase === 'source_witness' ? 'semantic_grounding_evidence_v1' : null,
      actualIdentity: phase === 'trace_lineage' ? input.traceVersion === 'semantic_grounded_trace_v1' ?
        input.traceVersion : 'unsupported' : phase === 'source_witness' ?
          witness?.evidence?.evidenceVersion === 'semantic_grounding_evidence_v1' ?
            witness.evidence.evidenceVersion : 'unsupported' : null,
      candidateCount: witness?.evidence?.candidates?.length ?? null,
      selectedIndex: witness?.evidence?.selectedDomainIndex ?? null,
      ordinalProof: !!witness?.evidence?.ordinalProof,
      relationshipProof: !!witness?.evidence?.relationProof,
      mechanic: witness?.witnessVersion === 'semantic_action_grounding_v1' ? witness.mechanic : null,
      expectedMechanic: witness?.step.type === 'action_intent' ?
        witness.step.desiredEffect === 'activate' ? 'click' :
          witness.step.desiredEffect === 'set_checked' ? witness.step.checkedState ? 'check' : 'uncheck' :
            witness.step.desiredEffect === 'choose' ? 'select_option' : 'fill' : null,
      observation: witness?.witnessVersion === 'semantic_verification_grounding_v1' ? witness.observation : null,
      property: witness?.witnessVersion === 'semantic_verification_grounding_v1' ? witness.property : null,
      expectedProperty: witness?.step.type === 'verification_intent' ? witness.step.observable : null,
      boundedSettlingAuthorized: witness?.step.dependsOnStepId !== null &&
        witness?.step.dependsOnStepId !== undefined,
      expectedSatisfied: witness?.witnessVersion === 'semantic_verification_grounding_v1' ?
        witness.expectedSatisfied : null,
      settled: witness?.witnessVersion === 'semantic_verification_grounding_v1' ? witness.settled : null,
      currentEvidenceIssuedAt: currentWitness?.evidence.observedAt ?? null,
      currentEvidenceExpiresAt: currentWitness?.evidence.expiresAt ?? null,
      currentEvidenceValidatedAt,
      currentEvidenceAgeMs: currentWitness ? validationMs - Date.parse(currentWitness.evidence.observedAt) : null,
      currentEvidenceExpired: currentWitness ? validationMs > Date.parse(currentWitness.evidence.expiresAt) : null,
      sourceCurrentCorrespondence,
      sealedSteps: [...sealedSteps], allStepsSealed: false,
      consumedEvidenceRefreshedAtFinalSeal: false,
    };
    steps = [];
  } finally {
    try { await session?.close(); } catch { cleanup = 'unverified'; reason = 'CLEANUP_UNVERIFIED'; steps = []; }
  }
  if (!reason && trace) try {
    phase = 'final_seal';
    validateSemanticCompilerSealedSequenceV5(trace.records, steps, sealedSteps, compilerAttemptId,
      trace.testSpecId, trace.traceDigest);
  } catch (error) {
    reason = error instanceof Stop ? error.reason : 'SOURCE_MISMATCH';
    diagnostic = { code: 'INTEGRITY_FAILURE', category: reason, phase,
      stepId: null, witnessVersion: null, witnessIssuedAt: null, witnessExpiresAt: null,
      validatedAt: new Date(Date.now()).toISOString(), ageMs: null, lifetimeMs: null, expired: null,
      expectedIdentity: null, actualIdentity: null, candidateCount: null, selectedIndex: null,
      ordinalProof: false, relationshipProof: false, mechanic: null, observation: null,
      expectedMechanic: null, property: null, expectedProperty: null,
      boundedSettlingAuthorized: false, expectedSatisfied: null, settled: null,
      currentEvidenceIssuedAt: null, currentEvidenceExpiresAt: null,
      currentEvidenceValidatedAt: null, currentEvidenceAgeMs: null,
      currentEvidenceExpired: null, sourceCurrentCorrespondence: null,
      sealedSteps: [...sealedSteps], allStepsSealed: false,
      consumedEvidenceRefreshedAtFinalSeal: false };
    steps = [];
  }
  if (!reason && cleanup !== 'verified') reason = 'CLEANUP_UNVERIFIED';
  if (reason && !diagnostic) diagnostic = {
    code: 'UNKNOWN_COMPILER_REJECTION', category: reason, phase: 'protected_session',
    stepId: null, witnessVersion: null, witnessIssuedAt: null, witnessExpiresAt: null,
    validatedAt: new Date(Date.now()).toISOString(), ageMs: null, lifetimeMs: null, expired: null,
    expectedIdentity: null, actualIdentity: null, candidateCount: null, selectedIndex: null,
    ordinalProof: false, relationshipProof: false, mechanic: null, observation: null,
    expectedMechanic: null, property: null, expectedProperty: null,
    boundedSettlingAuthorized: false, expectedSatisfied: null, settled: null,
    currentEvidenceIssuedAt: null, currentEvidenceExpiresAt: null,
    currentEvidenceValidatedAt: null, currentEvidenceAgeMs: null,
    currentEvidenceExpired: null, sourceCurrentCorrespondence: null,
    sealedSteps: [...sealedSteps], allStepsSealed: !!trace && sealedSteps.length === trace.records.length,
    consumedEvidenceRefreshedAtFinalSeal: false };
  const sourceTrace = trace ?? input;
  const base = { compilerVersion: '5' as const, compilerAttemptId,
    traceDigest: sourceTrace.traceDigest, testSpecId: sourceTrace.testSpecId, sourceSessionId: sourceTrace.sessionId,
    freshSessionId, profileFingerprint: sourceTrace.profileFingerprint, cleanup };
  if (reason) {
    const result = { kind: 'compilation_stop' as const, compiler: sealSemanticCompilerAttemptV5({
      ...base, result: { status: 'rejected' as const, reason } }) };
    if (diagnostic) rejectedDiagnostics.set(result, diagnostic);
    return result;
  }
  if (!trace) throw new Error('MISSING_SEMANTIC_TRACE');
  const resolved = sealSemanticResolvedTestSpecV10({ schemaVersion: '10', sourceSchemaVersion: '7',
    sourceContractVersion: '3', compilerVersion: '5', traceVersion: 'semantic_grounded_trace_v1',
    testSpecId: trace.testSpecId, compilerAttemptId, traceDigest: trace.traceDigest,
    profileFingerprint: trace.profileFingerprint, executionSteps: steps });
  // The accepted attempt must name the actual closed artifact, never a placeholder.
  const accepted = sealSemanticCompilerAttemptV5({ ...base, result: {
    status: 'accepted', resolvedSpecId: resolved.resolvedSpecId } });
  parseSemanticResolvedTestSpecV10(resolved, trace);
  const result = { kind: 'compiled' as const, compiler: accepted, resolved };
  issuedCompilations.add(result);
  acceptedSeals.set(result, Object.freeze([...sealedSteps]));
  return result;
}
