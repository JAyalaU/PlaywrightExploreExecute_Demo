import { z } from 'zod';
import { ActionExecutionAttemptV1Schema, ActionGroundingWitnessV1Schema } from './action-grounding-execution.js';
import { DeferredReplayRecordV1Schema } from './deferred-action-replay.js';
import { CompilerAttemptV4Schema } from './deferred-action-compiler.js';
import { DeferredInterpretationTimingV1Schema } from './deferred-interpretation-timing.js';
import { DeferredInterpretationStructuralV1Schema } from './deferred-interpretation-structural.js';

/** Restricted diagnostics only. Parsed or stored accounting grants no action, witness, trace or replay authority. */
export const DeferredWorkflowPrivateAccountingV1Schema = z.strictObject({
  groundingAttempts: z.array(ActionExecutionAttemptV1Schema).max(300),
  successfulWitnesses: z.array(ActionGroundingWitnessV1Schema).max(100),
  compilerAttempt: CompilerAttemptV4Schema.optional(),
  replay: DeferredReplayRecordV1Schema.optional(),
  interpretationTiming: DeferredInterpretationTimingV1Schema.optional(),
  interpretationStructural: DeferredInterpretationStructuralV1Schema.optional(),
});
