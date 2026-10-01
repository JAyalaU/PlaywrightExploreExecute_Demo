import { expect, test } from '@playwright/test';
import { AgenticReportProjectionResponseV2Schema } from '../app/subprocess/report-projection-v2.js';
import { parseResultRecordV2, ResultRecordV2Schema } from '../app/domain/agentic-result-v2.js';
import { parseAgenticOutcomeV1 } from '../app/domain/index.js';
import { mapAgenticTerminalV2 } from '../app/interpretation/agentic-external-v2.js';
import type { AgenticProductionOutcome } from '../app/interpretation/agentic-production.js';
import { envelopeForAgenticTerminalV2, parseSubprocessRequestV2,
  parseSubprocessResponseV2, serializeSubprocessResponseV2,
  SubprocessRequestV2Schema, SubprocessResponseV2Schema } from '../app/subprocess/protocol-v2.js';
import { parseSubprocessResponse } from '../app/subprocess/protocol.js';

const base = { resultVersion: '2', workflowVersion: 'agentic-exploration-v1',
  testSpecId: 'testagentic', executionProfileRef: { id: 'public', version: '1' },
  profileFingerprint: 'a'.repeat(64), presentationMode: 'headless', observation: 'no_intervention',
  explorationAttemptId: 'exploreone', executionRunIds: [] as string[], cleanup: 'verified' };
const trace = { successfulTraceId: 'traceone' };
const compiler = { ...trace, compilerAttemptId: 'compilerone' };
const replay = { ...compiler, resolvedSpecId: 'resolvedone', executionRunIds: ['runone', 'runtwo'] };

test('v2 terminal schema has exact closed mappings for every reviewed stage', () => {
  const rows = [
    [{ stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'TARGET_NOT_FOUND' }, {}],
    [{ stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'BUDGET_EXHAUSTED' }, {}],
    [{ stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'UNSAFE_RECOVERY' }, {}],
    [{ stage: 'exploration', status: 'EXPLORATION_UNSUPPORTED', reason: 'UNSUPPORTED_OPERATION' }, {}],
    [{ stage: 'exploration', status: 'EXPLORATION_UNSUPPORTED', reason: 'UNSUPPORTED_CAPABILITY' }, {}],
    [{ stage: 'compilation', status: 'COMPILATION_FAILED', reason: 'WEAK_IDENTITY' }, compiler],
    [{ stage: 'compilation', status: 'COMPILATION_FAILED', reason: 'NON_UNIQUE_MATCH' }, compiler],
    [{ stage: 'compilation', status: 'COMPILATION_FAILED', reason: 'POSTCONDITION_MISMATCH' }, compiler],
    [{ stage: 'compilation', status: 'COMPILATION_UNSUPPORTED', reason: 'UNSUPPORTED_CAPABILITY' }, compiler],
    [{ stage: 'replay', status: 'REPLAY_BINDING_FAILED', reason: 'NO_MATCH' }, replay],
    [{ stage: 'replay', status: 'REPLAY_WAIT_FAILED', reason: 'WAIT_CONDITION_TIMEOUT' }, replay],
    [{ stage: 'replay', status: 'REPLAY_EXECUTION_FAILED', reason: 'REPLAY_EXECUTION_FAILED' }, replay],
    [{ stage: 'reproducibility', status: 'REPRODUCIBILITY_FAILED', reason: 'REPLAY_OUTCOMES_DISAGREE' }, replay],
    [{ stage: 'qa', status: 'QA_ASSERTION_PASSED' }, replay],
    [{ stage: 'qa', status: 'QA_ASSERTION_FAILED', reason: 'URL_MISMATCH' }, replay],
    [{ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'PROVIDER_ERROR' }, {}],
    [{ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'BROWSER_UNAVAILABLE' }, {}],
    [{ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'NETWORK_POLICY_DENIED' }, {}],
    [{ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'COMPILER_ENVIRONMENT_UNAVAILABLE' }, trace],
    [{ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'REPLAY_ENVIRONMENT_UNAVAILABLE' }, replay],
    [{ stage: 'cancellation', status: 'CANCELLED', reason: 'CANCELLED' }, {}],
  ] as const;
  for (const [terminal, provenance] of rows) {
    const result = parseResultRecordV2({ ...base, ...provenance, terminal });
    const envelope = envelopeForAgenticTerminalV2(result, false);
    const wire = serializeSubprocessResponseV2(envelope);
    expect(parseSubprocessResponseV2(wire.body)).toEqual(envelope);
    expect(wire.exitCode).toBe(result.terminal.status === 'QA_ASSERTION_PASSED' ? 0 :
      result.terminal.status === 'QA_ASSERTION_FAILED' ? 1 :
        result.terminal.status === 'CANCELLED' ? 130 : 2);
  }
});

test('v2 rejects unreviewed reason, false QA, incomplete replay, extra private content and cross-version wire', () => {
  const qa = { ...base, ...replay, terminal: { stage: 'qa', status: 'QA_ASSERTION_PASSED' } };
  expect(ResultRecordV2Schema.safeParse(qa).success).toBe(true);
  for (const invalid of [
    { ...qa, executionRunIds: ['runone'] },
    { ...qa, cleanup: 'unverified' },
    { ...qa, expected: 'page text' },
    { ...qa, rawMcpPayload: {} },
    { ...qa, terminal: { stage: 'qa', status: 'QA_ASSERTION_FAILED', reason: 'PROVIDER_ERROR' } },
    { ...qa, terminal: { stage: 'qa', status: 'QA_ASSERTION_PASSED', reason: 'NO_MATCH' } },
    { ...base, terminal: { stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'private provider text' } },
  ]) expect(ResultRecordV2Schema.safeParse(invalid).success).toBe(false);
  const external = envelopeForAgenticTerminalV2(parseResultRecordV2(qa), false);
  if (external.kind === 'bridge_error') throw new Error('Expected agentic result');
  expect(() => parseSubprocessResponse(JSON.stringify(external))).toThrow();
  expect(SubprocessResponseV2Schema.safeParse({ ...external,
    context: { ...external.context, rawTrace: 'secret' } }).success).toBe(false);
  expect(SubprocessResponseV2Schema.safeParse({ ...external, kind: 'typed_stop',
    stopKind: 'automation_stop' }).success).toBe(false);
  const early = envelopeForAgenticTerminalV2(parseResultRecordV2({ ...base,
    terminal: { stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: 'TARGET_NOT_FOUND' } }), false);
  if (early.kind === 'bridge_error') throw new Error('Expected typed stop');
  expect(SubprocessResponseV2Schema.safeParse({ ...early,
    context: { ...early.context, report: { kind: 'available', testSpecId: base.testSpecId } } }).success).toBe(false);
  expect(AgenticReportProjectionResponseV2Schema.safeParse({ reportProjectionVersion: '2',
    kind: 'available', rawTrace: {} }).success).toBe(false);
});

test('v2 request has no workflow or authority field and rejects v1', () => {
  const request = { protocolVersion: '2', request: { taskText: 'Check the link',
    targetUrl: 'https://example.com/', executionProfileRef: { id: 'public', version: '1' } } };
  expect(parseSubprocessRequestV2(JSON.stringify(request))).toEqual(request);
  expect(SubprocessRequestV2Schema.safeParse({ ...request, request: { ...request.request,
    workflowVersion: 'agentic-exploration-v1' } }).success).toBe(false);
  expect(() => parseSubprocessRequestV2(JSON.stringify({ ...request, protocolVersion: '1' }))).toThrow();
});

test('partial replay and uncertain cleanup remain non-QA and keep actual progress', () => {
  const partial = parseResultRecordV2({ ...base, ...compiler, resolvedSpecId: 'resolvedone',
    executionRunIds: ['runone'], terminal: { stage: 'environment', status: 'ENVIRONMENT_FAILED',
      reason: 'REPLAY_ENVIRONMENT_UNAVAILABLE' } });
  const wire = envelopeForAgenticTerminalV2(partial, false);
  expect(wire).toMatchObject({ kind: 'typed_stop', stopKind: 'environment_stop',
    context: { progress: { stage: 'replay', executionRunIds: ['runone'] } } });
  const uncertain = parseResultRecordV2({ ...base, ...compiler, resolvedSpecId: 'resolvedone',
    executionRunIds: ['runone'], cleanup: 'unverified',
    terminal: { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED' } });
  expect(envelopeForAgenticTerminalV2(uncertain, false)).toMatchObject({ kind: 'typed_stop',
    context: { result: { cleanup: 'unverified' } } });
  expect(ResultRecordV2Schema.safeParse({ ...uncertain,
    terminal: { stage: 'qa', status: 'QA_ASSERTION_PASSED' } }).success).toBe(false);
});

test('private stop normalization preserves environment, cancellation, compiler and replay distinctions', () => {
  const stopped = (stage: 'exploration' | 'compilation' | 'replay', boundary: 'exploration' | 'environment' | 'compilation' | 'replay',
    status: string, reasonCode: string, cleanup: 'verified' | 'unverified' = 'verified') =>
    ({ kind: 'stopped', stage, attemptId: 'exploreone', reasonCode, cleanup,
      outcome: parseAgenticOutcomeV1({ boundary, status }) } as AgenticProductionOutcome);
  expect(mapAgenticTerminalV2(stopped('exploration', 'environment', 'unavailable', 'BROWSER_UNAVAILABLE')))
    .toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'BROWSER_UNAVAILABLE' });
  expect(mapAgenticTerminalV2(stopped('exploration', 'environment', 'cancelled', 'CANCELLED')))
    .toEqual({ stage: 'cancellation', status: 'CANCELLED', reason: 'CANCELLED' });
  expect(mapAgenticTerminalV2(stopped('compilation', 'compilation', 'durability_failed', 'WEAK_IDENTITY')))
    .toEqual({ stage: 'compilation', status: 'COMPILATION_FAILED', reason: 'WEAK_IDENTITY' });
  expect(mapAgenticTerminalV2(stopped('replay', 'replay', 'not_reproduced', 'REPLAY_OUTCOMES_DISAGREE')))
    .toEqual({ stage: 'reproducibility', status: 'REPRODUCIBILITY_FAILED', reason: 'REPLAY_OUTCOMES_DISAGREE' });
  expect(mapAgenticTerminalV2(stopped('exploration', 'environment', 'unavailable', 'private text')))
    .toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'REDACTED_REASON' });
  expect(mapAgenticTerminalV2(stopped('replay', 'replay', 'execution_failed', 'private text', 'unverified')))
    .toEqual({ stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED' });
});
