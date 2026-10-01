import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_HOST_DEADLINE_MS, HostProcessFailureSchema, MAX_HOST_DEADLINE_MS,
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_STDERR_BYTES,
  SubprocessProtocolError, SubprocessRequestSchema, SubprocessResponseSchema,
  expectedSubprocessExit, hasExpectedSubprocessExit, parseSubprocessRequest,
  parseSubprocessResponse, responseMatchesRequest, safeTerminalReason,
} from '../app/subprocess/index.js';

const request = {
  protocolVersion: '1',
  request: {
    taskText: 'Select Save.', targetUrl: 'http://127.0.0.1:4173/',
    executionProfileRef: { id: 'desktop', version: '2' },
  },
};
const context = {
  testSpecId: 'local-1', executionProfileRef: { id: 'desktop', version: '2' },
  profileFingerprint: 'a'.repeat(64), presentationMode: 'headless',
  observation: { state: 'no_intervention', autonomousEligible: true, eventIds: [] },
  progress: { stage: 'replayed', explorationAttemptId: 'attempt-1',
    resolvedSpecId: 'resolved-1', executionRunIds: ['run-1', 'run-2'] },
  report: { kind: 'available', testSpecId: 'local-1' },
};
const success = {
  protocolVersion: '1', kind: 'success', context,
  terminal: { phase: 'execution', status: 'QA_ASSERTION_PASSED' },
};

test('P2-3A accepts one bounded task document and rejects authority fields before engine work', () => {
  expect(parseSubprocessRequest(`${JSON.stringify(request)}\n`)).toEqual(request);
  expect(parseSubprocessRequest(Buffer.from(JSON.stringify(request)))).toEqual(request);
  expect(SubprocessRequestSchema.safeParse({ ...request, provider: 'fake' }).success).toBe(false);
  expect(SubprocessRequestSchema.safeParse({ ...request, request: {
    ...request.request, apiKey: 'private', networkPolicy: {}, browser: 'headed', artifactRoot: 'x',
  } }).success).toBe(false);
  expect(() => parseSubprocessRequest(JSON.stringify({ ...request, protocolVersion: '2' })))
    .toThrowError(new SubprocessProtocolError('PROTOCOL_UNSUPPORTED_VERSION'));
  expect(() => parseSubprocessRequest(JSON.stringify(request) + JSON.stringify(request)))
    .toThrowError(new SubprocessProtocolError('PROTOCOL_INVALID'));
  expect(() => parseSubprocessRequest('x'.repeat(MAX_REQUEST_BYTES + 1)))
    .toThrowError(new SubprocessProtocolError('REQUEST_TOO_LARGE'));
  expect(() => parseSubprocessRequest(new Uint8Array([0xff])))
    .toThrowError(new SubprocessProtocolError('PROTOCOL_INVALID'));
  expect(DEFAULT_HOST_DEADLINE_MS).toBeLessThanOrEqual(MAX_HOST_DEADLINE_MS);
  expect(MAX_STDERR_BYTES).toBeLessThan(MAX_RESPONSE_BYTES);
});

test('P2-3A accepts safe success, QA failure, and exploration stop with exact exit semantics', () => {
  const accepted = parseSubprocessResponse(JSON.stringify(success));
  expect(expectedSubprocessExit(accepted)).toBe(0);
  expect(hasExpectedSubprocessExit(accepted, 0)).toBe(true);
  expect(hasExpectedSubprocessExit(accepted, 1)).toBe(false);
  expect(responseMatchesRequest(parseSubprocessRequest(JSON.stringify(request)), accepted)).toBe(true);
  expect(responseMatchesRequest(parseSubprocessRequest(JSON.stringify({ ...request,
    request: { ...request.request, executionProfileRef: { id: 'other', version: '2' } },
  })), accepted)).toBe(false);
  const qa = parseSubprocessResponse(JSON.stringify({
    ...success, kind: 'typed_stop', stopKind: 'qa_failure',
    terminal: { phase: 'execution', status: 'QA_ASSERTION_FAILED', reason: 'NO_MATCH' },
  }));
  expect(expectedSubprocessExit(qa)).toBe(1);
  const resolution = parseSubprocessResponse(JSON.stringify({
    ...success, kind: 'typed_stop', stopKind: 'automation_stop',
    context: { ...context, observation: { state: 'unobserved', autonomousEligible: false, eventIds: [] },
      progress: { stage: 'exploration', explorationAttemptId: 'attempt-1' } },
    terminal: { phase: 'locator', status: 'LOCATOR_QUALITY_FAILED', reason: 'WEAK_IDENTITY' },
  }));
  expect(expectedSubprocessExit(resolution)).toBe(2);
  expect(SubprocessResponseSchema.safeParse({ ...success, kind: 'typed_stop',
    stopKind: 'automation_stop', terminal: {
      phase: 'execution', status: 'QA_ASSERTION_FAILED', reason: 'NO_MATCH',
    } }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success, kind: 'typed_stop',
    stopKind: 'qa_failure', context: { ...context, progress: { stage: 'not_started' } },
    terminal: { phase: 'execution', status: 'QA_ASSERTION_FAILED' },
  }).success).toBe(false);
});

test('P2-3A rejects invalid ID links, repeated runs, unsafe reason/body, and false provenance', () => {
  expect(SubprocessResponseSchema.safeParse({ ...success, context: {
    ...context, report: { kind: 'available', testSpecId: 'other' },
  } }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success, context: {
    ...context, progress: { ...context.progress, executionRunIds: ['run-1', 'run-1'] },
  } }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success,
    terminal: { ...success.terminal, reason: 'private page text' },
  }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success,
    terminal: { ...success.terminal, reason: 'PRIVATE_TOKEN' },
  }).success).toBe(false);
  expect(safeTerminalReason('PRIVATE_TOKEN')).toBe('REDACTED_REASON');
  expect(safeTerminalReason('WEAK_IDENTITY')).toBe('WEAK_IDENTITY');
  expect(safeTerminalReason(undefined)).toBeUndefined();
  expect(SubprocessResponseSchema.safeParse({ ...success, evidence: ['private screenshot'] }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success, context: {
    ...context, presentationMode: 'headed',
  } }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ ...success, kind: 'typed_stop',
    stopKind: 'automation_stop', context: { ...context,
      progress: { stage: 'exploration', explorationAttemptId: 'attempt-1' },
      report: { kind: 'unavailable' },
    }, terminal: { phase: 'exploration', status: 'TARGET_RESOLUTION_FAILED' },
  }).success).toBe(false);
  const observational = { ...success, context: { ...context, presentationMode: 'headed',
    observation: { state: 'observational', inputProvenance: 'unverified',
      autonomousEligible: false, eventIds: [] } } };
  expect(SubprocessResponseSchema.safeParse(observational).success).toBe(true);
  expect(SubprocessResponseSchema.safeParse({ ...observational, context: {
    ...observational.context, observation: { ...observational.context.observation,
      autonomousEligible: true },
  } }).success).toBe(false);
  expect(() => parseSubprocessResponse('x'.repeat(MAX_RESPONSE_BYTES + 1)))
    .toThrowError(new SubprocessProtocolError('RESPONSE_TOO_LARGE'));
});

test('P2-3A keeps bridge and host process failures distinct from typed Node stops', () => {
  const denied = parseSubprocessResponse(JSON.stringify({
    protocolVersion: '1', kind: 'bridge_error', code: 'DESTINATION_DENIED',
    cleanup: 'not_started',
  }));
  expect(expectedSubprocessExit(denied)).toBe(64);
  expect(expectedSubprocessExit(parseSubprocessResponse(JSON.stringify({
    protocolVersion: '1', kind: 'bridge_error', code: 'CANCELLED', cleanup: 'verified',
  })))).toBe(130);
  expect(HostProcessFailureSchema.safeParse({ kind: 'process_failure',
    code: 'DEADLINE_EXCEEDED', cleanup: 'unverified', forcedTermination: true }).success).toBe(true);
  expect(HostProcessFailureSchema.safeParse({ kind: 'process_failure',
    code: 'DEADLINE_EXCEEDED', cleanup: 'verified', forcedTermination: true }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ kind: 'process_failure',
    code: 'LAUNCH_FAILED', cleanup: 'not_started', forcedTermination: false }).success).toBe(false);
  expect(SubprocessResponseSchema.safeParse({ protocolVersion: '1', kind: 'bridge_error',
    code: 'DESTINATION_DENIED', cleanup: 'not_started', apiKey: 'private' }).success).toBe(false);
});

test('P2-3A published JSON examples validate against their wire or host contract', async () => {
  const document = await readFile(path.join(process.cwd(), 'docs/p2-3-subprocess-protocol.md'), 'utf8');
  const examples = [...document.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
  expect(examples.length).toBeGreaterThanOrEqual(5);
  for (const example of examples) {
    const value = JSON.parse(example[1]!) as Record<string, unknown>;
    if (value.kind === 'process_failure') {
      expect(HostProcessFailureSchema.safeParse(value).success).toBe(true);
    } else if ('request' in value) {
      expect(SubprocessRequestSchema.safeParse(value).success).toBe(true);
    } else {
      expect(SubprocessResponseSchema.safeParse(value).success).toBe(true);
    }
  }
});
