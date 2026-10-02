import { z } from 'zod';
import { DeferredWorkflowStopCodeV1Schema } from './deferred-workflow.js';

/** Restricted, bounded timing only. No URLs, tool responses, page content, or error messages. */
export const DeferredStartupDiagnosticV1Schema = z.strictObject({
  stage: z.enum(['session_open', 'root_navigation', 'initial_observation',
    'initial_protected_state', 'first_grounding_decision']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  elapsedMs: z.number().int().nonnegative().max(86_400_000),
  status: z.enum(['completed', 'failed', 'stopped']),
  exceptionName: z.enum(['Error', 'TimeoutError', 'McpToolError',
    'ActionCandidateGroundingError', 'StageStop', 'AggregateError', 'OtherError']).optional(),
  code: z.union([DeferredWorkflowStopCodeV1Schema,
    z.enum(['MCP_TOOL_ERROR', 'NAVIGATION_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])]).optional(),
});
export type DeferredStartupDiagnosticV1 = z.infer<typeof DeferredStartupDiagnosticV1Schema>;
