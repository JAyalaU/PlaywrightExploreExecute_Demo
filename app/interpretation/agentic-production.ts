import { randomUUID } from 'node:crypto';
import { parseAgenticOutcomeV1, parseTestSpec, type AgenticOutcomeV1,
  type ResolvedTestSpecV6, type TestSpec } from '../domain/index.js';
import { LocalArtifactStore, executeAndStoreAgenticRunV6,
  type EvidenceCapturePolicy } from '../evidence/index.js';
import { compileSuccessfulTraceV1, TraceCompilationEnvironmentError } from '../exploration/index.js';
import { ProtectedContextFactory } from '../profile/index.js';
import type { ExecutionRun } from '../runner/index.js';
import { runAgenticExplorationV1, type AgenticDecisionModelV3 } from './agentic-controller.js';

const defaultEvidence: EvidenceCapturePolicy = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

type Stop = 'exploration' | 'compilation' | 'replay';
export type AgenticProductionOutcome =
  | { kind: 'stopped'; stage: Stop; attemptId: string; reasonCode: string;
      outcome: AgenticOutcomeV1; cleanup: 'verified' | 'unverified';
      compilerAttemptId?: string; resolvedSpecId?: string;
      replay?: readonly ExecutionRun[] }
  | { kind: 'executed'; testSpec: TestSpec; attemptId: string;
      successfulTraceId: string; compilerAttemptId: string;
      resolved: ResolvedTestSpecV6; replay: readonly [ExecutionRun, ExecutionRun];
      qa: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' };

/** A trusted, explicit agentic workflow entry. No public result mapping is inferred here. */
export async function runAgenticProductionV1(factory: ProtectedContextFactory,
  store: LocalArtifactStore, sourceInput: unknown, model: AgenticDecisionModelV3,
  options: { workflowVersion: 'agentic-exploration-v1'; evidencePolicy?: EvidenceCapturePolicy;
    signal?: AbortSignal }): Promise<AgenticProductionOutcome> {
  if (options.workflowVersion !== 'agentic-exploration-v1') throw new Error('Agentic workflow version required');
  const source = parseTestSpec(sourceInput);
  if (source.schemaVersion !== '2' && source.schemaVersion !== '3')
    throw new Error('Released agentic production requires TestSpec v2 or v3');
  const { source: stored, profile } = await store.readJob(source.testSpecId);
  if (JSON.stringify(stored) !== JSON.stringify(source)) throw new Error('Stored TestSpec mismatch');
  const exploration = await runAgenticExplorationV1(factory, store, source, model,
    { workflowVersion: options.workflowVersion, ...(options.signal ? { signal: options.signal } : {}) });
  if (exploration.kind === 'stopped') {
    const outcome = exploration.status === 'environment_failed'
      ? parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' })
      : exploration.status === 'cancelled'
        ? parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' })
        : parseAgenticOutcomeV1({ boundary: 'exploration', status: exploration.status });
    return { kind: 'stopped', stage: 'exploration', attemptId: exploration.attemptId,
      reasonCode: exploration.reasonCode,
      outcome,
      cleanup: exploration.cleanup };
  }
  if (exploration.cleanup !== 'verified') return {
    kind: 'stopped', stage: 'exploration', attemptId: exploration.attemptId,
    reasonCode: 'SESSION_CLEANUP_FAILED', cleanup: 'unverified',
    outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }),
  };
  if (options.signal?.aborted) return {
    kind: 'stopped', stage: 'exploration', attemptId: exploration.attemptId,
    reasonCode: 'CANCELLED', cleanup: 'verified',
    outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }),
  };
  let compiled: Awaited<ReturnType<typeof compileSuccessfulTraceV1>>;
  try { compiled = await compileSuccessfulTraceV1(factory, store, source.testSpecId, exploration.attemptId); }
  catch (error) {
    // An integrity exception has not established a reviewed compiler rejection.
    // It remains an environment/bridge stop, never an application QA verdict.
    return { kind: 'stopped', stage: 'compilation', attemptId: exploration.attemptId,
      reasonCode: error instanceof TraceCompilationEnvironmentError ?
        'COMPILER_ENVIRONMENT_UNAVAILABLE' : 'REDACTED_REASON',
      cleanup: error instanceof TraceCompilationEnvironmentError ? error.cleanup : 'unverified',
      outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }) };
  }
  if (compiled.kind === 'compilation_stop') return {
    kind: 'stopped', stage: 'compilation', attemptId: exploration.attemptId,
    compilerAttemptId: compiled.compiler.compilerAttemptId, reasonCode: compiled.reason,
    outcome: parseAgenticOutcomeV1({ boundary: 'compilation', status:
      compiled.reason === 'UNSUPPORTED_CAPABILITY' ? 'unsupported' : 'durability_failed' }),
    cleanup: compiled.cleanup,
  };
  const { resolved, compiler } = compiled;
  const accepted = await store.readCompiledExplorationV6(source.testSpecId,
    exploration.attemptId, compiler.compilerAttemptId);
  if (accepted.resolved.resolvedSpecId !== resolved.resolvedSpecId ||
      accepted.compiler.result.status !== 'accepted' ||
      accepted.resolved.profileFingerprint !== profile.fingerprint)
    throw new Error('Accepted compiler provenance mismatch');
  if (options.signal?.aborted) return {
    kind: 'stopped', stage: 'replay', attemptId: exploration.attemptId,
    compilerAttemptId: compiler.compilerAttemptId, resolvedSpecId: resolved.resolvedSpecId,
    reasonCode: 'CANCELLED', cleanup: 'verified',
    outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }),
  };
  const replay = async (): Promise<ExecutionRun> => executeAndStoreAgenticRunV6(factory, store,
    source.testSpecId, exploration.attemptId, compiler.compilerAttemptId,
    `run-${randomUUID()}`, options.evidencePolicy ?? defaultEvidence,
    { expectedProfile: profile });
  // Each call opens and disposes its own protected browser. Neither run can
  // inherit the exploration/compiler context or alter the accepted artifact.
  let first: ExecutionRun | undefined;
  let second: ExecutionRun | undefined;
  try {
    first = await replay();
    if (options.signal?.aborted) return {
      kind: 'stopped', stage: 'replay', attemptId: exploration.attemptId,
      compilerAttemptId: compiler.compilerAttemptId, resolvedSpecId: resolved.resolvedSpecId,
      reasonCode: 'CANCELLED', cleanup: 'verified',
      replay: [first],
      outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'cancelled' }),
    };
    second = await replay();
  }
  catch {
    return { kind: 'stopped', stage: 'replay', attemptId: exploration.attemptId,
      compilerAttemptId: compiler.compilerAttemptId, resolvedSpecId: resolved.resolvedSpecId,
      reasonCode: 'REPLAY_ENVIRONMENT_UNAVAILABLE', cleanup: 'unverified',
      ...(first ? { replay: [first] } : {}),
      outcome: parseAgenticOutcomeV1({ boundary: 'environment', status: 'unavailable' }) };
  }
  if (!first || !second) throw new Error('Replay completion invariant failed');
  const pair = [first, second] as const;
  const classify = (run: ExecutionRun): 'pass' | 'fail' | 'automation' => {
    if (run.outcomes.some((record) => ![
      'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED', 'QA_ASSERTION_FAILED', 'NOT_RUN',
    ].includes(record.status))) return 'automation';
    if (run.outcomes.some((record) => record.status === 'QA_ASSERTION_FAILED')) return 'fail';
    return run.outcomes.some((record) => record.status === 'QA_ASSERTION_PASSED') ? 'pass' : 'automation';
  };
  const firstState = classify(first), secondState = classify(second);
  const signature = (run: ExecutionRun): string => JSON.stringify(run.outcomes.map((record) => [
    record.executionStepId ?? '', record.status, record.reason ?? '',
  ]));
  if (firstState !== secondState || signature(first) !== signature(second)) return {
    kind: 'stopped', stage: 'replay', attemptId: exploration.attemptId,
    compilerAttemptId: compiler.compilerAttemptId, resolvedSpecId: resolved.resolvedSpecId,
    reasonCode: 'REPLAY_OUTCOMES_DISAGREE', replay: pair, cleanup: 'verified',
    outcome: parseAgenticOutcomeV1({ boundary: 'replay', status: 'not_reproduced' }),
  };
  if (firstState === 'automation') return {
    kind: 'stopped', stage: 'replay', attemptId: exploration.attemptId,
    compilerAttemptId: compiler.compilerAttemptId, resolvedSpecId: resolved.resolvedSpecId,
    reasonCode: 'REPLAY_EXECUTION_FAILED', replay: pair, cleanup: 'verified',
    outcome: parseAgenticOutcomeV1({ boundary: 'replay', status: 'execution_failed' }),
  };
  return { kind: 'executed', testSpec: source, attemptId: exploration.attemptId,
    successfulTraceId: exploration.successfulTraceId, compilerAttemptId: compiler.compilerAttemptId,
    resolved, replay: pair, qa: firstState === 'pass' ? 'QA_ASSERTION_PASSED' : 'QA_ASSERTION_FAILED' };
}
