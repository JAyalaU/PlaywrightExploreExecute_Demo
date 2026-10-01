import { parseResultRecordV2, type ResultRecordV2,
  type TestSpec } from '../domain/index.js';
import { LocalArtifactStore } from '../evidence/index.js';
import { profilePresentationMode } from '../profile/index.js';
import type { AgenticProductionOutcome } from './agentic-production.js';
import type { GoalDirectedProductionOutcome } from './agentic-goal-production.js';
import type { StructuredActionProductionOutcome } from './structured-action-production.js';

type Terminal = ResultRecordV2['terminal'];
const known = (reason: string | undefined, approved: readonly string[]): string =>
  reason && approved.includes(reason) ? reason : 'REDACTED_REASON';

/** Classify only trusted stage/result facts. Private exceptions and provider text never cross this boundary. */
export function mapAgenticTerminalV2(outcome: AgenticProductionOutcome | GoalDirectedProductionOutcome |
  StructuredActionProductionOutcome): Terminal {
  if (outcome.kind === 'executed') {
    const failed = outcome.replay[0].outcomes.find((record) => record.status === 'QA_ASSERTION_FAILED');
    return outcome.qa === 'QA_ASSERTION_PASSED' ? { stage: 'qa', status: 'QA_ASSERTION_PASSED' } :
      { stage: 'qa', status: 'QA_ASSERTION_FAILED', reason: known(failed?.reason,
        ['NO_MATCH', 'NOT_VISIBLE', 'TEXT_MISMATCH', 'VALUE_MISMATCH', 'URL_MISMATCH',
          'LINK_COUNT_MISMATCH', 'LINK_DESTINATION_MISMATCH', 'REDACTED_REASON']) as
        Extract<Terminal, { status: 'QA_ASSERTION_FAILED' }>['reason'] };
  }
  if (outcome.cleanup === 'unverified') return {
    stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED',
  };
  const { boundary, status } = outcome.outcome;
  if (boundary === 'environment') {
    if (status === 'cancelled') return { stage: 'cancellation', status: 'CANCELLED', reason: 'CANCELLED' };
    return { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: known(outcome.reasonCode,
      ['MODEL_ERROR', 'MODEL_TIMEOUT', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'BROWSER_UNAVAILABLE',
        'NETWORK_POLICY_DENIED', 'COMPILER_ENVIRONMENT_UNAVAILABLE', 'REPLAY_ENVIRONMENT_UNAVAILABLE',
        'SESSION_CLEANUP_FAILED', 'REDACTED_REASON']) as
      Extract<Terminal, { status: 'ENVIRONMENT_FAILED' }>['reason'] };
  }
  if (boundary === 'exploration') {
    return status === 'unsupported' ? {
      stage: 'exploration', status: 'EXPLORATION_UNSUPPORTED', reason: known(outcome.reasonCode,
        ['UNSUPPORTED_OPERATION', 'UNSUPPORTED_CAPABILITY', 'REDACTED_REASON']) as
        Extract<Terminal, { status: 'EXPLORATION_UNSUPPORTED' }>['reason'],
    } : { stage: 'exploration', status: 'EXPLORATION_UNRESOLVED', reason: known(outcome.reasonCode,
      ['TARGET_NOT_FOUND', 'BUDGET_EXHAUSTED', 'UNSAFE_RECOVERY', 'REDACTED_REASON']) as
      Extract<Terminal, { status: 'EXPLORATION_UNRESOLVED' }>['reason'] };
  }
  if (boundary === 'compilation') {
    return status === 'unsupported' ? { stage: 'compilation', status: 'COMPILATION_UNSUPPORTED',
      reason: 'UNSUPPORTED_CAPABILITY' } : { stage: 'compilation', status: 'COMPILATION_FAILED',
      reason: known(outcome.reasonCode, ['UNSUPPORTED_GRAMMAR', 'WEAK_IDENTITY', 'NON_UNIQUE_MATCH',
        'TARGET_MISMATCH', 'PROFILE_MISMATCH', 'POSTCONDITION_MISMATCH', 'REDACTED_REASON']) as
        Extract<Terminal, { status: 'COMPILATION_FAILED' }>['reason'] };
  }
  if (boundary === 'replay') {
    if (status === 'not_reproduced') return { stage: 'reproducibility', status: 'REPRODUCIBILITY_FAILED',
      reason: 'REPLAY_OUTCOMES_DISAGREE' };
    const failed = outcome.replay?.[0]?.outcomes.find((record) =>
      record.status === 'LOCATOR_BINDING_FAILED' || record.status === 'BROWSER_EXECUTION_FAILED');
    if (failed?.status === 'LOCATOR_BINDING_FAILED') return { stage: 'replay', status: 'REPLAY_BINDING_FAILED',
      reason: known(failed.reason, ['NO_MATCH', 'AMBIGUOUS_MATCH', 'FRAME_RESOLUTION_FAILED',
        'TARGET_MISMATCH', 'REDACTED_REASON']) as Extract<Terminal, { status: 'REPLAY_BINDING_FAILED' }>['reason'] };
    if (failed?.reason === 'WAIT_CONDITION_TIMEOUT' || failed?.reason === 'UNKNOWN_TIMEOUT_POLICY')
      return { stage: 'replay', status: 'REPLAY_WAIT_FAILED', reason: failed.reason };
    return { stage: 'replay', status: 'REPLAY_EXECUTION_FAILED', reason: known(failed?.reason,
      ['REPLAY_EXECUTION_FAILED', 'EVALUATION_FAILED', 'REDACTED_REASON']) as
      Extract<Terminal, { status: 'REPLAY_EXECUTION_FAILED' }>['reason'] };
  }
  throw new Error('Nonterminal agentic outcome cannot become a public terminal');
}

/** Explicit Node-only normalization. Caller chooses v2 before the job; no v1 fallback exists. */
export async function finalizeAgenticOutcomeV2(store: LocalArtifactStore, source: TestSpec,
  outcome: AgenticProductionOutcome | GoalDirectedProductionOutcome | StructuredActionProductionOutcome,
  workflowVersion: 'agentic-exploration-v1' | 'goal-directed-v1' | 'structured-action-v1' = 'agentic-exploration-v1'): Promise<ResultRecordV2> {
  const { source: stored, profile } = await store.readJob(source.testSpecId);
  if (JSON.stringify(stored) !== JSON.stringify(source)) throw new Error('Agentic source changed');
  if (workflowVersion === 'goal-directed-v1' && source.schemaVersion !== '4')
    throw new Error('Goal-directed terminal requires TestSpec v4');
  if (workflowVersion === 'structured-action-v1' && source.schemaVersion !== '5')
    throw new Error('Structured terminal requires TestSpec v5');
  const attemptId = outcome.attemptId;
  const later = outcome.kind === 'executed' || outcome.stage !== 'exploration';
  const trace = later ? workflowVersion === 'structured-action-v1' ?
    (await store.readSuccessfulExplorationV4(source.testSpecId, attemptId)).trace :
    workflowVersion === 'goal-directed-v1' ?
    (await store.readSuccessfulExplorationV3(source.testSpecId, attemptId)).trace :
    (await store.readSuccessfulExploration(source.testSpecId, attemptId)).trace : undefined;
  const compilerId = outcome.kind === 'executed' ? outcome.compilerAttemptId : outcome.compilerAttemptId;
  const resolvedId = outcome.kind === 'executed' ? outcome.resolved.resolvedSpecId : outcome.resolvedSpecId;
  if (compilerId) {
    const compiler = workflowVersion === 'structured-action-v1' ?
      await store.readCompilerAttemptV3(source.testSpecId, attemptId, compilerId) :
      workflowVersion === 'goal-directed-v1' ?
      await store.readCompilerAttemptV2(source.testSpecId, attemptId, compilerId) :
      await store.readCompilerAttemptV1(source.testSpecId, attemptId, compilerId);
    if (!trace || compiler.successfulTraceId !== trace.successfulTraceId ||
        compiler.profileFingerprint !== profile.fingerprint)
      throw new Error('Agentic compiler/trace mismatch');
    if (resolvedId && (compiler.result.status !== 'accepted' || compiler.result.resolvedSpecId !== resolvedId))
      throw new Error('Agentic compiler/result mismatch');
    if (!resolvedId && compiler.result.status !== 'rejected') throw new Error('Compiler stop lacks a rejected attempt');
  }
  if (resolvedId && compilerId) {
    const saved = workflowVersion === 'structured-action-v1' ?
      await store.readCompiledExplorationV8(source.testSpecId, attemptId, compilerId) :
      workflowVersion === 'goal-directed-v1' ?
      await store.readCompiledExplorationV7(source.testSpecId, attemptId, compilerId) :
      await store.readCompiledExplorationV6(source.testSpecId, attemptId, compilerId);
    if (saved.resolved.resolvedSpecId !== resolvedId ||
        saved.resolved.successfulTraceId !== trace?.successfulTraceId ||
        saved.resolved.profileFingerprint !== profile.fingerprint ||
        outcome.kind === 'executed' && JSON.stringify(saved.resolved) !== JSON.stringify(outcome.resolved))
      throw new Error('Agentic resolved/result mismatch');
  }
  const runs = outcome.replay?.map((run) => run.executionRunId) ?? [];
  if (new Set(runs).size !== runs.length) throw new Error('Reused replay run ID');
  for (const runId of runs) {
    const storedRun = await store.readRun(source.testSpecId, runId);
    if (storedRun.resolvedSpecId !== resolvedId || storedRun.explorationAttemptId !== attemptId ||
      storedRun.profileFingerprint !== profile.fingerprint)
      throw new Error('Agentic replay/result mismatch');
    const produced = outcome.replay?.find((run) => run.executionRunId === runId);
    if (!produced || JSON.stringify(storedRun.outcomes.map((item) =>
      [item.executionStepId, item.status, item.reason])) !== JSON.stringify(produced.outcomes.map((item) =>
      [item.executionStepId, item.status, item.reason])))
      throw new Error('Agentic replay terminal differs from persisted run');
  }
  const terminal = mapAgenticTerminalV2(outcome);
  if (terminal.stage === 'qa') {
    if (runs.length !== 2 || outcome.kind !== 'executed' || !resolvedId || !trace ||
        trace.traceVersion !== (workflowVersion === 'structured-action-v1' ? '4' :
          workflowVersion === 'goal-directed-v1' ? '3' : '2'))
      throw new Error('QA requires matching trace version and two fresh runs');
    const signatures = outcome.replay.map((run) => JSON.stringify(run.outcomes.map((record) =>
      [record.executionStepId ?? '', record.status, record.reason ?? ''])));
    if (signatures[0] !== signatures[1] || outcome.replay.some((run) =>
      run.outcomes.some((record) => !['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
        'QA_ASSERTION_FAILED', 'NOT_RUN'].includes(record.status))))
      throw new Error('QA replays are not matching completed executions');
    const hasFailure = outcome.replay[0].outcomes.some((record) => record.status === 'QA_ASSERTION_FAILED');
    const hasPass = outcome.replay[0].outcomes.some((record) => record.status === 'QA_ASSERTION_PASSED');
    if (!hasPass && !hasFailure || (terminal.status === 'QA_ASSERTION_FAILED') !== hasFailure)
      throw new Error('QA terminal differs from replay assertions');
  }
  const mode = profilePresentationMode(profile.profile);
  const record = parseResultRecordV2({ resultVersion: '2', workflowVersion,
    testSpecId: source.testSpecId, executionProfileRef: source.executionProfileRef,
    profileFingerprint: profile.fingerprint, presentationMode: mode,
    observation: mode === 'headed' ? 'observational' : 'unobserved',
    explorationAttemptId: attemptId,
    ...(trace ? { successfulTraceId: trace.successfulTraceId } : {}),
    ...(compilerId ? { compilerAttemptId: compilerId } : {}),
    ...(resolvedId ? { resolvedSpecId: resolvedId } : {}), executionRunIds: runs, terminal,
    cleanup: outcome.kind === 'executed' ? 'verified' : outcome.cleanup });
  return store.writeAgenticTerminalV2(record);
}
