import { z } from 'zod';
import { semanticGroundingDigestV1 as hash } from './semantic-grounding-v1.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SemanticRunnerStopV10Schema = z.enum([
  'UNAUTHENTICATED_INPUT', 'PROFILE_MISMATCH', 'ENVIRONMENT_FAILURE', 'CLEANUP_UNVERIFIED',
  'BUDGET_EXHAUSTED', 'LOCATOR_BINDING_FAILED', 'CARDINALITY_DRIFT', 'ORDINAL_DRIFT',
  'RELATIONSHIP_DRIFT', 'STALE_EVIDENCE', 'UNSUPPORTED_CAPABILITY', 'OPTION_MAPPING_MISMATCH',
  'ACTION_FAILED_PARTIAL_OR_UNKNOWN', 'POST_EFFECT_UNPROVEN', 'INCOMPLETE_EVIDENCE',
]);
export type SemanticRunnerStopV10 = z.infer<typeof SemanticRunnerStopV10Schema>;
const proof = z.strictObject({ domainVersion: z.literal('semantic_candidate_domain_v1'),
  complete: z.literal(true), count: z.number().int().min(0).max(100),
  orderedIdentities: z.array(digest).max(100), selectedIndex: z.number().int().nonnegative().nullable(),
  selectedIdentity: digest.nullable(), ordinal: z.number().int().positive().nullable(),
  relationSatisfied: z.boolean().nullable(), pageUrl: z.string().max(2048), proofDigest: digest });
export type SemanticRunnerGuardProofV10 = z.infer<typeof proof>;
const step = z.strictObject({ stepId: id, resolvedType: z.enum(['navigate', 'action', 'assert_count',
  'assert_boolean', 'assert_value', 'assert_url', 'assert_native_selected_option']),
  status: z.enum(['action_succeeded', 'assertion_true', 'assertion_false', 'stopped']),
  guard: proof.nullable(), invocation: z.enum(['not_invoked', 'returned', 'unknown']),
  operation: z.enum(['navigate', 'click', 'check', 'uncheck', 'select_option', 'fill']).nullable(),
  effect: z.union([z.boolean(), z.string().max(1024), z.null()]),
  observation: z.union([z.boolean(), z.string().max(2048), z.number().int().nonnegative(), z.null()]),
  expected: z.union([z.boolean(), z.string().max(2048), z.number().int().nonnegative(), z.null()]),
  stopReason: SemanticRunnerStopV10Schema.nullable(), evidenceDigest: digest });
export type SemanticRunnerStepV10 = z.infer<typeof step>;
export const SemanticRunnerRecordV10Schema = z.strictObject({ runnerVersion: z.literal('10'),
  executionRunId: id, sessionId: id.nullable(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  resolvedSpecId: id, resolvedDigest: digest, compilerAttemptId: id, traceDigest: digest,
  profileFingerprint: digest, cleanup: z.enum(['verified', 'unverified']),
  steps: z.array(step).max(100), result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('completed'), assertions: z.number().int().nonnegative(), passed: z.boolean() }),
    z.strictObject({ kind: z.literal('non_qa_stop'), reason: SemanticRunnerStopV10Schema,
      failedStepId: id.nullable() }),
  ]), recordDigest: digest });
export type SemanticRunnerRecordV10 = z.infer<typeof SemanticRunnerRecordV10Schema>;
export function sealSemanticRunnerStepV10(value: Omit<SemanticRunnerStepV10, 'evidenceDigest'>): SemanticRunnerStepV10 {
  return step.parse({ ...value, evidenceDigest: hash(value) });
}
export function sealSemanticRunnerRecordV10(value: Omit<SemanticRunnerRecordV10, 'recordDigest'>): SemanticRunnerRecordV10 {
  return SemanticRunnerRecordV10Schema.parse({ ...value, recordDigest: hash(value) });
}
export function parseSemanticRunnerRecordV10(input: unknown): SemanticRunnerRecordV10 {
  const record = SemanticRunnerRecordV10Schema.parse(input);
  const { recordDigest, ...body } = record;
  if (hash(body) !== recordDigest || record.steps.some(({ evidenceDigest, ...evidence }) =>
    hash(evidence) !== evidenceDigest || evidence.guard && (() => {
      const { proofDigest, ...guard } = evidence.guard;
      return hash(guard) !== proofDigest;
    })()) || Date.parse(record.finishedAt) < Date.parse(record.startedAt))
    throw new Error('INVALID_SEMANTIC_RUN_V10');
  return record;
}

export const SemanticReplayPairV2Schema = z.strictObject({ orchestrationVersion: z.literal('2'),
  orchestrationId: id, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  resolvedSpecId: id, resolvedDigest: digest, runs: z.array(SemanticRunnerRecordV10Schema).max(2),
  agreement: z.enum(['agreed', 'disagreed', 'not_established']),
  terminal: z.enum(['QA_PASS', 'QA_FAIL', 'NON_QA']), pairDigest: digest });
export type SemanticReplayPairV2 = z.infer<typeof SemanticReplayPairV2Schema>;
export function semanticRunSignatureV10(run: SemanticRunnerRecordV10): string {
  return hash(run.steps.filter(s => s.status === 'assertion_true' || s.status === 'assertion_false')
    .map(s => ({ stepId: s.stepId, resolvedType: s.resolvedType, status: s.status,
      observation: s.observation, expected: s.expected, count: s.guard?.count ?? null,
      selectedIdentity: s.guard?.selectedIdentity ?? null })));
}
export function deriveSemanticAgreementV2(runs: readonly SemanticRunnerRecordV10[]):
  Pick<SemanticReplayPairV2, 'agreement' | 'terminal'> {
  if (runs.length !== 2 || runs.some(r => r.result.kind !== 'completed' || r.cleanup !== 'verified'))
    return { agreement: 'not_established', terminal: 'NON_QA' };
  if (semanticRunSignatureV10(runs[0]!) !== semanticRunSignatureV10(runs[1]!))
    return { agreement: 'disagreed', terminal: 'NON_QA' };
  const first = runs[0]!.result;
  if (first.kind !== 'completed') return { agreement: 'not_established', terminal: 'NON_QA' };
  return { agreement: 'agreed', terminal: first.assertions > 0 && first.passed ? 'QA_PASS' :
    first.assertions > 0 ? 'QA_FAIL' : 'NON_QA' };
}
export function sealSemanticReplayPairV2(value: Omit<SemanticReplayPairV2, 'pairDigest' | 'agreement' | 'terminal'>): SemanticReplayPairV2 {
  const outcome = deriveSemanticAgreementV2(value.runs);
  const body = { ...value, ...outcome };
  return parseSemanticReplayPairV2({ ...body, pairDigest: hash(body) });
}
export function parseSemanticReplayPairV2(input: unknown): SemanticReplayPairV2 {
  const pair = SemanticReplayPairV2Schema.parse(input), { pairDigest, ...body } = pair;
  const outcome = deriveSemanticAgreementV2(pair.runs);
  if (hash(body) !== pairDigest || pair.agreement !== outcome.agreement || pair.terminal !== outcome.terminal ||
    pair.runs.some(r => { parseSemanticRunnerRecordV10(r); return r.resolvedSpecId !== pair.resolvedSpecId ||
      r.resolvedDigest !== pair.resolvedDigest; }) ||
    new Set(pair.runs.map(r => r.executionRunId)).size !== pair.runs.length ||
    new Set(pair.runs.map(r => r.sessionId).filter(Boolean)).size !== pair.runs.filter(r => r.sessionId).length ||
    pair.runs.length === 2 && (pair.runs[0]!.result.kind !== 'completed' ||
      pair.runs[0]!.cleanup !== 'verified' || Date.parse(pair.runs[1]!.startedAt) < Date.parse(pair.runs[0]!.finishedAt)))
    throw new Error('INVALID_SEMANTIC_REPLAY_PAIR_V2');
  return pair;
}
