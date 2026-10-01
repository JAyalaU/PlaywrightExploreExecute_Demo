import { z } from 'zod';
import { ResultStatusSchema } from '../domain/schema.js';
import { LocalArtifactStore, readStoredJobReport } from '../evidence/index.js';
import { parseTrustedLocalConfiguration } from '../local/contracts.js';
import { SafeTerminalReasonSchema, SubprocessResponseSchema, safeTerminalReason } from './protocol.js';

export const REPORT_PROJECTION_VERSION = '1' as const;
export const MAX_PROJECTION_REQUEST_BYTES = 8_192;
export const MAX_PROJECTION_RESPONSE_BYTES = 65_536;
const MAX_ARTIFACT_BYTES = 16 * 1_048_576;
const MAX_ARTIFACT_FILES = 512;
const MAX_OUTCOMES = 128;
const MAX_EVIDENCE = 64;
const display = z.string().max(256).refine((value) => Buffer.byteLength(value, 'utf8') <= 256);
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

export const ReportProjectionRequestSchema = z.strictObject({
  reportProjectionVersion: z.literal(REPORT_PROJECTION_VERSION),
  result: SubprocessResponseSchema,
});
export type ReportProjectionRequest = z.infer<typeof ReportProjectionRequestSchema>;

const value = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('withheld') }),
  z.strictObject({ state: z.literal('displayable'), value: z.union([z.number().finite(), z.boolean(), z.null()]) }),
]);
const outcome = z.strictObject({
  phase: z.enum(['interpretation', 'exploration', 'locator', 'execution']),
  status: ResultStatusSchema,
  reason: SafeTerminalReasonSchema.optional(),
  originStepId: id.optional(), executionStepId: id.optional(),
  executionRunId: id.optional(), assertionType: z.enum([
    'assert_visible', 'assert_text', 'assert_value', 'assert_url', 'assert_link_collection',
  ]).optional(),
  expected: value, actual: value,
});
const evidence = z.strictObject({
  evidenceId: id, owner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('attempt'), id }),
    z.strictObject({ kind: z.literal('run'), id }),
  ]),
  originStepId: id.optional(), executionStepId: id.optional(),
  mediaType: z.enum(['application/json', 'text/plain', 'image/png', 'application/zip', 'video/webm']),
  sensitivity: z.enum(['redacted', 'restricted']),
  capturedAt: z.iso.datetime(), byteLength: z.number().int().nonnegative(),
});
const unavailableReason = z.enum([
  'REPORT_UNAVAILABLE', 'REPORT_NOT_FOUND', 'REPORT_EXPIRED', 'CORRELATION_MISMATCH',
  'REPORT_INVALID', 'REPORT_TOO_LARGE', 'INVALID_REQUEST', 'CONFIGURATION_UNAVAILABLE',
]);
export const ReportProjectionResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ reportProjectionVersion: z.literal(REPORT_PROJECTION_VERSION),
    kind: z.literal('unavailable'), reason: unavailableReason }),
  z.strictObject({
    reportProjectionVersion: z.literal(REPORT_PROJECTION_VERSION), kind: z.literal('available'),
    testSpecId: id, executionProfileRef: z.strictObject({ id, version: display }),
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    explorationAttemptId: id.optional(), resolvedSpecId: id.optional(),
    executionRunIds: z.array(id).max(2),
    terminal: z.strictObject({ phase: outcome.shape.phase, status: outcome.shape.status,
      reason: SafeTerminalReasonSchema.optional() }),
    observation: z.enum(['unobserved', 'no_intervention', 'intervened', 'observational']),
    outcomes: z.array(outcome).max(MAX_OUTCOMES),
    evidence: z.array(evidence).max(MAX_EVIDENCE),
    screenshot: z.enum(['capture_disabled', 'not_captured', 'stored_restricted']),
  }),
]);
export type ReportProjectionResponse = z.infer<typeof ReportProjectionResponseSchema>;

function unavailable(reason: z.infer<typeof unavailableReason>): ReportProjectionResponse {
  return { reportProjectionVersion: REPORT_PROJECTION_VERSION, kind: 'unavailable', reason };
}

function safeValue(input: unknown, present: boolean): z.infer<typeof value> {
  if (!present) return { state: 'absent' };
  // Page text and URLs are untrusted even when stored evidence was redacted.
  if (typeof input === 'string') return { state: 'withheld' };
  if (input === null || typeof input === 'boolean' ||
    (typeof input === 'number' && Number.isFinite(input))) return { state: 'displayable', value: input };
  return { state: 'withheld' };
}

/** Node owns artifact reconstruction and classification; the host receives metadata only. */
export async function projectStoredReport(input: unknown, configInput: unknown): Promise<ReportProjectionResponse> {
  const request = ReportProjectionRequestSchema.safeParse(input);
  if (!request.success) return unavailable('INVALID_REQUEST');
  const result = request.data.result;
  if (result.kind === 'bridge_error' || result.context.report.kind !== 'available') {
    return unavailable('REPORT_UNAVAILABLE');
  }
  let config: ReturnType<typeof parseTrustedLocalConfiguration>;
  try { config = parseTrustedLocalConfiguration(configInput); }
  catch { return unavailable('CONFIGURATION_UNAVAILABLE'); }
  const { context } = result;
  const store = new LocalArtifactStore(config.artifactRoot, undefined, config.retentionDays);
  try {
    await store.assertProjectionReadBudget(context.testSpecId, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES);
    const report = await readStoredJobReport(store, context.testSpecId);
    if (report.testSpec.testSpecId !== context.testSpecId ||
      report.effectiveProfile.fingerprint !== context.profileFingerprint ||
      report.testSpec.executionProfileRef.id !== context.executionProfileRef.id ||
      report.testSpec.executionProfileRef.version !== context.executionProfileRef.version) {
      return unavailable('CORRELATION_MISMATCH');
    }
    const progress = context.progress;
    const attemptId = progress.stage === 'not_started' ? undefined : progress.explorationAttemptId;
    const attempt = attemptId ? report.attempts.find((item) => item.explorationAttemptId === attemptId) : undefined;
    if (attemptId && !attempt) return unavailable('CORRELATION_MISMATCH');
    const resolved = progress.stage === 'replayed'
      ? report.resolvedSpecs.find((item) => item.resolvedSpecId === progress.resolvedSpecId &&
        item.explorationAttemptId === progress.explorationAttemptId) : undefined;
    if (progress.stage === 'replayed' && !resolved) return unavailable('CORRELATION_MISMATCH');
    const runIds = progress.stage === 'replayed' ? progress.executionRunIds : [];
    const runs = runIds.map((runId) => report.runs.find((item) => item.executionRunId === runId &&
      item.resolvedSpecId === resolved?.resolvedSpecId && item.explorationAttemptId === attemptId));
    if (runs.some((item) => !item)) return unavailable('CORRELATION_MISMATCH');
    const steps = new Map(resolved?.executionSteps.map((step) => [step.id, step]) ?? []);
    const records = [...(attempt?.results ?? []), ...runs.flatMap((run) => run?.outcomes ?? [])];
    if (!records.some((record) => record.phase === result.terminal.phase &&
      record.status === result.terminal.status &&
      safeTerminalReason(record.reason) === result.terminal.reason)) {
      return unavailable('CORRELATION_MISMATCH');
    }
    if (result.kind === 'success' && runs.some((run) => run?.outcomes.some((record) =>
      !['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED'].includes(record.status)))) {
      return unavailable('CORRELATION_MISMATCH');
    }
    const allowedOwners = new Set([...(attemptId ? [`attempt:${attemptId}`] : []),
      ...runIds.map((runId) => `run:${runId}`)]);
    const descriptors = report.evidence.filter((item) => allowedOwners.has(`${item.owner.kind}:${item.owner.id}`));
    if (records.length > MAX_OUTCOMES || descriptors.length > MAX_EVIDENCE) return unavailable('REPORT_TOO_LARGE');
    const projected: ReportProjectionResponse = {
      reportProjectionVersion: REPORT_PROJECTION_VERSION, kind: 'available',
      testSpecId: context.testSpecId, executionProfileRef: context.executionProfileRef,
      profileFingerprint: context.profileFingerprint,
      ...(attemptId ? { explorationAttemptId: attemptId } : {}),
      ...(resolved ? { resolvedSpecId: resolved.resolvedSpecId } : {}), executionRunIds: [...runIds],
      terminal: result.terminal, observation: context.observation.state,
      outcomes: records.map((record) => {
        const step = record.executionStepId ? steps.get(record.executionStepId) : undefined;
        return {
          phase: record.phase, status: record.status,
          ...(record.reason ? { reason: safeTerminalReason(record.reason) } : {}),
          ...(record.originStepId ? { originStepId: record.originStepId } : {}),
          ...(record.executionStepId ? { executionStepId: record.executionStepId } : {}),
          ...(record.executionRunId ? { executionRunId: record.executionRunId } : {}),
          ...(step && step.type.startsWith('assert_') ? { assertionType: step.type as
            'assert_visible' | 'assert_text' | 'assert_value' | 'assert_url' | 'assert_link_collection' } : {}),
          expected: safeValue(record.expected, Object.hasOwn(record, 'expected')),
          actual: safeValue(record.actual, Object.hasOwn(record, 'actual')),
        };
      }),
      evidence: descriptors.map((item) => ({
        evidenceId: item.evidenceId, owner: item.owner,
        ...(item.originStepId ? { originStepId: item.originStepId } : {}),
        ...(item.executionStepId ? { executionStepId: item.executionStepId } : {}),
        mediaType: item.mediaType, sensitivity: item.sensitivity,
        capturedAt: item.capturedAt, byteLength: item.byteLength,
      })),
      screenshot: descriptors.some((item) => item.mediaType === 'image/png')
        ? 'stored_restricted' : !config.evidencePolicy.finalScreenshot && !config.evidencePolicy.failureScreenshot
          ? 'capture_disabled' : 'not_captured',
    };
    const validated = ReportProjectionResponseSchema.safeParse(projected);
    if (!validated.success) return unavailable('REPORT_INVALID');
    if (Buffer.byteLength(JSON.stringify(validated.data), 'utf8') + 1 > MAX_PROJECTION_RESPONSE_BYTES) {
      return unavailable('REPORT_TOO_LARGE');
    }
    return validated.data;
  } catch (error) {
    if (error instanceof Error && /budget exceeded/.test(error.message)) return unavailable('REPORT_TOO_LARGE');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable('REPORT_NOT_FOUND');
    if (error instanceof Error && /retention expired/.test(error.message)) return unavailable('REPORT_EXPIRED');
    return unavailable('REPORT_INVALID');
  }
}

export function parseReportProjectionRequest(bytes: Uint8Array): ReportProjectionRequest {
  if (bytes.byteLength > MAX_PROJECTION_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  const parsed = ReportProjectionRequestSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  if (!parsed.success) throw new Error('INVALID_REQUEST');
  return parsed.data;
}
