import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  FrameOwnershipV2Schema, SuccessfulExplorationTraceV2Schema,
  parseSuccessfulExplorationTraceV1, parseSuccessfulExplorationTraceV2, parseTestSpec,
} from '../app/domain/index.js';

const d = (value: string) => value.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = '2026-09-24T10:00:00.000Z';
const done = '2026-09-24T10:00:10.000Z';
const profile = { id: 'public-headless', version: '1' };
const source = parseTestSpec({ schemaVersion: '2', testSpecId: 'test-trace-v2',
  sourceInstruction: 'Navigate, click the link, confirm the URL', executionProfileRef: profile,
  startState: { url: 'about:blank' }, steps: [
    { id: 's1', type: 'navigate', sourceText: 'Navigate', url: 'https://example.com/' },
    { id: 's2', type: 'click', sourceText: 'Click the link', target: { description: 'Next link' } },
    { id: 's3', type: 'assert_url', sourceText: 'Confirm URL',
      expectedUrl: 'https://example.com/next', match: 'exact' },
  ] });
const owner = { testSpecId: source.testSpecId, explorationAttemptId: 'explore-v2',
  executionProfileRef: profile, profileFingerprint: d('a') };
const attempt = { attemptVersion: '3', ...owner, status: 'path_established',
  successfulTraceId: 'trace-v2', startedAt: at, finishedAt: done };
const actionBinding = { bindingVersion: '1', bindingId: 'binding-next', ...owner,
  sessionId: 'session-one', pageId: 'page-one', frameId: 'opaque-original-frame',
  snapshotEpoch: 2, snapshotDigest: d('b'), selectedRef: 'ref-next', originStepId: 's2',
  issuedAt: '2026-09-24T10:00:03.000Z', operation: 'click',
  selectedNode: { role: 'link', accessibleName: 'Next' }, justificationCode: 'authored_target',
  frameOwnership: { kind: 'main', observationDigest: d('b') } };
const base = { traceVersion: '2', successfulTraceId: 'trace-v2', ...owner,
  sessionId: 'session-one', startStateDigest: d('1'), finalStateDigest: d('4'),
  startedAt: at, finishedAt: done, bindings: [actionBinding],
  completedOriginStepIds: ['s1', 's2', 's3'], successfulPath: [
    { recordId: 'nav', sequence: 1, originStepId: 's1', source: 'authored',
      preStateDigest: d('1'), postStateDigest: d('2'), observationDigest: d('5'),
      type: 'navigate', url: 'https://example.com/', result: 'completed' },
    { recordId: 'click', sequence: 2, originStepId: 's2', source: 'authored',
      preStateDigest: d('2'), postStateDigest: d('3'), observationDigest: d('6'),
      type: 'click', bindingId: 'binding-next', result: 'completed' },
    { recordId: 'assert', sequence: 3, originStepId: 's3', source: 'authored',
      preStateDigest: d('3'), postStateDigest: d('4'), observationDigest: d('7'),
      type: 'assert_url', expectedUrl: 'https://example.com/next', match: 'exact', result: 'passed' },
  ] };
const clone = <T>(value: T): T => structuredClone(value);

function withTransition(condition: object, binding?: object) {
  const trace: any = clone(base);
  const witness = { kind: 'protected_condition_check', traceRecordId: 'passive',
    timeoutPolicyRef: 'default', conditionDigest: hash(condition),
    observationDigest: d('8'), observedStateDigest: d('9'),
    observedAt: '2026-09-24T10:00:02.000Z', satisfied: true };
  trace.successfulPath.splice(1, 0, { recordId: 'passive', sequence: 2, originStepId: 's2',
    source: 'discoveredPrerequisite', prerequisiteReasonCode: 'reach_state',
    preStateDigest: d('2'), postStateDigest: d('9'), observationDigest: d('8'),
    type: 'state_observed', result: 'observed', condition, timeoutPolicyRef: 'default',
    ...(binding ? { bindingId: 'binding-passive' } : {}), witness });
  trace.successfulPath[2].sequence = 3;
  trace.successfulPath[2].preStateDigest = d('9');
  trace.successfulPath[3].sequence = 4;
  if (binding) trace.bindings.push(binding);
  return trace;
}

test('v2 main-frame attestation is tied to the selected snapshot; v1 remains readable', () => {
  expect(parseSuccessfulExplorationTraceV2(base, source, attempt).bindings[0]?.frameOwnership.kind).toBe('main');
  const historical: any = clone(base);
  historical.traceVersion = '1';
  historical.bindings = historical.bindings.map(({ frameOwnership: _owner, ...binding }: any) => binding);
  expect(parseSuccessfulExplorationTraceV1(historical, source, attempt).traceVersion).toBe('1');
  expect(() => parseSuccessfulExplorationTraceV2(historical, source, attempt)).toThrow();
  const mismatch: any = clone(base);
  mismatch.bindings[0].frameOwnership.observationDigest = d('c');
  expect(() => parseSuccessfulExplorationTraceV2(mismatch, source, attempt)).toThrow();
  delete mismatch.bindings[0].frameOwnership;
  expect(() => parseSuccessfulExplorationTraceV2(mismatch, source, attempt)).toThrow();
});

test('v2 nested frame ownership requires an ordered chain of unique exact anchors', () => {
  const nested: any = clone(base);
  nested.bindings[0].frameOwnership = { kind: 'nested', anchors: [
    { identity: { kind: 'title', value: 'Account frame', exact: true },
      ownerSnapshotDigest: d('c'), observedMatchCount: 1 },
    { identity: { kind: 'testId', value: 'editor-frame', exact: true },
      ownerSnapshotDigest: d('d'), observedMatchCount: 1 },
  ] };
  expect(parseSuccessfulExplorationTraceV2(nested, source, attempt).bindings[0]?.frameOwnership.kind)
    .toBe('nested');
  for (const malformed of [
    { kind: 'nested', anchors: [] },
    { kind: 'nested', anchors: [{ identity: { kind: 'title', value: 'Account frame', exact: true },
      ownerSnapshotDigest: d('c'), observedMatchCount: 2 }] },
    { kind: 'nested', anchors: [{ identity: { kind: 'css', value: '#frame', exact: true },
      ownerSnapshotDigest: d('c'), observedMatchCount: 1 }] },
    { kind: 'nested', anchors: [{ identity: { kind: 'title', value: 'Account frame', exact: true,
      frameId: 'opaque-original-frame' }, ownerSnapshotDigest: d('c'), observedMatchCount: 1 }] },
  ]) expect(FrameOwnershipV2Schema.safeParse(malformed).success).toBe(false);
  expect(FrameOwnershipV2Schema.safeParse({ kind: 'unproven',
    reasonCode: 'ambiguous_anchor' }).success).toBe(true);
  nested.bindings[0].frameOwnership = { kind: 'unproven', reasonCode: 'ambiguous_anchor' };
  expect(parseSuccessfulExplorationTraceV2(nested, source, attempt).bindings[0]?.frameOwnership.kind)
    .toBe('unproven');
  expect(FrameOwnershipV2Schema.safeParse({ kind: 'main',
    frameId: 'opaque-original-frame', observationDigest: d('b') }).success).toBe(false);
});

test('v2 passive exact and pattern URL transitions require a matched protected witness', () => {
  for (const condition of [
    { type: 'url_exact', url: 'https://example.com/ready' },
    { type: 'url_pattern', pattern: 'https://example.com/*' },
  ]) expect(parseSuccessfulExplorationTraceV2(withTransition(condition), source, attempt)
    .successfulPath[1]?.type).toBe('state_observed');
  const trace = withTransition({ type: 'url_exact', url: 'https://example.com/ready' });
  delete trace.successfulPath[1].condition;
  expect(() => parseSuccessfulExplorationTraceV2(trace, source, attempt)).toThrow();
});

test('v2 targeted visible/value transitions require a current wait binding', () => {
  const waitBinding = { ...clone(actionBinding), bindingId: 'binding-passive',
    operation: 'wait_for', justificationCode: 'discovered_prerequisite',
    issuedAt: '2026-09-24T10:00:01.000Z' };
  for (const condition of [
    { type: 'target_visible', target: { description: 'Ready indicator' } },
    { type: 'target_value', target: { description: 'Ready field' }, expectedValue: 'ready' },
  ]) {
    const trace = withTransition(condition, waitBinding);
    expect(parseSuccessfulExplorationTraceV2(trace, source, attempt).bindings).toHaveLength(2);
    const absent: any = clone(trace);
    delete absent.successfulPath[1].bindingId;
    expect(() => parseSuccessfulExplorationTraceV2(absent, source, attempt)).toThrow();
  }
});

test('v2 denies unsatisfied, stale, or contradictory passive witnesses and owner drift', () => {
  const condition = { type: 'url_exact', url: 'https://example.com/ready' };
  const valid = withTransition(condition);
  expect(SuccessfulExplorationTraceV2Schema.safeParse(valid).success).toBe(true);
  for (const change of [
    { satisfied: false }, { conditionDigest: d('f') }, { observationDigest: d('f') },
    { observedStateDigest: d('f') }, { observedAt: '2026-09-24T10:01:00.000Z' },
    { traceRecordId: 'other' }, { timeoutPolicyRef: 'other' },
  ]) {
    const candidate = clone(valid);
    Object.assign(candidate.successfulPath[1].witness, change);
    expect(() => parseSuccessfulExplorationTraceV2(candidate, source, attempt)).toThrow();
  }
  expect(() => parseSuccessfulExplorationTraceV2({ ...valid, profileFingerprint: d('f') },
    source, attempt)).toThrow();
  expect(() => parseSuccessfulExplorationTraceV2({ ...valid, sessionId: 'session-other' },
    source, attempt)).toThrow();
  expect(() => parseSuccessfulExplorationTraceV2({ ...valid, completedOriginStepIds: ['s1', 's3'] },
    source, attempt)).toThrow();
});
