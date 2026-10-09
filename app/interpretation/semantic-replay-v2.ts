import { randomUUID } from 'node:crypto';
import { ProtectedContextFactory } from '../profile/local-context.js';
import { semanticGroundingDigestV1 as hash } from '../domain/semantic-grounding-v1.js';
import { sealSemanticReplayPairV2, parseSemanticReplayPairV2,
  type SemanticReplayPairV2, type SemanticRunnerRecordV10 } from '../domain/semantic-runner-v10.js';
import { requireTrustedSemanticResolvedReadbackV10,
  type TrustedSemanticResolvedReadbackV10 } from '../evidence/semantic-compiler-store-v5.js';
import { runSemanticResolvedTestV10, requireTrustedSemanticRunV10 } from '../runner/semantic-v10.js';

const issued = new WeakSet<object>(), token = Symbol('semantic-two-replay-v2-origin');
export class TrustedSemanticReplayV2 {
  readonly #record: SemanticReplayPairV2;
  constructor(authority: symbol, record: SemanticReplayPairV2) {
    if (authority !== token) throw new Error('Semantic replay origin required');
    this.#record = structuredClone(record); issued.add(this);
  }
  protectedRecord(): SemanticReplayPairV2 { return structuredClone(this.#record); }
}
export function requireTrustedSemanticReplayV2(input: TrustedSemanticReplayV2): SemanticReplayPairV2 {
  if (!issued.has(input)) throw new Error('Untrusted semantic replay');
  return TrustedSemanticReplayV2.prototype.protectedRecord.call(input);
}

export function validateSemanticReplayRunsV2(runs: SemanticRunnerRecordV10[],
  artifact: ReturnType<typeof requireTrustedSemanticResolvedReadbackV10>): void {
  const { resolved, compiler, trace } = artifact;
  for (const run of runs) {
    if (run.resolvedSpecId !== resolved.resolvedSpecId || run.resolvedDigest !== resolved.resolvedDigest ||
      run.compilerAttemptId !== compiler.compilerAttemptId || run.traceDigest !== trace.traceDigest ||
      run.profileFingerprint !== resolved.profileFingerprint ||
      run.sessionId === trace.sessionId || run.sessionId === compiler.freshSessionId)
      throw new Error('SEMANTIC_RUN_PROVENANCE_V10');
    if (run.result.kind === 'completed' && (run.sessionId === null ||
      run.steps.length !== resolved.executionSteps.length ||
      run.steps.some(s => s.status === 'stopped'))) throw new Error('SEMANTIC_INCOMPLETE_RUN_V10');
    for (const [index, evidence] of run.steps.entries()) {
      const step = resolved.executionSteps[index];
      if (!step || evidence.stepId !== step.stepId || evidence.resolvedType !== step.type ||
        evidence.operation !== (step.type === 'navigate' ? 'navigate' : step.type === 'action' ?
          step.operation : null) ||
        step.type === 'action' && evidence.status === 'action_succeeded' &&
          (evidence.invocation !== 'returned' || step.operation === 'check' && evidence.effect !== true ||
            step.operation === 'uncheck' && evidence.effect !== false ||
            step.operation === 'fill' && evidence.effect !== step.argument ||
            step.operation === 'select_option' && evidence.effect !== step.option?.value) ||
        step.type !== 'action' && step.type !== 'navigate' && evidence.status !== 'stopped' &&
          (evidence.expected !== step.expected || evidence.status !== 'assertion_true' &&
            evidence.status !== 'assertion_false') ||
        evidence.status === 'stopped' && index !== run.steps.length - 1)
        throw new Error('SEMANTIC_RUN_STEP_MISMATCH_V10');
      if (evidence.status !== 'stopped' && 'domain' in step) {
        const guard = evidence.guard, domain = step.domain;
        if (!guard || guard.domainVersion !== domain.domainVersion || !guard.complete ||
          guard.selectedIndex !== domain.selectedIndex || guard.ordinal !== domain.ordinal ||
          guard.relationSatisfied !== (domain.relation ? true : null) ||
          domain.requireGroundedCount && (guard.count !== domain.groundedCount ||
            hash(guard.orderedIdentities) !== hash(domain.orderedIdentities)) ||
          'target' in step && guard.selectedIdentity !== step.target.identity ||
          step.type === 'assert_count' && (guard.selectedIndex !== null ||
            evidence.observation !== guard.count))
          throw new Error('SEMANTIC_RUN_GUARD_MISMATCH_V10');
      }
    }
    if (run.result.kind === 'completed') {
      const assertions = run.steps.filter(s => s.status === 'assertion_true' || s.status === 'assertion_false');
      if (run.result.assertions !== assertions.length ||
        run.result.passed !== assertions.every(s => s.status === 'assertion_true'))
        throw new Error('SEMANTIC_RUN_ASSERTION_ACCOUNTING_V10');
    }
  }
}

/** Two sequential fresh sessions. Only matching complete deterministic assertions can issue QA. */
export async function runSemanticTwoFreshReplaysV2(factory: ProtectedContextFactory,
  input: TrustedSemanticResolvedReadbackV10,
  onRunStart?: (ordinal: 1 | 2) => void, diagnosticRoot?: string): Promise<TrustedSemanticReplayV2> {
  const artifact = requireTrustedSemanticResolvedReadbackV10(input);
  const startedAt = new Date().toISOString(), runs: SemanticRunnerRecordV10[] = [];
  for (let index = 0; index < 2; index++) {
    onRunStart?.(index === 0 ? 1 : 2);
    try { runs.push(requireTrustedSemanticRunV10(await runSemanticResolvedTestV10(factory, input,
      undefined, diagnosticRoot))); }
    catch { break; }
    if (runs[index]!.cleanup !== 'verified' || runs[index]!.result.kind !== 'completed') break;
  }
  validateSemanticReplayRunsV2(runs, artifact);
  const pair = sealSemanticReplayPairV2({ orchestrationVersion: '2',
    orchestrationId: `semantic-replay-pair-${randomUUID()}`, startedAt,
    finishedAt: new Date().toISOString(), resolvedSpecId: artifact.resolved.resolvedSpecId,
    resolvedDigest: artifact.resolved.resolvedDigest, runs });
  parseSemanticReplayPairV2(pair);
  return new TrustedSemanticReplayV2(token, pair);
}
