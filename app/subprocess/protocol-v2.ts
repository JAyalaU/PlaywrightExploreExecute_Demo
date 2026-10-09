import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ResultRecordV2Schema, type ResultRecordV2 } from '../domain/agentic-result-v2.js';
import { ExecutionProfileRefSchema } from '../domain/shared-contracts.js';
import { LocalWorkflowRequestSchema } from '../local/product-contracts.js';
import { BridgeErrorCodeSchema, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, SUBPROCESS_EXIT,
  SubprocessProtocolError } from './shared-protocol.js';

export const SUBPROCESS_PROTOCOL_V2 = '2' as const;
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
/** Workflow selection is trusted launch state, never a user request field. */
export const SubprocessRequestV2Schema = z.strictObject({
  protocolVersion: z.literal(SUBPROCESS_PROTOCOL_V2),
  request: LocalWorkflowRequestSchema.extend({
    taskText: LocalWorkflowRequestSchema.shape.taskText.max(16_384),
    targetUrl: LocalWorkflowRequestSchema.shape.targetUrl.max(2_048),
    executionProfileRef: ExecutionProfileRefSchema.refine((ref) =>
      ref.id.length <= 128 && ref.version.length <= 64),
  }),
});
export type SubprocessRequestV2 = z.infer<typeof SubprocessRequestV2Schema>;

const progress = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('not_started') }),
  z.strictObject({ stage: z.literal('exploration'), explorationAttemptId: id }),
  z.strictObject({ stage: z.literal('compilation'), explorationAttemptId: id,
    successfulTraceId: id, compilerAttemptId: id.optional() }),
  z.strictObject({ stage: z.literal('replay'), explorationAttemptId: id,
    successfulTraceId: id, compilerAttemptId: id, resolvedSpecId: id,
    executionRunIds: z.array(id).min(0).max(2) }),
]);
const report = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('available'), testSpecId: id }),
]);
const withContext = z.strictObject({ result: ResultRecordV2Schema, progress, report }).superRefine((value, issue) => {
  const r = value.result;
  if (value.report.kind === 'available' && value.report.testSpecId !== r.testSpecId)
    issue.addIssue({ code: 'custom', path: ['report'], message: 'Report owner mismatch' });
  if (value.report.kind === 'available' && !r.successfulTraceId)
    issue.addIssue({ code: 'custom', path: ['report'], message: 'Report requires a stored successful trace' });
  const p = value.progress;
  if (p.stage === 'not_started' ? !!r.explorationAttemptId || !!r.compilerAttemptId || r.executionRunIds.length > 0 :
      p.explorationAttemptId !== r.explorationAttemptId ||
      (p.stage === 'exploration' ? !!r.successfulTraceId || !!r.compilerAttemptId || r.executionRunIds.length > 0 :
       p.successfulTraceId !== r.successfulTraceId ||
       (p.stage === 'compilation' ? p.compilerAttemptId !== r.compilerAttemptId || !!r.resolvedSpecId :
        p.compilerAttemptId !== r.compilerAttemptId || p.resolvedSpecId !== r.resolvedSpecId ||
        JSON.stringify(p.executionRunIds) !== JSON.stringify(r.executionRunIds))))
    issue.addIssue({ code: 'custom', path: ['progress'], message: 'Progress/result mismatch' });
  if (r.terminal.stage === 'qa' && p.stage !== 'replay')
    issue.addIssue({ code: 'custom', path: ['progress'], message: 'QA requires replay progress' });
});
const success = z.strictObject({ protocolVersion: z.literal(SUBPROCESS_PROTOCOL_V2),
  kind: z.literal('success'), context: withContext }).superRefine((v, issue) => {
  if (v.context.result.terminal.status !== 'QA_ASSERTION_PASSED')
    issue.addIssue({ code: 'custom', message: 'Success requires authoritative QA pass' });
});
const stop = z.strictObject({ protocolVersion: z.literal(SUBPROCESS_PROTOCOL_V2),
  kind: z.literal('typed_stop'), stopKind: z.enum(['automation_stop', 'environment_stop',
    'reproducibility_stop', 'cancelled', 'qa_failure']), context: withContext }).superRefine((v, issue) => {
  const stage = v.context.result.terminal.stage;
  const expected = stage === 'qa' ? 'qa_failure' : stage === 'environment' ? 'environment_stop' :
    stage === 'cancellation' ? 'cancelled' : stage === 'reproducibility' ? 'reproducibility_stop' : 'automation_stop';
  if (v.context.result.terminal.status === 'QA_ASSERTION_PASSED' || v.stopKind !== expected)
    issue.addIssue({ code: 'custom', message: 'Stop kind/result mismatch' });
});
const bridgeError = z.strictObject({ protocolVersion: z.literal(SUBPROCESS_PROTOCOL_V2),
  kind: z.literal('bridge_error'), code: BridgeErrorCodeSchema,
  cleanup: z.enum(['not_started', 'verified', 'unverified']) });
export const SubprocessResponseV2Schema = z.union([success, stop, bridgeError]);
export type SubprocessResponseV2 = z.infer<typeof SubprocessResponseV2Schema>;

function document(input: string | Uint8Array, bound: number, sizeCode: 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE'): unknown {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.byteLength > bound) throw new SubprocessProtocolError(sizeCode);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new SubprocessProtocolError('PROTOCOL_INVALID'); }
}
function parse<T>(input: string | Uint8Array, bound: number, sizeCode: 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE',
  schema: z.ZodType<T>): T {
  const value = document(input, bound, sizeCode);
  if (value && typeof value === 'object' && 'protocolVersion' in value && value.protocolVersion !== SUBPROCESS_PROTOCOL_V2)
    throw new SubprocessProtocolError('PROTOCOL_UNSUPPORTED_VERSION');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SubprocessProtocolError('PROTOCOL_INVALID');
  return parsed.data;
}
export function parseSubprocessRequestV2(input: string | Uint8Array): SubprocessRequestV2 {
  return parse(input, MAX_REQUEST_BYTES, 'REQUEST_TOO_LARGE', SubprocessRequestV2Schema);
}
export function parseSubprocessResponseV2(input: string | Uint8Array): SubprocessResponseV2 {
  return parse(input, MAX_RESPONSE_BYTES, 'RESPONSE_TOO_LARGE', SubprocessResponseV2Schema);
}
export function expectedSubprocessExitV2(response: SubprocessResponseV2): number {
  if (response.kind === 'success') return SUBPROCESS_EXIT.success;
  if (response.kind === 'bridge_error') return response.code === 'CANCELLED' ? SUBPROCESS_EXIT.cancelled : SUBPROCESS_EXIT.bridgeError;
  if (response.stopKind === 'qa_failure') return SUBPROCESS_EXIT.qaFailure;
  if (response.stopKind === 'cancelled') return SUBPROCESS_EXIT.cancelled;
  return SUBPROCESS_EXIT.automationStop;
}
export function serializeSubprocessResponseV2(response: SubprocessResponseV2): { body: string; exitCode: number } {
  const validated = SubprocessResponseV2Schema.parse(response);
  const body = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new SubprocessProtocolError('RESPONSE_TOO_LARGE');
  return { body, exitCode: expectedSubprocessExitV2(validated) };
}
export function responseMatchesRequestV2(request: SubprocessRequestV2, response: SubprocessResponseV2): boolean {
  return response.kind === 'bridge_error' ||
    response.context.result.executionProfileRef.id === request.request.executionProfileRef.id &&
    response.context.result.executionProfileRef.version === request.request.executionProfileRef.version;
}

/** Node-only envelope construction after the immutable terminal has been stored. */
export function envelopeForAgenticTerminalV2(result: ResultRecordV2,
  reportAvailable: boolean): SubprocessResponseV2 {
  const progress = result.resolvedSpecId && result.compilerAttemptId && result.successfulTraceId && result.explorationAttemptId
    ? { stage: 'replay' as const, explorationAttemptId: result.explorationAttemptId,
      successfulTraceId: result.successfulTraceId, compilerAttemptId: result.compilerAttemptId,
      resolvedSpecId: result.resolvedSpecId, executionRunIds: result.executionRunIds }
    : result.successfulTraceId && result.explorationAttemptId
      ? { stage: 'compilation' as const, explorationAttemptId: result.explorationAttemptId,
        successfulTraceId: result.successfulTraceId,
        ...(result.compilerAttemptId ? { compilerAttemptId: result.compilerAttemptId } : {}) }
      : result.explorationAttemptId ? { stage: 'exploration' as const,
        explorationAttemptId: result.explorationAttemptId } : { stage: 'not_started' as const };
  const context = { result, progress,
    report: reportAvailable ? { kind: 'available' as const, testSpecId: result.testSpecId } :
      { kind: 'unavailable' as const } };
  const stage = result.terminal.stage;
  return SubprocessResponseV2Schema.parse(stage === 'qa' && result.terminal.status === 'QA_ASSERTION_PASSED'
    ? { protocolVersion: SUBPROCESS_PROTOCOL_V2, kind: 'success', context }
    : { protocolVersion: SUBPROCESS_PROTOCOL_V2, kind: 'typed_stop',
      stopKind: stage === 'qa' ? 'qa_failure' : stage === 'environment' ? 'environment_stop' :
        stage === 'cancellation' ? 'cancelled' : stage === 'reproducibility' ?
          'reproducibility_stop' : 'automation_stop', context });
}
