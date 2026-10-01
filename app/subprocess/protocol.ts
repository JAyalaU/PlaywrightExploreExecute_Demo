import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ExecutionProfileRefSchema, ResultStatusSchema } from '../domain/schema.js';
import {
  LocalWorkflowRequestSchema, ObservationStateSchema,
} from '../local/contracts.js';

export const SUBPROCESS_PROTOCOL_VERSION = '1' as const;
export const MAX_REQUEST_BYTES = 65_536;
export const MAX_RESPONSE_BYTES = 65_536;
export const MAX_STDERR_BYTES = 16_384;
export const DEFAULT_HOST_DEADLINE_MS = 300_000;
export const MAX_HOST_DEADLINE_MS = 1_200_000;

export const SUBPROCESS_EXIT = {
  success: 0, qaFailure: 1, automationStop: 2, bridgeError: 64, cancelled: 130,
} as const;

const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
/** Only known codes may cross stdout; arbitrary ResultRecord.reason can contain private text. */
export const SafeTerminalReasonSchema = z.enum([
  'AMBIGUOUS_MATCH', 'AMBIGUOUS_TARGET', 'DATA_REFERENCE_UNAVAILABLE',
  'DATA_REFERENCE_UNAVAILABLE_DURING_EXPLORATION', 'DEPENDENCY_FAILED',
  'EVALUATION_FAILED', 'FIND_LIMIT_EXCEEDED', 'FRAME_RESOLUTION_FAILED',
  'INSUFFICIENT_CONTEXT', 'INVALID_REQUEST', 'INVALID_TEST_SPEC',
  'MALFORMED_LOCATOR_RESPONSE', 'MALFORMED_MODEL_OUTPUT', 'MATERIAL_AMBIGUITY',
  'MODEL_ERROR', 'MODEL_TIMEOUT', 'NETWORK_POLICY_DENIED', 'NO_MATCH',
  'NON_UNIQUE_MATCH', 'NOT_VISIBLE', 'OPERATION_ERROR', 'PAGE_CLOSED',
  'PREREQUISITE_LIMIT_EXCEEDED', 'PREREQUISITE_VALUE_MISSING',
  'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'QUALITY_NOT_ACCEPTED',
  'REDACTED_REASON', 'REF_NOT_IN_CURRENT_SNAPSHOT',
  'SESSION_CLEANUP_FAILED', 'START_STATE_FAILED', 'TARGET_LOCATOR_MISSING',
  'TARGET_MISMATCH', 'TARGET_NOT_FOUND', 'TEST_ID_PROVENANCE_UNVERIFIED',
  'TEXT_MISMATCH', 'UNEXPECTED_PAGE_COUNT', 'UNKNOWN_TIMEOUT_POLICY',
  'UNSUPPORTED_GRAMMAR', 'UNSUPPORTED_REQUEST', 'UNSUPPORTED_SOURCE_TEXT',
  'URL_MISMATCH', 'VALUE_MISMATCH', 'WAIT_CONDITION_TIMEOUT',
  'WAIT_LIMIT_EXCEEDED', 'WEAK_IDENTITY',
]);
export function safeTerminalReason(input: string | undefined): z.infer<typeof SafeTerminalReasonSchema> | undefined {
  if (input === undefined) return undefined;
  const parsed = SafeTerminalReasonSchema.safeParse(input);
  return parsed.success ? parsed.data : 'REDACTED_REASON';
}
const profileRef = ExecutionProfileRefSchema.superRefine((ref, context) => {
  if (ref.id.length > 128 || ref.version.length > 64) {
    context.addIssue({ code: 'custom', message: 'Profile reference exceeds wire limit' });
  }
});

/** The request carries task input only. Configuration and credentials are launch-side inputs. */
export const SubprocessRequestSchema = z.strictObject({
  protocolVersion: z.literal(SUBPROCESS_PROTOCOL_VERSION),
  request: LocalWorkflowRequestSchema.extend({
    taskText: LocalWorkflowRequestSchema.shape.taskText.max(16_384),
    targetUrl: LocalWorkflowRequestSchema.shape.targetUrl.max(2_048),
    executionProfileRef: profileRef,
  }),
});
export type SubprocessRequest = z.infer<typeof SubprocessRequestSchema>;

const progress = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('not_started') }),
  z.strictObject({ stage: z.literal('exploration'), explorationAttemptId: id }),
  z.strictObject({
    stage: z.literal('replayed'), explorationAttemptId: id, resolvedSpecId: id,
    executionRunIds: z.tuple([id, id]).refine(([first, second]) => first !== second,
      'Fresh replays require distinct run IDs'),
  }),
]);
export type SubprocessProgress = z.infer<typeof progress>;

const report = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('available'), testSpecId: id }),
]);
const context = z.strictObject({
  testSpecId: id,
  executionProfileRef: profileRef,
  profileFingerprint: fingerprint,
  presentationMode: z.enum(['headless', 'headed']),
  observation: ObservationStateSchema,
  progress,
  report,
}).superRefine((value, issue) => {
  if ((value.presentationMode === 'headed') !== (value.observation.state === 'observational')) {
    issue.addIssue({ code: 'custom', path: ['observation'],
      message: 'Headed results require unverified observational provenance' });
  }
  if (value.report.kind === 'available' && value.report.testSpecId !== value.testSpecId) {
    issue.addIssue({ code: 'custom', path: ['report'], message: 'Report TestSpec ID mismatch' });
  }
  if (value.progress.stage === 'replayed' && value.report.kind !== 'available') {
    issue.addIssue({ code: 'custom', path: ['report'], message: 'Replay requires a stored report' });
  }
  if (value.progress.stage === 'exploration' && value.report.kind !== 'available') {
    issue.addIssue({ code: 'custom', path: ['report'], message: 'Exploration requires a stored report' });
  }
});

const terminal = z.strictObject({
  phase: z.enum(['interpretation', 'exploration', 'locator', 'execution']),
  status: ResultStatusSchema,
  reason: SafeTerminalReasonSchema.optional(),
});
const success = z.strictObject({
  protocolVersion: z.literal(SUBPROCESS_PROTOCOL_VERSION), kind: z.literal('success'),
  context, terminal,
}).superRefine((value, issue) => {
  if (value.context.progress.stage !== 'replayed' || value.terminal.phase !== 'execution' ||
      !['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED'].includes(value.terminal.status)) {
    issue.addIssue({ code: 'custom', message: 'Success requires a successful replay terminal' });
  }
});
const typedStop = z.strictObject({
  protocolVersion: z.literal(SUBPROCESS_PROTOCOL_VERSION), kind: z.literal('typed_stop'),
  stopKind: z.enum(['qa_failure', 'automation_stop']), context, terminal,
}).superRefine((value, issue) => {
  const qa = value.terminal.status === 'QA_ASSERTION_FAILED';
  if ((value.stopKind === 'qa_failure') !== qa ||
      (qa && (value.terminal.phase !== 'execution' || value.context.progress.stage !== 'replayed')) ||
      ['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED'].includes(value.terminal.status)) {
    issue.addIssue({ code: 'custom', message: 'Typed stop category or progress contradicts terminal result' });
  }
});
export const BridgeErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'INVALID_TRUSTED_CONFIGURATION', 'PROFILE_UNAVAILABLE',
  'DESTINATION_DENIED', 'PROVIDER_CONFIGURATION_ERROR', 'CANCELLED',
  'WORKFLOW_FAILED', 'REPORT_INVALID', 'PROTOCOL_INVALID',
  'PROTOCOL_UNSUPPORTED_VERSION', 'REQUEST_TOO_LARGE',
]);
const bridgeError = z.strictObject({
  protocolVersion: z.literal(SUBPROCESS_PROTOCOL_VERSION), kind: z.literal('bridge_error'),
  code: BridgeErrorCodeSchema,
  cleanup: z.enum(['not_started', 'verified', 'unverified']),
});

/** Exactly one of a successful engine result, a typed engine stop, or a bridge error. */
export const SubprocessResponseSchema = z.union([success, typedStop, bridgeError]);
export type SubprocessResponse = z.infer<typeof SubprocessResponseSchema>;

/** A Python-side outcome when no trustworthy Node response exists; never a QA result. */
export const HostProcessFailureSchema = z.strictObject({
  kind: z.literal('process_failure'),
  code: z.enum([
    'LAUNCH_FAILED', 'MISSING_RESPONSE', 'MALFORMED_RESPONSE',
    'MULTIPLE_RESPONSE', 'OUTPUT_LIMIT_EXCEEDED', 'UNEXPECTED_EXIT',
    'CANCELLED', 'DEADLINE_EXCEEDED',
  ]),
  cleanup: z.enum(['not_started', 'verified', 'unverified']),
  forcedTermination: z.boolean(),
  exitCode: z.number().int().min(0).max(255).optional(),
}).superRefine((value, issue) => {
  if (value.forcedTermination && value.cleanup !== 'unverified') {
    issue.addIssue({ code: 'custom', path: ['cleanup'],
      message: 'Forced termination cannot certify cleanup' });
  }
});
export type HostProcessFailure = z.infer<typeof HostProcessFailureSchema>;

export class SubprocessProtocolError extends Error {
  constructor(readonly code: 'PROTOCOL_INVALID' | 'PROTOCOL_UNSUPPORTED_VERSION' |
    'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE') {
    super(code);
    this.name = 'SubprocessProtocolError';
  }
}

function parseDocument(input: string | Uint8Array, maxBytes: number,
  sizeCode: 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE'): unknown {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.byteLength > maxBytes) throw new SubprocessProtocolError(sizeCode);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SubprocessProtocolError('PROTOCOL_INVALID'); }
  if (!content.trim()) throw new SubprocessProtocolError('PROTOCOL_INVALID');
  try { return JSON.parse(content) as unknown; }
  catch { throw new SubprocessProtocolError('PROTOCOL_INVALID'); }
}

function checkVersion(value: unknown): void {
  if (value && typeof value === 'object' && 'protocolVersion' in value &&
      value.protocolVersion !== SUBPROCESS_PROTOCOL_VERSION) {
    throw new SubprocessProtocolError('PROTOCOL_UNSUPPORTED_VERSION');
  }
}

/** Bounded UTF-8 JSON framing: one complete document, optional trailing whitespace. */
export function parseSubprocessRequest(input: string | Uint8Array): SubprocessRequest {
  const value = parseDocument(input, MAX_REQUEST_BYTES, 'REQUEST_TOO_LARGE');
  checkVersion(value);
  const parsed = SubprocessRequestSchema.safeParse(value);
  if (!parsed.success) throw new SubprocessProtocolError('PROTOCOL_INVALID');
  return parsed.data;
}

export function parseSubprocessResponse(input: string | Uint8Array): SubprocessResponse {
  const value = parseDocument(input, MAX_RESPONSE_BYTES, 'RESPONSE_TOO_LARGE');
  checkVersion(value);
  const parsed = SubprocessResponseSchema.safeParse(value);
  if (!parsed.success) throw new SubprocessProtocolError('PROTOCOL_INVALID');
  return parsed.data;
}

export function expectedSubprocessExit(response: SubprocessResponse): number {
  if (response.kind === 'success') return SUBPROCESS_EXIT.success;
  if (response.kind === 'typed_stop') return response.stopKind === 'qa_failure'
    ? SUBPROCESS_EXIT.qaFailure : SUBPROCESS_EXIT.automationStop;
  return response.code === 'CANCELLED' ? SUBPROCESS_EXIT.cancelled : SUBPROCESS_EXIT.bridgeError;
}

/** A mismatch is a host process failure, not a reinterpretation of a Node QA result. */
export function hasExpectedSubprocessExit(response: SubprocessResponse, exitCode: number): boolean {
  return expectedSubprocessExit(response) === exitCode;
}

/** Host-side correlation check after schema validation, before accepting a Node outcome. */
export function responseMatchesRequest(request: SubprocessRequest, response: SubprocessResponse): boolean {
  if (response.kind === 'bridge_error') return true;
  return response.context.executionProfileRef.id === request.request.executionProfileRef.id &&
    response.context.executionProfileRef.version === request.request.executionProfileRef.version;
}
