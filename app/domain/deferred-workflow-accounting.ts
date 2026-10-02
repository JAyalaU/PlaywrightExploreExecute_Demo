import { z } from 'zod';
import { ActionExecutionAttemptV1Schema, ActionGroundingWitnessV1Schema } from './action-grounding-execution.js';
import { DeferredReplayRecordV1Schema } from './deferred-action-replay.js';
import { CompilerAttemptV4Schema } from './deferred-action-compiler.js';
import { DeferredInterpretationTimingV1Schema } from './deferred-interpretation-timing.js';
import { DeferredInterpretationStructuralV1Schema } from './deferred-interpretation-structural.js';
import { DeferredStartupDiagnosticV1Schema } from './deferred-startup-diagnostics.js';
import { DeferredVerificationDiagnosticV1Schema } from './deferred-verification-diagnostic.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
/** Bounded private explanation of a grounding stop; it never grants action or QA authority. */
export const DeferredGroundingStopDiagnosticV1Schema = z.strictObject({
  diagnosticVersion: z.literal('1'), stepId: identifier,
  operation: z.enum(['click', 'fill', 'select_option']).optional(),
  pending: z.array(z.strictObject({ obligationId: identifier,
    kind: z.enum(['effect', 'operation', 'unsupported_operation', 'argument', 'constraint',
      'relationship', 'prerequisite', 'reference', 'contrast']) })).max(128),
  candidateCount: z.number().int().min(0).max(80).optional(),
});

/** Restricted diagnostics only. Parsed or stored accounting grants no action, witness, trace or replay authority. */
export const DeferredWorkflowPrivateAccountingV1Schema = z.strictObject({
  groundingAttempts: z.array(ActionExecutionAttemptV1Schema).max(300),
  successfulWitnesses: z.array(ActionGroundingWitnessV1Schema).max(100),
  compilerAttempt: CompilerAttemptV4Schema.optional(),
  replay: DeferredReplayRecordV1Schema.optional(),
  interpretationTiming: DeferredInterpretationTimingV1Schema.optional(),
  interpretationStructural: DeferredInterpretationStructuralV1Schema.optional(),
  startupDiagnostics: z.array(DeferredStartupDiagnosticV1Schema).max(5).optional(),
  groundingStop: DeferredGroundingStopDiagnosticV1Schema.optional(),
  verificationDiagnostics: z.array(DeferredVerificationDiagnosticV1Schema).max(100).optional(),
});
