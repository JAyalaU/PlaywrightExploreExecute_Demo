import { randomUUID } from 'node:crypto';
import { parseAgenticOutcomeV1, parseTestSpec, type AgenticOutcomeV1,
  type ResolvedTestSpecV7, type TestSpec } from '../domain/index.js';
import { LocalArtifactStore, executeAndStoreAgenticRunV7,
  type EvidenceCapturePolicy } from '../evidence/index.js';
import { compileSuccessfulTraceV3, GoalDirectedCompilationEnvironmentError } from '../exploration/index.js';
import { ProtectedContextFactory } from '../profile/index.js';
import type { ExecutionRun } from '../runner/index.js';
import { type AgenticDecisionModelV3 } from './agentic-controller.js';
import { runGoalDirectedExplorationV1 } from './agentic-goal-controller.js';
import { type AgenticVerificationModelV4 } from './verification-strategy.js';

const defaultEvidence: EvidenceCapturePolicy = { finalScreenshot: false,
  failureScreenshot: false, failureTrace: false, failureVideo: false,
  sensitiveBinaryApproved: false };
type Stop = 'exploration' | 'compilation' | 'replay';
export type GoalDirectedProductionOutcome =
  | { kind: 'stopped'; stage: Stop; attemptId: string; reasonCode: string;
      outcome: AgenticOutcomeV1; cleanup: 'verified' | 'unverified';
      compilerAttemptId?: string; resolvedSpecId?: string; replay?: readonly ExecutionRun[] }
  | { kind: 'executed'; testSpec: TestSpec; attemptId: string; successfulTraceId: string;
      compilerAttemptId: string; resolved: ResolvedTestSpecV7;
      replay: readonly [ExecutionRun, ExecutionRun]; qa: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' };

function signature(run: ExecutionRun): string {
  return JSON.stringify(run.outcomes.map((record) => [record.executionStepId ?? '',
    record.status, record.reason ?? '']));
}
function runState(run: ExecutionRun): 'pass' | 'fail' | 'automation' {
  if (run.outcomes.some((record) => !['OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED',
    'QA_ASSERTION_FAILED', 'NOT_RUN'].includes(record.status))) return 'automation';
  if (run.outcomes.some((record) => record.status === 'QA_ASSERTION_FAILED')) return 'fail';
  return run.outcomes.some((record) => record.status === 'QA_ASSERTION_PASSED') ? 'pass' : 'automation';
}

/** Explicit v4/v3/v7 production workflow; no v2/v6 fallback. */
export async function runGoalDirectedProductionV1(factory: ProtectedContextFactory,
  store: LocalArtifactStore, sourceInput: unknown, actionModel: AgenticDecisionModelV3,
  verificationModel: AgenticVerificationModelV4,
  options: { workflowVersion: 'goal-directed-v1'; evidencePolicy?: EvidenceCapturePolicy;
    signal?: AbortSignal }): Promise<GoalDirectedProductionOutcome> {
  if (options.workflowVersion !== 'goal-directed-v1') throw new Error('Goal-directed workflow version required');
  const source = parseTestSpec(sourceInput);
  if (source.schemaVersion !== '4') throw new Error('Goal-directed production requires TestSpec v4');
  const { source: stored, profile } = await store.readJob(source.testSpecId);
  if (JSON.stringify(stored) !== JSON.stringify(source)) throw new Error('Stored TestSpec mismatch');
  const exploration = await runGoalDirectedExplorationV1(factory, store, source, actionModel,
    verificationModel, { workflowVersion: options.workflowVersion,
      ...(options.signal ? { signal: options.signal } : {}) });
  if (exploration.kind === 'stopped') {
    const outcome = exploration.status === 'environment_failed'
      ? parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' })
      : exploration.status === 'cancelled'
        ? parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' })
        : parseAgenticOutcomeV1({ boundary: 'exploration', status: exploration.status });
    return { kind: 'stopped', stage: 'exploration', attemptId: exploration.attemptId,
      reasonCode: exploration.reasonCode, outcome, cleanup: exploration.cleanup };
  }
  const stop = (stage: Stop, reasonCode: string, outcome: AgenticOutcomeV1,
    cleanup: 'verified' | 'unverified', compilerAttemptId?: string,
    resolvedSpecId?: string, replay?: readonly ExecutionRun[]): GoalDirectedProductionOutcome => ({
    kind: 'stopped', stage, attemptId: exploration.attemptId, reasonCode, outcome, cleanup,
    ...(compilerAttemptId ? { compilerAttemptId } : {}),
    ...(resolvedSpecId ? { resolvedSpecId } : {}), ...(replay ? { replay } : {}),
  });
  if (exploration.cleanup !== 'verified') return stop('exploration', 'SESSION_CLEANUP_FAILED',
    parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }), 'unverified');
  if (options.signal?.aborted) return stop('exploration', 'CANCELLED',
    parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }), 'verified');
  let compiled: Awaited<ReturnType<typeof compileSuccessfulTraceV3>>;
  try { compiled = await compileSuccessfulTraceV3(factory, store, source.testSpecId, exploration.attemptId); }
  catch (error) { return stop('compilation', error instanceof GoalDirectedCompilationEnvironmentError ?
      'COMPILER_ENVIRONMENT_UNAVAILABLE' : 'REDACTED_REASON',
    parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }),
    error instanceof GoalDirectedCompilationEnvironmentError ? error.cleanup : 'unverified'); }
  if (compiled.kind !== 'compiled') return stop('compilation', compiled.reason,
    parseAgenticOutcomeV1({ boundary: 'compilation', status: compiled.kind ===
      'compilation_unsupported' ? 'unsupported' : 'durability_failed' }), compiled.cleanup,
    compiled.compiler.compilerAttemptId);
  const { compiler, resolved } = compiled;
  const accepted = await store.readCompiledExplorationV7(source.testSpecId,
    exploration.attemptId, compiler.compilerAttemptId);
  if (accepted.compiler.result.status !== 'accepted' ||
      accepted.resolved.resolvedSpecId !== resolved.resolvedSpecId ||
      accepted.resolved.successfulTraceId !== exploration.successfulTraceId ||
      accepted.resolved.profileFingerprint !== profile.fingerprint)
    throw new Error('Accepted v7 compiler provenance mismatch');
  if (options.signal?.aborted) return stop('replay', 'CANCELLED',
    parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }), 'verified',
    compiler.compilerAttemptId, resolved.resolvedSpecId);
  const replay = (): Promise<ExecutionRun> => executeAndStoreAgenticRunV7(factory, store,
    source.testSpecId, exploration.attemptId, compiler.compilerAttemptId,
    `run-${randomUUID()}`, options.evidencePolicy ?? defaultEvidence, { expectedProfile: profile });
  let first: ExecutionRun | undefined;
  let second: ExecutionRun | undefined;
  try {
    first = await replay();
    if (options.signal?.aborted) return stop('replay', 'CANCELLED',
      parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }), 'verified',
      compiler.compilerAttemptId, resolved.resolvedSpecId, [first]);
    second = await replay();
  } catch {
    return stop('replay', 'REPLAY_ENVIRONMENT_UNAVAILABLE',
      parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }), 'unverified',
      compiler.compilerAttemptId, resolved.resolvedSpecId, first ? [first] : undefined);
  }
  if (!first || !second || first.executionRunId === second.executionRunId)
    throw new Error('Fresh replay invariant failed');
  const pair = [first, second] as const;
  const a = runState(first), b = runState(second);
  if (a !== b || signature(first) !== signature(second)) return stop('replay',
    'REPLAY_OUTCOMES_DISAGREE', parseAgenticOutcomeV1({ boundary: 'replay', status: 'not_reproduced' }),
    'verified', compiler.compilerAttemptId, resolved.resolvedSpecId, pair);
  if (a === 'automation') return stop('replay', 'REPLAY_EXECUTION_FAILED',
    parseAgenticOutcomeV1({ boundary: 'replay', status: 'execution_failed' }), 'verified',
    compiler.compilerAttemptId, resolved.resolvedSpecId, pair);
  return { kind: 'executed', testSpec: source, attemptId: exploration.attemptId,
    successfulTraceId: exploration.successfulTraceId, compilerAttemptId: compiler.compilerAttemptId,
    resolved, replay: pair, qa: a === 'pass' ? 'QA_ASSERTION_PASSED' : 'QA_ASSERTION_FAILED' };
}
