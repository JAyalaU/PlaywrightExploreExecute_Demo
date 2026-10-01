import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ActionTargetIntentV1Schema } from './action-target-intent.js';
import { ExecutionProfileRefSchema } from './schema.js';
import { FrameOwnershipV2Schema } from './agentic-contracts.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Created by protected current-state binding, before the action is executed. */
export const ActionIdentityWitnessV1Schema = z.strictObject({
  witnessVersion: z.literal('1'), witnessId: id, bindingId: id,
  testSpecId: id, explorationAttemptId: id, sessionId: id, pageId: id, frameId: id,
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: digest,
  sourceStepId: id, operation: z.enum(['click', 'fill', 'select_option']),
  requestedIntent: ActionTargetIntentV1Schema,
  selectedRef: id, selectedRole: z.string().min(1).max(256),
  selectedAccessibleName: z.string().max(512),
  eligibleMatchCount: z.literal(1), selectedReferenceMatches: z.literal(true),
  scope: ActionTargetIntentV1Schema.shape.scope,
  frameOwnership: FrameOwnershipV2Schema,
  snapshotEpoch: z.number().int().nonnegative(), mutationEpoch: z.number().int().nonnegative(),
  snapshotDigest: digest, stateDigest: digest,
  observedAt: z.iso.datetime(), witnessDigest: digest,
});
export type ActionIdentityWitnessV1 = z.infer<typeof ActionIdentityWitnessV1Schema>;

export function actionIdentityWitnessDigest(value: Omit<ActionIdentityWitnessV1, 'witnessDigest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function parseActionIdentityWitnessV1(input: unknown): ActionIdentityWitnessV1 {
  const witness = ActionIdentityWitnessV1Schema.parse(input);
  const { witnessDigest, ...data } = witness;
  if (actionIdentityWitnessDigest(data) !== witnessDigest)
    throw new Error('Action identity witness digest mismatch');
  return witness;
}
