import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ExecutionProfileRefSchema } from './schema.js';

export const TRUSTED_OBSERVATION_VERSION = '1' as const;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().min(1).max(256);

export const SemanticObservationQueryV1Schema = z.strictObject({
  role: z.enum(['button', 'link', 'dialog', 'row', 'cell', 'textbox', 'checkbox',
    'radio', 'heading', 'region', 'menu', 'menuitem', 'tab', 'combobox', 'listbox', 'option', 'switch']),
  name: bounded.optional(),
  frame: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('main') }),
    z.strictObject({ kind: z.literal('nested'), anchors: z.array(z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('title'), value: bounded, exact: z.literal(true) }),
      z.strictObject({ kind: z.literal('testId'), value: bounded, exact: z.literal(true) }),
    ])).min(1).max(8) }),
  ]),
  within: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['dialog', 'menu', 'region']), name: bounded }),
    z.strictObject({ kind: z.literal('row'), cellName: bounded }),
  ])).max(4).optional(),
});
export type SemanticObservationQueryV1 = z.infer<typeof SemanticObservationQueryV1Schema>;

export const TrustedObservationRequestV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('semantic_query'), query: SemanticObservationQueryV1Schema }),
  z.strictObject({ kind: z.literal('target_property'), query: SemanticObservationQueryV1Schema,
    property: z.enum(['semantic', 'text', 'value', 'visible', 'enabled', 'checked', 'expanded', 'selected']) }),
  z.strictObject({ kind: z.literal('current_url') }),
  z.strictObject({ kind: z.literal('semantic_snapshot') }),
]);
export type TrustedObservationRequestV1 = z.infer<typeof TrustedObservationRequestV1Schema>;

const frameProvenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main'), snapshotDigest: digest }),
  z.strictObject({ kind: z.literal('nested'), anchors: z.array(z.strictObject({
    kind: z.enum(['title', 'testId']), value: bounded, exact: z.literal(true),
    ownerSnapshotDigest: digest, observedMatchCount: z.literal(1),
  })).min(1).max(8) }),
  z.strictObject({ kind: z.literal('unresolved') }),
]);
export const TrustedObservationFrameProvenanceV1Schema = frameProvenance;

const base = {
  observationVersion: z.literal(TRUSTED_OBSERVATION_VERSION), observationId: id,
  testSpecId: id, explorationAttemptId: id, sessionId: id, pageId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest,
  stateEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative(),
  stateDigest: digest, observedAt: z.iso.datetime(), witnessDigest: digest,
  request: TrustedObservationRequestV1Schema, frame: frameProvenance,
};

export const TrustedObservationResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('complete'), result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('matches'), count: z.number().int().nonnegative().max(10_000), complete: z.literal(true) }),
    z.strictObject({ kind: z.literal('property'), matchCount: z.literal(1), property: z.enum([
      'semantic', 'text', 'value', 'visible', 'enabled', 'checked', 'expanded', 'selected']),
      value: z.union([z.string().max(2048), z.boolean(), z.strictObject({
        role: bounded, accessibleName: z.string().max(512),
      })]), complete: z.literal(true) }),
    z.strictObject({ kind: z.literal('url'), value: z.string().max(2048), complete: z.literal(true) }),
    z.strictObject({ kind: z.literal('snapshot'), text: z.string().max(16_384), truncated: z.boolean(),
      fullSnapshotDigest: digest, evidenceGrade: z.literal(false) }),
  ]) }),
  z.strictObject({ ...base, status: z.literal('error'), reason: z.enum([
    'INVALID_SCOPE', 'STALE_STATE', 'BROWSER_FAILURE', 'QUERY_UNEVALUABLE',
    'RESULT_LIMIT', 'NO_MATCH', 'NON_UNIQUE', 'UNSUPPORTED_PROPERTY',
  ]), observedMatchCount: z.number().int().nonnegative().max(10_000).optional() }),
]).superRefine((record, context) => {
  if (record.status !== 'complete') return;
  const expected = record.request.kind === 'semantic_query' ? 'matches' :
    record.request.kind === 'target_property' ? 'property' :
      record.request.kind === 'current_url' ? 'url' : 'snapshot';
  if (record.result.kind !== expected || record.request.kind === 'target_property' &&
      record.result.kind === 'property' && record.request.property !== record.result.property)
    context.addIssue({ code: 'custom', path: ['result'], message: 'Observation result contradicts request' });
  if (record.request.kind !== 'semantic_snapshot' && record.frame.kind === 'unresolved')
    context.addIssue({ code: 'custom', path: ['frame'], message: 'Complete observation requires resolved frame' });
});
export type TrustedObservationResultV1 = z.infer<typeof TrustedObservationResultV1Schema>;
/** Pure historical witness reconstruction; integrity does not grant runtime origin. */
export function parseTrustedObservationWitnessV1(input: unknown): TrustedObservationResultV1 {
  const record=TrustedObservationResultV1Schema.parse(input);
  const data={observationVersion:record.observationVersion,observationId:record.observationId,testSpecId:record.testSpecId,
    explorationAttemptId:record.explorationAttemptId,sessionId:record.sessionId,executionProfileRef:record.executionProfileRef,
    profileFingerprint:record.profileFingerprint,pageId:record.pageId,stateEpoch:record.stateEpoch,mutationEpoch:record.mutationEpoch,
    stateDigest:record.stateDigest,observedAt:record.observedAt,request:record.request,frame:record.frame,
    ...(record.status==='complete'?{status:record.status,result:record.result}:{status:record.status,reason:record.reason,
      ...(record.observedMatchCount===undefined?{}:{observedMatchCount:record.observedMatchCount})})};
  if(createHash('sha256').update(JSON.stringify(data)).digest('hex')!==record.witnessDigest)throw new Error('Trusted observation witness mismatch');
  return record;
}
