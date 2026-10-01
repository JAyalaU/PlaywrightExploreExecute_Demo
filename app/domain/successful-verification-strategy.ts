import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TrustedObservationRequestV1Schema, TrustedObservationFrameProvenanceV1Schema } from './observation-contracts.js';
import { VerificationComparisonV1Schema } from './verification-comparison.js';
export const SUCCESSFUL_VERIFICATION_OBSERVATION_LIMIT = 8;
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
function digest(data: unknown): string { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export const SuccessfulVerificationStrategyV1Schema = z.strictObject({
  strategyVersion: z.literal('1'), goalStepId: identifier,
  observationIds: z.array(identifier).min(1).max(SUCCESSFUL_VERIFICATION_OBSERVATION_LIMIT),
  observations: z.array(z.object({ observationId: identifier,
    request: TrustedObservationRequestV1Schema,
    result: z.union([z.strictObject({ kind: z.literal('matches'), count: z.number().int().min(0).max(10_000),
      complete: z.literal(true) }),
      z.strictObject({ kind: z.literal('property'), property: z.enum(['semantic', 'text', 'value',
        'visible', 'enabled', 'checked', 'expanded', 'selected']),
        value: z.union([z.string().max(2048), z.boolean(),
          z.strictObject({ role: z.string().max(256), accessibleName: z.string().max(512) })]),
        complete: z.literal(true) }),
      z.strictObject({ kind: z.literal('url'), value: z.string().max(2048), complete: z.literal(true) })]),
    witnessDigest: z.string().regex(/^[a-f0-9]{64}$/), sessionId: identifier, pageId: identifier,
    stateEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative(),
    stateDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime(),
    frame: TrustedObservationFrameProvenanceV1Schema,
  }).strict()).min(1).max(SUCCESSFUL_VERIFICATION_OBSERVATION_LIMIT),
  comparison: VerificationComparisonV1Schema,
  evaluated: z.boolean(), conclusion: z.enum(['satisfied', 'unsatisfied']),
  testSpecId: identifier, explorationAttemptId: identifier, sessionId: identifier,
  pageId: identifier, actionOrdinal: z.number().int().nonnegative(),
  strategyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SuccessfulVerificationStrategyV1 = z.infer<typeof SuccessfulVerificationStrategyV1Schema>;
export function parseSuccessfulVerificationStrategyV1(input: unknown): SuccessfulVerificationStrategyV1 {
  const strategy = SuccessfulVerificationStrategyV1Schema.parse(input);
  const { strategyDigest, ...data } = strategy;
  const operandIds = strategy.comparison.kind === 'transition'
    ? [strategy.comparison.earlierObservationId, strategy.comparison.laterObservationId]
    : [strategy.comparison.observationId];
  if (strategyDigest !== digest(data) || strategy.observationIds.length !== strategy.observations.length ||
      strategy.observationIds.some((id, index) => id !== strategy.observations[index]?.observationId) ||
      !same(strategy.observationIds, operandIds) ||
      strategy.conclusion !== (strategy.evaluated ? 'satisfied' : 'unsatisfied') ||
      strategy.observations.some((observation) => observation.sessionId !== strategy.sessionId ||
        observation.pageId !== strategy.pageId)) throw new Error('Invalid verification strategy provenance');
  return strategy;
}
