import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  AgenticOutcomeV1Schema, ExplorationBranchDiagnosticV1Schema, ResolvedTestSpecSchema,
  SuccessfulPathRecordV1Schema,
  parseCompilerAttemptV1, parseCurrentTargetBinding, parseExplorationBranchDiagnosticV1,
  parseResolvedTestSpec, parseResolvedTestSpecV6, parseSuccessfulExplorationTraceV1,
  parseTestSpec,
} from '../app/domain/index.js';
import { makeResolvedSpec, makeTestSpec } from './fixtures/domain.js';
import { SubprocessResponseSchema, SUBPROCESS_PROTOCOL_VERSION } from '../app/subprocess/protocol.js';
import { ReportProjectionResponseSchema, REPORT_PROJECTION_VERSION } from '../app/subprocess/report-projection.js';

const d = (letter: string): string => letter.repeat(64);
const profile = { id: 'desktop', version: '1' };
const source = parseTestSpec({ schemaVersion: '2', testSpecId: 'test-agentic',
  sourceInstruction: 'Go to example, click Save, and confirm URL', executionProfileRef: profile,
  startState: { url: 'about:blank' }, steps: [
    { id: 's1', type: 'navigate', sourceText: 'Go to example', url: 'https://example.com/' },
    { id: 's2', type: 'click', sourceText: 'Click Save', target: { description: 'Save button' } },
    { id: 's3', type: 'assert_url', sourceText: 'Confirm URL', expectedUrl: 'https://example.com/done', match: 'exact' },
  ] });
const owner = { testSpecId: source.testSpecId, explorationAttemptId: 'explore-agentic',
  executionProfileRef: profile, profileFingerprint: d('a') };
const activeCore = { ...owner, sessionId: 'session-one', pageId: 'page-one', frameId: 'frame-main',
  snapshotEpoch: 2, snapshotDigest: d('b') };
const active = { ...activeCore, selectedRef: 'ref-save', selectedRefCount: 1,
  selectedNode: { role: 'button', accessibleName: 'Save' }, visible: true, enabled: true };
const binding = { bindingVersion: '1', bindingId: 'binding-save', ...activeCore,
  issuedAt: '2026-09-24T10:00:01.000Z',
  selectedRef: 'ref-save', originStepId: 's2', operation: 'click',
  selectedNode: { role: 'button', accessibleName: 'Save' }, justificationCode: 'authored_target' };
const attempt = { attemptVersion: '3', ...owner, status: 'path_established',
  successfulTraceId: 'trace-one', startedAt: '2026-09-24T10:00:00.000Z',
  finishedAt: '2026-09-24T10:00:03.000Z' };
const trace = { traceVersion: '1', successfulTraceId: 'trace-one', ...owner,
  sessionId: 'session-one', startStateDigest: d('1'), finalStateDigest: d('4'),
  startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:00:03.000Z',
  bindings: [binding], completedOriginStepIds: ['s1', 's2', 's3'], successfulPath: [
    { recordId: 'record-one', sequence: 1, originStepId: 's1', source: 'authored',
      preStateDigest: d('1'), postStateDigest: d('2'), observationDigest: d('5'),
      type: 'navigate', url: 'https://example.com/', result: 'completed' },
    { recordId: 'record-two', sequence: 2, originStepId: 's2', source: 'authored',
      preStateDigest: d('2'), postStateDigest: d('3'), observationDigest: d('6'),
      type: 'click', bindingId: 'binding-save', result: 'completed' },
    { recordId: 'record-three', sequence: 3, originStepId: 's3', source: 'authored',
      preStateDigest: d('3'), postStateDigest: d('4'), observationDigest: d('7'),
      type: 'assert_url', expectedUrl: 'https://example.com/done', match: 'exact', result: 'passed' },
  ] };
const form = { type: 'role', role: 'button', name: 'Save', exact: true };
const candidateDigest = createHash('sha256').update(JSON.stringify(form)).digest('hex');
const checks = [
  ...(['closed_form', 'durable_identity', 'unique_match', 'selected_target'] as const).map((kind, index) => ({
    checkId: `check-target-${index}`, traceRecordId: 'record-two', kind, result: 'passed',
    reasonCode: 'NONE', candidateDigest,
    ...(kind === 'unique_match' ? { observedMatchCount: 1 } : {}),
    ...(kind === 'selected_target' ? { selectedTargetMatches: true } : {}),
  })),
  { checkId: 'check-profile', traceRecordId: 'record-one', kind: 'profile_equivalence',
    result: 'passed', reasonCode: 'NONE' },
  ...['record-one', 'record-two', 'record-three'].map((traceRecordId, index) => ({
    checkId: `check-post-${index}`, traceRecordId, kind: 'ordered_postcondition',
    result: 'passed', reasonCode: 'NONE',
  })),
];
const compiler = { compilerVersion: '1', compilerAttemptId: 'compile-one',
  successfulTraceId: 'trace-one', ...owner,
  startedAt: '2026-09-24T10:00:04.000Z', finishedAt: '2026-09-24T10:00:05.000Z',
  checks, result: { status: 'accepted', resolvedSpecId: 'resolved-agentic' } };
const resolved = { schemaVersion: '6', sourceSchemaVersion: '2',
  resolvedSpecId: 'resolved-agentic', successfulTraceId: 'trace-one',
  compilerAttemptId: 'compile-one', ...owner,
  runtimeVersions: { playwright: '1.63.0', mcp: '0.0.82', runner: '2', compiler: '1' },
  executionSteps: [
    { id: 'x1', traceRecordId: 'record-one', originStepId: 's1', source: 'authored',
      type: 'navigate', url: 'https://example.com/' },
    { id: 'x2', traceRecordId: 'record-two', originStepId: 's2', source: 'authored',
      type: 'click', locatorId: 'loc-save', locator: {
        origin: 'verifiedTraceCompilation', validatedForm: form,
        observed: { role: 'button', accessibleName: 'Save', matchCount: 1, selectedTargetMatches: true },
        quality: { status: 'accepted', identityBasis: 'role-and-accessible-name' },
      } },
    { id: 'x3', traceRecordId: 'record-three', originStepId: 's3', source: 'authored',
      type: 'assert_url', expectedUrl: 'https://example.com/done', match: 'exact' },
  ] };
const copy = <T>(value: T): T => structuredClone(value);

test('current-state binding rejects stale snapshot, session, and profile', () => {
  expect(parseCurrentTargetBinding(binding, active, source).selectedRef).toBe('ref-save');
  for (const mismatch of [
    { snapshotEpoch: 3 }, { snapshotDigest: d('c') }, { sessionId: 'session-other' },
    { pageId: 'page-other' }, { frameId: 'frame-other' }, { profileFingerprint: d('f') },
    { selectedRef: 'ref-other' }, { selectedRefCount: 2 },
    { selectedNode: { role: 'link', accessibleName: 'Save' } }, { visible: false },
  ]) expect(() => parseCurrentTargetBinding(binding, { ...active, ...mismatch }, source)).toThrow();
  expect(() => parseCurrentTargetBinding({ ...binding, operation: 'fill' }, active, source)).toThrow();
});

test('successful trace keeps only an ordered, linked successful path', () => {
  expect(parseSuccessfulExplorationTraceV1(trace, source, attempt).successfulPath).toHaveLength(3);
  const reordered = copy(trace);
  reordered.successfulPath[1]!.sequence = 3;
  expect(() => parseSuccessfulExplorationTraceV1(reordered, source, attempt)).toThrow();
  expect(() => parseSuccessfulExplorationTraceV1({ ...trace, completedOriginStepIds: ['s1', 's3'] }, source, attempt)).toThrow();
  expect(() => parseSuccessfulExplorationTraceV1({ ...trace, bindings: [...trace.bindings,
    { ...binding, bindingId: 'binding-failed' }] }, source, attempt)).toThrow();
  expect(() => parseSuccessfulExplorationTraceV1({ ...trace, successfulPath: [...trace.successfulPath,
    { ...trace.successfulPath[1], recordId: 'failed-branch', sequence: 4 }] }, source, attempt)).toThrow();
});

test('successful-path wait and assertion records retain closed operation semantics', () => {
  const common = { recordId: 'record-wait', sequence: 1, originStepId: 's1', source: 'authored',
    preStateDigest: d('1'), postStateDigest: d('2'), observationDigest: d('3') };
  expect(SuccessfulPathRecordV1Schema.parse({ ...common, type: 'wait_for',
    condition: { type: 'url_exact', url: 'https://example.com/' },
    timeoutPolicyRef: 'default', result: 'satisfied' }).type).toBe('wait_for');
  expect(SuccessfulPathRecordV1Schema.safeParse({ ...common, type: 'click',
    bindingId: 'binding-save', result: 'failed' }).success).toBe(false);
  expect(SuccessfulPathRecordV1Schema.safeParse({ ...common, type: 'assert_url',
    expectedUrl: 'https://example.com/', match: 'exact', result: 'failed' }).success).toBe(true);
});

test('failed and recovery diagnostics remain separate and closed', () => {
  const diagnostic = { diagnosticVersion: '1', diagnosticId: 'diag-one', ...owner,
    sessionId: 'session-one', branchOrdinal: 1, originStepId: 's2', snapshotDigest: d('b'),
    branchKind: 'failed_candidate', decisionCode: 'evaluate', resultCode: 'wrong_target' };
  expect(parseExplorationBranchDiagnosticV1(diagnostic, source, attempt)).toEqual(diagnostic);
  expect(ExplorationBranchDiagnosticV1Schema.safeParse({ ...diagnostic, rawPageText: 'secret' }).success).toBe(false);
  expect(() => parseExplorationBranchDiagnosticV1({ ...diagnostic, profileFingerprint: d('f') }, source, attempt)).toThrow();
  expect(() => parseExplorationBranchDiagnosticV1({ ...diagnostic, originStepId: 's404' }, source, attempt)).toThrow();
});

test('compiler attempts link one trace and exact checks before v6 is accepted', () => {
  expect(parseCompilerAttemptV1(compiler, trace, source, attempt).result.status).toBe('accepted');
  expect(parseResolvedTestSpecV6(resolved, source, attempt, trace, compiler).schemaVersion).toBe('6');
  expect(() => parseCompilerAttemptV1({ ...compiler, successfulTraceId: 'trace-other' }, trace, source, attempt)).toThrow();
  expect(() => parseCompilerAttemptV1({ ...compiler, checks: checks.filter((check) =>
    check.kind !== 'selected_target') }, trace, source, attempt)).toThrow();
  expect(() => parseCompilerAttemptV1({ ...compiler, checks: checks.map((check) =>
    check.kind === 'selected_target' ? { ...check, selectedTargetMatches: false } : check) },
  trace, source, attempt)).toThrow();
  expect(() => parseResolvedTestSpecV6({ ...resolved, successfulTraceId: 'trace-other' }, source, attempt, trace, compiler)).toThrow();
  expect(() => parseResolvedTestSpecV6({ ...resolved, compilerAttemptId: 'compile-other' }, source, attempt, trace, compiler)).toThrow();
  expect(() => parseResolvedTestSpecV6({ ...resolved, profileFingerprint: d('f') }, source, attempt, trace, compiler)).toThrow();
  const changedForm = copy(resolved);
  changedForm.executionSteps[1]!.locator!.validatedForm.name = 'Other';
  expect(() => parseResolvedTestSpecV6(changedForm, source, attempt, trace, compiler)).toThrow();
  const falseBasis = copy(resolved);
  falseBasis.executionSteps[1]!.locator!.quality.identityBasis = 'verified-label';
  expect(() => parseResolvedTestSpecV6(falseBasis, source, attempt, trace, compiler)).toThrow();
});

test('typed outcomes distinguish automation, replay, QA, environment, and cleanup', () => {
  for (const [boundary, status] of [
    ['exploration', 'path_unresolved'], ['compilation', 'durability_failed'],
    ['replay', 'not_reproduced'], ['qa', 'assertion_failed'],
    ['environment', 'policy_denied'], ['cleanup', 'unverified'],
  ]) expect(AgenticOutcomeV1Schema.safeParse({ boundary, status }).success).toBe(true);
  expect(AgenticOutcomeV1Schema.safeParse({ boundary: 'qa', status: 'durability_failed' }).success).toBe(false);
});

test('legacy resolved v2-v5 remain separate from v6 and external result shape stays closed', () => {
  const legacy = makeResolvedSpec();
  expect(parseResolvedTestSpec(legacy, makeTestSpec()).schemaVersion).toBe('2');
  const links = parseTestSpec({ schemaVersion: '3', testSpecId: 'test-links',
    sourceInstruction: 'Confirm two Frank da Cruz links', executionProfileRef: profile,
    startState: { url: 'https://example.com/' }, steps: [{ id: 's1', type: 'assert_link_collection',
      sourceText: 'Confirm two Frank da Cruz links', linkName: 'Frank da Cruz', expectedCount: 2,
      expectedHref: 'https://example.com/destination' }] });
  const v3 = { schemaVersion: '3', resolvedSpecId: 'resolved-links', testSpecId: links.testSpecId,
    explorationAttemptId: 'explore-links', executionProfileRef: profile,
    runtimeVersions: { playwright: '1.63.0', mcp: 'pinned', runner: '1' },
    executionSteps: [{ id: 'x1', originStepId: 's1', source: 'authored',
      derivationEvidenceRef: 'evidence/explore-links/x1.json', type: 'assert_link_collection',
      locatorId: 'loc-links', targetDescription: 'Frank da Cruz', linkName: 'Frank da Cruz',
      expectedCount: 2, expectedHref: 'https://example.com/destination',
      locator: { origin: 'mcp', mcpGeneratedExpression: "getByRole('link', { name: 'Frank da Cruz', exact: true })",
        validatedForm: { type: 'role', role: 'link', name: 'Frank da Cruz', exact: true },
        observed: { role: 'link', accessibleName: 'Frank da Cruz', matchCount: 2 },
        quality: { status: 'accepted', identityBasis: 'role-and-accessible-name', kind: 'collection',
          projection: 'exact-role-name-collection' } } }] };
  expect(parseResolvedTestSpec(v3, links).schemaVersion).toBe('3');
  expect(() => parseResolvedTestSpec(resolved, source)).toThrow();
  expect(ResolvedTestSpecSchema.safeParse(resolved).success).toBe(false);
  expect(SUBPROCESS_PROTOCOL_VERSION).toBe('1');
  expect(REPORT_PROJECTION_VERSION).toBe('1');
  expect(SubprocessResponseSchema.safeParse({ protocolVersion: '1', kind: 'bridge_error',
    code: 'CANCELLED', cleanup: 'unverified', successfulTraceId: 'trace-one' }).success).toBe(false);
  expect(ReportProjectionResponseSchema.safeParse({ reportProjectionVersion: '1', kind: 'unavailable',
    reason: 'REPORT_UNAVAILABLE', successfulTraceId: 'trace-one' }).success).toBe(false);
});
