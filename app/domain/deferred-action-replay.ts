import { z } from 'zod';
import { candidateGroundingDigest as hash } from './action-candidate-grounding.js';
import { DeferredRunnerRecordV9Schema, parseDeferredRunnerRecordV9, type DeferredRunnerRecordV9 } from './deferred-action-runner.js';
import { parseResultRecordV2, type ResultRecordV2 } from './agentic-result-v2.js';
import type { ResolvedTestSpecV9, CompilerAttemptV4 } from './deferred-action-compiler.js';
import type { SuccessfulExplorationTraceV5 } from './agentic-trace-v5.js';

const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DeferredReplayRecordV1Schema = z.strictObject({ orchestrationVersion: z.literal('1'),
  orchestrationId: id, presentationMode: z.enum(['headless', 'headed']), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  runs: z.array(DeferredRunnerRecordV9Schema).max(2),
  hostStop: z.literal('RUNNER_ENVIRONMENT_FAILURE').optional(),
  agreement: z.enum(['agreed', 'disagreed', 'not_established']),
  recordDigest: digest,
});
export type DeferredReplayRecordV1 = z.infer<typeof DeferredReplayRecordV1Schema>;
export type DeferredReplayArtifactV1 = { resolved: ResolvedTestSpecV9; compiler: CompilerAttemptV4; trace: SuccessfulExplorationTraceV5 };
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
export function deferredObservationSignatureV1(run: DeferredRunnerRecordV9): string {
  return hash(run.steps.filter(s => s.type === 'verification_goal').map(s => ({
    stepId: s.stepId, traceRecordId: s.traceRecordId, originStepId: s.originStepId, verification: s.verification,
  })));
}
/** Mechanical accounting only. This function does not issue runtime or stored origin. */
export function validateDeferredReplayRunsV1(runs: readonly DeferredRunnerRecordV9[], { resolved: r, compiler, trace }: DeferredReplayArtifactV1): void {
  if (runs.length > 2 || new Set(runs.map(run => run.executionRunId)).size !== runs.length) throw new Error('DEFERRED_RUN_PROVENANCE');
  const sessions: string[] = [], pages: string[] = [];
  for (const input of runs) {
    const run = parseDeferredRunnerRecordV9(input), p = run.provenance;
    if (!p || p.testSpecId !== r.testSpecId || p.resolvedSpecId !== r.resolvedSpecId || p.resolvedDigest !== r.resolvedDigest ||
      p.compilerAttemptId !== r.compilerAttemptId || p.traceDigest !== r.traceDigest || p.admissionDigest !== r.admissionDigest ||
      p.profileFingerprint !== r.profileFingerprint || !same(p.executionProfileRef, r.executionProfileRef) ||
      Date.parse(run.startedAt) < Date.parse(compiler.finishedAt)) throw new Error('DEFERRED_RUN_PROVENANCE');
    if (p.sessionId) {
      if (p.sessionId === compiler.freshSessionId || p.sessionId === trace.sessionId) throw new Error('DEFERRED_SESSION_REUSE');
      sessions.push(p.sessionId);
    }
    if (run.startState) pages.push(run.startState.pageId);
    if (run.result.kind === 'completed' && (!p.sessionId || run.steps.length !== r.executionSteps.length)) throw new Error('DEFERRED_INCOMPLETE_RUN');
    for (const [index, s] of run.steps.entries()) {
      const e = r.executionSteps[index];
      if (!e || s.stepId !== e.id || s.traceRecordId !== e.traceRecordId || s.originStepId !== e.originStepId || s.type !== e.type)
        throw new Error('DEFERRED_ORDER_MISMATCH');
      if (e.type === 'verification_goal' && s.status !== 'stopped' && !same(s.verification?.assertion, e.assertion)) throw new Error('DEFERRED_ASSERTION_MISMATCH');
      if (e.type === 'action_goal' && (s.operation !== e.operation || s.argument !== e.executableArgument)) throw new Error('DEFERRED_ARGUMENT_MISMATCH');
      if (s.status === 'stopped' && index !== run.steps.length - 1) throw new Error('DEFERRED_STOP_CONTINUATION');
    }
  }
  if (new Set(sessions).size !== sessions.length || new Set(pages).size !== pages.length) throw new Error('DEFERRED_SESSION_REUSE');
  if (runs.length === 2 && Date.parse(runs[1]!.startedAt) < Date.parse(runs[0]!.finishedAt)) throw new Error('DEFERRED_RUN_OVERLAP');
  if (runs.length === 2 && (runs[0]!.cleanup !== 'verified' || runs[0]!.result.kind !== 'completed')) throw new Error('DEFERRED_STOP_CONTINUATION');
}
export function deriveDeferredAgreementV1(runs: readonly DeferredRunnerRecordV9[], hostStop?: DeferredReplayRecordV1['hostStop']): DeferredReplayRecordV1['agreement'] {
  if (hostStop || runs.length !== 2 || runs.some(r => r.cleanup !== 'verified' || r.result.kind !== 'completed')) return 'not_established';
  return deferredObservationSignatureV1(runs[0]!) === deferredObservationSignatureV1(runs[1]!) ? 'agreed' : 'disagreed';
}
export function parseDeferredReplayRecordV1(input: unknown, artifact: DeferredReplayArtifactV1): DeferredReplayRecordV1 {
  const record = DeferredReplayRecordV1Schema.parse(input), { recordDigest, ...body } = record;
  validateDeferredReplayRunsV1(record.runs, artifact);
  if (record.hostStop && record.runs.length === 2 || !record.hostStop && (record.runs.length === 0 ||
    record.runs.length === 1 && record.runs[0]!.result.kind === 'completed' && record.runs[0]!.cleanup === 'verified'))
    throw new Error('DEFERRED_INCOMPLETE_PAIR');
  if (hash(body) !== recordDigest || record.agreement !== deriveDeferredAgreementV1(record.runs, record.hostStop) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt) || record.runs.some(r => Date.parse(r.startedAt) < Date.parse(record.startedAt) || Date.parse(r.finishedAt) > Date.parse(record.finishedAt)))
    throw new Error('DEFERRED_PAIR_INTEGRITY');
  return record;
}
export function deferredResultRecordV2(record: DeferredReplayRecordV1, artifact: DeferredReplayArtifactV1): ResultRecordV2 {
  parseDeferredReplayRecordV1(record, artifact);
  const { resolved: r, compiler, trace } = artifact, unverified = record.hostStop === 'RUNNER_ENVIRONMENT_FAILURE' || record.runs.some(run => run.cleanup !== 'verified');
  let terminal: ResultRecordV2['terminal'];
  if (unverified) terminal = { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED' };
  else if (record.agreement === 'disagreed') terminal = { stage: 'reproducibility', status: 'REPRODUCIBILITY_FAILED', reason: 'REPLAY_OUTCOMES_DISAGREE' };
  else if (record.agreement === 'agreed') {
    const result = record.runs[0]!.result;
    if (result.kind !== 'completed') throw new Error('DEFERRED_COMPLETION');
    terminal = !result.assertions ? { stage: 'execution', status: 'EXECUTION_REPRODUCED', reason: 'NO_ASSERTIONS' } :
      result.passed ? { stage: 'qa', status: 'QA_ASSERTION_PASSED' } : { stage: 'qa', status: 'QA_ASSERTION_FAILED', reason: 'REDACTED_REASON' };
  } else {
    const reason = record.runs.find(run => run.result.kind === 'non_qa_stop')?.result;
    terminal = reason?.kind === 'non_qa_stop' && reason.reasonCode === 'ENVIRONMENT_FAILURE' ?
      { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'REPLAY_ENVIRONMENT_UNAVAILABLE' } :
      { stage: 'replay', status: 'REPLAY_EXECUTION_FAILED', reason: 'REDACTED_REASON' };
  }
  return parseResultRecordV2({ resultVersion: '2', workflowVersion: 'deferred-action-v1', testSpecId: r.testSpecId,
    executionProfileRef: r.executionProfileRef, profileFingerprint: r.profileFingerprint,
    presentationMode: record.presentationMode, observation: record.presentationMode === 'headed' ? 'observational' : 'unobserved', explorationAttemptId: r.explorationAttemptId,
    successfulTraceId: r.successfulTraceId, compilerAttemptId: r.compilerAttemptId, resolvedSpecId: r.resolvedSpecId,
    executionRunIds: record.runs.map(run => run.executionRunId), terminal, cleanup: unverified ? 'unverified' : 'verified',
    deferredReplay: { orchestrationVersion: '1', orchestrationId: record.orchestrationId, sourceSchemaVersion: '6', sourceContractVersion: '2', traceVersion: '5',
      compilerVersion: '4', resolvedSchemaVersion: '9', runnerVersion: '9', sourceDigest: trace.semanticAdmission.sourceDigest, admissionDigest: r.admissionDigest,
      traceDigest: r.traceDigest, compilerDigest: compiler.attemptDigest, resolvedDigest: r.resolvedDigest, orchestrationDigest: record.recordDigest,
      executionSessionIds: record.runs.flatMap(run => run.provenance?.sessionId ? [run.provenance.sessionId] : []), runDigests: record.runs.map(run => run.recordDigest) },
  });
}

