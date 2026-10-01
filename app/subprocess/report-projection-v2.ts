import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ResultStatusSchema } from '../domain/schema.js';
import { AgenticSafeReasonV2Schema, AgenticTerminalV2Schema,
  type ResultRecordV2 } from '../domain/agentic-result-v2.js';
import { LocalArtifactStore } from '../evidence/store.js';
import { parseTrustedLocalConfiguration } from '../local/contracts.js';
import { SubprocessResponseV2Schema } from './protocol-v2.js';

export const REPORT_PROJECTION_V2 = '2' as const;
export const MAX_PROJECTION_V2_REQUEST_BYTES = 8_192;
export const MAX_PROJECTION_V2_RESPONSE_BYTES = 65_536;
const MAX_ARTIFACT_BYTES = 16 * 1_048_576;
const MAX_ARTIFACT_FILES = 512;
const MAX_OUTCOMES = 128;
const MAX_EVIDENCE = 64;
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const unavailableReason = z.enum(['REPORT_UNAVAILABLE', 'REPORT_NOT_FOUND', 'REPORT_EXPIRED',
  'CORRELATION_MISMATCH', 'REPORT_INVALID', 'REPORT_TOO_LARGE', 'INVALID_REQUEST',
  'CONFIGURATION_UNAVAILABLE']);
const stage = z.strictObject({ status: z.enum(['not_started', 'completed', 'stopped']),
  reason: AgenticSafeReasonV2Schema.optional() });
const safeValue = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({ state: z.literal('withheld') }),
  z.strictObject({ state: z.literal('displayable'), value: z.union([z.number().finite(), z.boolean(), z.null()]) }),
]);
const outcome = z.strictObject({ executionRunId: id, originStepId: id.optional(),
  executionStepId: id.optional(), status: ResultStatusSchema,
  reason: AgenticSafeReasonV2Schema.optional(), expected: safeValue, actual: safeValue });
const evidence = z.strictObject({ evidenceId: id, owner: z.strictObject({ kind: z.literal('run'), id }),
  originStepId: id.optional(), executionStepId: id.optional(),
  mediaType: z.enum(['application/json', 'text/plain', 'image/png', 'application/zip', 'video/webm']),
  sensitivity: z.enum(['redacted', 'restricted']), capturedAt: z.iso.datetime(),
  byteLength: z.number().int().nonnegative() });
export const AgenticReportProjectionRequestV2Schema = z.strictObject({
  reportProjectionVersion: z.literal(REPORT_PROJECTION_V2), result: SubprocessResponseV2Schema,
});
export type AgenticReportProjectionRequestV2 = z.infer<typeof AgenticReportProjectionRequestV2Schema>;
export const AgenticReportProjectionResponseV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ reportProjectionVersion: z.literal(REPORT_PROJECTION_V2),
    kind: z.literal('unavailable'), reason: unavailableReason }),
  z.strictObject({ reportProjectionVersion: z.literal(REPORT_PROJECTION_V2), kind: z.literal('available'),
    testSpecId: id, executionProfileRef: z.strictObject({ id, version: z.string().max(64) }),
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    explorationAttemptId: id, successfulTraceId: id,
    compilerAttemptId: id.optional(), resolvedSpecId: id.optional(), executionRunIds: z.array(id).max(2),
    terminal: AgenticTerminalV2Schema,
    stages: z.strictObject({ exploration: stage, compilation: stage, replay: stage }),
    replays: z.array(z.strictObject({ executionRunId: id,
      state: z.enum(['completed_pass', 'completed_fail', 'automation_failed', 'unavailable']) })).max(2),
    reproducibility: z.enum(['not_established', 'agreed', 'disagreed']),
    authoritativeQa: z.enum(['QA_ASSERTION_PASSED', 'QA_ASSERTION_FAILED']).optional(),
    observation: z.enum(['unobserved', 'no_intervention', 'intervened', 'observational']),
    cleanup: z.enum(['not_started', 'verified', 'unverified']),
    outcomes: z.array(outcome).max(MAX_OUTCOMES), evidence: z.array(evidence).max(MAX_EVIDENCE),
    screenshot: z.enum(['capture_disabled', 'not_captured', 'stored_restricted']),
  }),
]).superRefine((projection, issue) => {
  if (projection.kind !== 'available') return;
  const qa = projection.terminal.stage === 'qa';
  if ((projection.authoritativeQa !== undefined) !== qa ||
    (qa && (projection.authoritativeQa !== projection.terminal.status ||
      projection.replays.length !== 2 || projection.reproducibility !== 'agreed')))
    issue.addIssue({ code: 'custom', path: ['authoritativeQa'],
      message: 'Only matching completed replays may carry a QA verdict' });
  if ((projection.reproducibility === 'disagreed') !== (projection.terminal.stage === 'reproducibility'))
    issue.addIssue({ code: 'custom', path: ['reproducibility'],
      message: 'Disagreement must be a reproducibility stop' });
  if (!qa && projection.outcomes.some((item) => item.expected.state === 'displayable' ||
    item.actual.state === 'displayable'))
    issue.addIssue({ code: 'custom', path: ['outcomes'],
      message: 'Non-QA outcome cannot expose assertion values' });
  if (projection.cleanup === 'unverified' && (projection.terminal.stage !== 'environment' ||
    projection.terminal.reason !== 'SESSION_CLEANUP_FAILED'))
    issue.addIssue({ code: 'custom', path: ['cleanup'],
      message: 'Unverified cleanup requires environment overlay' });
});
export type AgenticReportProjectionResponseV2 = z.infer<typeof AgenticReportProjectionResponseV2Schema>;
type Reason = z.infer<typeof unavailableReason>;
const unavailable = (reason: Reason): AgenticReportProjectionResponseV2 =>
  ({ reportProjectionVersion: REPORT_PROJECTION_V2, kind: 'unavailable', reason });
function value(input: unknown, present: boolean, qa: boolean): z.infer<typeof safeValue> {
  if (!present) return { state: 'absent' };
  if (!qa || typeof input === 'string') return { state: 'withheld' };
  if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input))
    return { state: 'displayable', value: input };
  return { state: 'withheld' };
}

/** Read-only Node reconstruction. Every source and run is checked before projection. */
export async function projectStoredAgenticReportV2(input: unknown, configInput: unknown): Promise<AgenticReportProjectionResponseV2> {
  const request = AgenticReportProjectionRequestV2Schema.safeParse(input);
  if (!request.success) return unavailable('INVALID_REQUEST');
  const response = request.data.result;
  if (response.kind === 'bridge_error' || response.context.report.kind !== 'available')
    return unavailable('REPORT_UNAVAILABLE');
  let config: ReturnType<typeof parseTrustedLocalConfiguration>;
  try { config = parseTrustedLocalConfiguration(configInput); }
  catch { return unavailable('CONFIGURATION_UNAVAILABLE'); }
  const result: ResultRecordV2 = response.context.result;
  if (result.workflowVersion === 'deferred-action-v1') return unavailable('REPORT_UNAVAILABLE');
  const store = new LocalArtifactStore(config.artifactRoot, undefined, config.retentionDays);
  try {
    await store.assertProjectionReadBudget(result.testSpecId, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES);
    const { source, profile } = await store.readJob(result.testSpecId);
    const terminal = await store.readAgenticTerminalV2(result.testSpecId);
    if (JSON.stringify(terminal) !== JSON.stringify(result) ||
      JSON.stringify(source.executionProfileRef) !== JSON.stringify(result.executionProfileRef) ||
      profile.fingerprint !== result.profileFingerprint) return unavailable('CORRELATION_MISMATCH');
    if (!result.explorationAttemptId || !result.successfulTraceId)
      return unavailable('REPORT_UNAVAILABLE');
    const goalDirected = result.workflowVersion === 'goal-directed-v1';
    const structured = result.workflowVersion === 'structured-action-v1';
    if (goalDirected && source.schemaVersion !== '4') return unavailable('CORRELATION_MISMATCH');
    if (structured && source.schemaVersion !== '5') return unavailable('CORRELATION_MISMATCH');
    const { trace } = structured ?
      await store.readSuccessfulExplorationV4(result.testSpecId, result.explorationAttemptId) :
      goalDirected ?
      await store.readSuccessfulExplorationV3(result.testSpecId, result.explorationAttemptId) :
      await store.readSuccessfulExploration(result.testSpecId, result.explorationAttemptId);
    if (trace.traceVersion !== (structured ? '4' : goalDirected ? '3' : '2') ||
      trace.successfulTraceId !== result.successfulTraceId ||
      trace.profileFingerprint !== result.profileFingerprint)
      return unavailable('CORRELATION_MISMATCH');
    let compilerStatus: 'none' | 'accepted' | 'rejected' = 'none';
    if (result.compilerAttemptId) {
      const compiler = structured ? await store.readCompilerAttemptV3(result.testSpecId,
        result.explorationAttemptId, result.compilerAttemptId) :
        goalDirected ? await store.readCompilerAttemptV2(result.testSpecId,
        result.explorationAttemptId, result.compilerAttemptId) :
        await store.readCompilerAttemptV1(result.testSpecId,
          result.explorationAttemptId, result.compilerAttemptId);
      compilerStatus = compiler.result.status;
      if (compiler.successfulTraceId !== result.successfulTraceId ||
          compiler.profileFingerprint !== result.profileFingerprint)
        return unavailable('CORRELATION_MISMATCH');
      if (result.resolvedSpecId) {
        if (compiler.result.status !== 'accepted' || compiler.result.resolvedSpecId !== result.resolvedSpecId)
          return unavailable('CORRELATION_MISMATCH');
        const { resolved } = structured ? await store.readCompiledExplorationV8(result.testSpecId,
          result.explorationAttemptId, result.compilerAttemptId) :
          goalDirected ? await store.readCompiledExplorationV7(result.testSpecId,
          result.explorationAttemptId, result.compilerAttemptId) :
          await store.readCompiledExplorationV6(result.testSpecId,
            result.explorationAttemptId, result.compilerAttemptId);
        if (resolved.resolvedSpecId !== result.resolvedSpecId ||
          resolved.successfulTraceId !== result.successfulTraceId ||
          resolved.profileFingerprint !== result.profileFingerprint)
          return unavailable('CORRELATION_MISMATCH');
      } else if (compiler.result.status !== 'rejected') return unavailable('CORRELATION_MISMATCH');
    } else if (result.resolvedSpecId) return unavailable('CORRELATION_MISMATCH');
    const runs = await Promise.all(result.executionRunIds.map((runId) => store.readRun(result.testSpecId, runId)));
    if (new Set(result.executionRunIds).size !== result.executionRunIds.length || runs.some((run, index) =>
      run.executionRunId !== result.executionRunIds[index] || run.resolvedSpecId !== result.resolvedSpecId ||
      run.explorationAttemptId !== result.explorationAttemptId || run.profileFingerprint !== result.profileFingerprint ||
      JSON.stringify(run.executionProfileRef) !== JSON.stringify(result.executionProfileRef)))
      return unavailable('CORRELATION_MISMATCH');
    const state = (run: typeof runs[number]): 'completed_pass' | 'completed_fail' | 'automation_failed' => {
      if (run.outcomes.some((item) => !['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
        'QA_ASSERTION_FAILED', 'NOT_RUN'].includes(item.status))) return 'automation_failed';
      if (run.outcomes.some((item) => item.status === 'QA_ASSERTION_FAILED')) return 'completed_fail';
      return run.outcomes.some((item) => item.status === 'QA_ASSERTION_PASSED') ? 'completed_pass' : 'automation_failed';
    };
    const states = runs.map(state);
    const qa = result.terminal.stage === 'qa';
    if (qa && (runs.length !== 2 || states.some((item) => item !==
      (result.terminal.status === 'QA_ASSERTION_PASSED' ? 'completed_pass' : 'completed_fail')) ||
      JSON.stringify(runs[0]?.outcomes.map((item) => [item.executionStepId, item.status, item.reason])) !==
      JSON.stringify(runs[1]?.outcomes.map((item) => [item.executionStepId, item.status, item.reason]))))
      return unavailable('CORRELATION_MISMATCH');
    if (result.terminal.stage === 'reproducibility' && (runs.length !== 2 ||
      JSON.stringify(runs[0]?.outcomes.map((item) => [item.executionStepId, item.status, item.reason])) ===
      JSON.stringify(runs[1]?.outcomes.map((item) => [item.executionStepId, item.status, item.reason]))))
      return unavailable('CORRELATION_MISMATCH');
    if (result.terminal.stage === 'compilation' && compilerStatus !== 'rejected')
      return unavailable('CORRELATION_MISMATCH');
    if (result.terminal.stage === 'compilation' && result.compilerAttemptId) {
      const compiler = structured ? await store.readCompilerAttemptV3(result.testSpecId,
        result.explorationAttemptId, result.compilerAttemptId) :
        goalDirected ? await store.readCompilerAttemptV2(result.testSpecId,
        result.explorationAttemptId, result.compilerAttemptId) :
        await store.readCompilerAttemptV1(result.testSpecId,
          result.explorationAttemptId, result.compilerAttemptId);
      const reviewedUnsupported = (goalDirected || structured) &&
        result.terminal.status === 'COMPILATION_UNSUPPORTED' &&
        compiler.result.status === 'rejected' && compiler.result.reasonCode.startsWith('UNSUPPORTED_') &&
        result.terminal.reason === 'UNSUPPORTED_CAPABILITY';
      if (compiler.result.status !== 'rejected' ||
        (result.terminal.reason !== 'REDACTED_REASON' &&
          result.terminal.reason !== compiler.result.reasonCode && !reviewedUnsupported))
        return unavailable('CORRELATION_MISMATCH');
    }
    if (result.terminal.stage === 'replay') {
      const failure = runs.flatMap((run) => run.outcomes);
      const witnessed = result.terminal.status === 'REPLAY_BINDING_FAILED' ?
        failure.some((item) => item.status === 'LOCATOR_BINDING_FAILED') :
        result.terminal.status === 'REPLAY_WAIT_FAILED' ?
          failure.some((item) => item.status === 'BROWSER_EXECUTION_FAILED' &&
            ['WAIT_CONDITION_TIMEOUT', 'UNKNOWN_TIMEOUT_POLICY'].includes(item.reason ?? '')) :
          failure.some((item) => item.status === 'BROWSER_EXECUTION_FAILED');
      if (!witnessed) return unavailable('CORRELATION_MISMATCH');
    }
    const records = runs.flatMap((run) => run.outcomes);
    if (records.length > MAX_OUTCOMES) return unavailable('REPORT_TOO_LARGE');
    const descriptors = await Promise.all(records.flatMap((item) => item.evidenceRefs).map((ref) =>
      store.readEvidence(result.testSpecId, ref)));
    if (descriptors.length > MAX_EVIDENCE || descriptors.some((item) =>
      item.owner.kind !== 'run' || !result.executionRunIds.includes(item.owner.id)))
      return unavailable('REPORT_TOO_LARGE');
    const display = {
      reportProjectionVersion: REPORT_PROJECTION_V2, kind: 'available',
      testSpecId: result.testSpecId, executionProfileRef: result.executionProfileRef,
      profileFingerprint: result.profileFingerprint, explorationAttemptId: result.explorationAttemptId,
      successfulTraceId: result.successfulTraceId,
      ...(result.compilerAttemptId ? { compilerAttemptId: result.compilerAttemptId } : {}),
      ...(result.resolvedSpecId ? { resolvedSpecId: result.resolvedSpecId } : {}),
      executionRunIds: result.executionRunIds, terminal: result.terminal,
      stages: {
        exploration: { status: 'completed' },
        compilation: { status: compilerStatus === 'accepted' ? 'completed' : compilerStatus === 'rejected' ? 'stopped' : 'not_started',
          ...(result.terminal.stage === 'compilation' && 'reason' in result.terminal ? { reason: result.terminal.reason } : {}) },
        replay: { status: qa || result.terminal.stage === 'reproducibility' ? 'completed' :
          result.terminal.stage === 'replay' ? 'stopped' : 'not_started',
          ...(result.terminal.stage === 'replay' && 'reason' in result.terminal ? { reason: result.terminal.reason } : {}) },
      },
      replays: runs.map((run, index) => ({ executionRunId: run.executionRunId, state: states[index] })),
      reproducibility: result.terminal.stage === 'reproducibility' ? 'disagreed' : qa ? 'agreed' : 'not_established',
      ...(qa ? { authoritativeQa: result.terminal.status } : {}),
      observation: result.observation, cleanup: result.cleanup,
      outcomes: records.map((item) => ({ executionRunId: item.executionRunId,
        ...(item.originStepId ? { originStepId: item.originStepId } : {}),
        ...(item.executionStepId ? { executionStepId: item.executionStepId } : {}),
        status: item.status,
        ...(item.reason ? { reason: AgenticSafeReasonV2Schema.safeParse(item.reason).success ? item.reason : 'REDACTED_REASON' } : {}),
        expected: value(item.expected, Object.hasOwn(item, 'expected'), qa),
        actual: value(item.actual, Object.hasOwn(item, 'actual'), qa),
      })),
      evidence: descriptors.map((item) => ({ evidenceId: item.evidenceId, owner: item.owner,
        ...(item.originStepId ? { originStepId: item.originStepId } : {}),
        ...(item.executionStepId ? { executionStepId: item.executionStepId } : {}),
        mediaType: item.mediaType, sensitivity: item.sensitivity,
        capturedAt: item.capturedAt, byteLength: item.byteLength })),
      screenshot: descriptors.some((item) => item.mediaType === 'image/png') ? 'stored_restricted' :
        !config.evidencePolicy.finalScreenshot && !config.evidencePolicy.failureScreenshot ?
          'capture_disabled' : 'not_captured',
    };
    const parsed = AgenticReportProjectionResponseV2Schema.safeParse(display);
    if (!parsed.success) return unavailable('REPORT_INVALID');
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') + 1 > MAX_PROJECTION_V2_RESPONSE_BYTES)
      return unavailable('REPORT_TOO_LARGE');
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && /budget exceeded/.test(error.message)) return unavailable('REPORT_TOO_LARGE');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable('REPORT_NOT_FOUND');
    if (error instanceof Error && /retention expired/.test(error.message)) return unavailable('REPORT_EXPIRED');
    return unavailable('REPORT_INVALID');
  }
}

export function parseAgenticReportProjectionRequestV2(bytes: Uint8Array): AgenticReportProjectionRequestV2 {
  if (bytes.byteLength > MAX_PROJECTION_V2_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error('INVALID_REQUEST'); }
  return AgenticReportProjectionRequestV2Schema.parse(value);
}
