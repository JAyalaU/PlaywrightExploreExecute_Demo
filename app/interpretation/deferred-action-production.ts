import { randomUUID } from 'node:crypto';
import { parseResultRecordV2, safeAgenticReasonV2, type ResultRecordV2 } from '../domain/agentic-result-v2.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { buildActionObligationHandoffV2 } from '../domain/action-semantic-admission.js';
import { safeDeferredWorkflowStopCode, type DeferredWorkflowStageV1 } from '../domain/deferred-workflow.js';
import type { InterpretationRequest } from './interpret.js';
import { interpretDeferredActionTaskV2, type ActionSemanticExtractionModelsV2 } from './deferred-action-v2-interpret.js';
import type { ActionGroundingModelV5, IndependentGroundingModelV1 } from './action-grounding-controller.js';
import { executeActionGoalGroundingV1 } from './action-grounding-execution-controller.js';
import { GoalDirectedVerificationControllerV1, type AgenticVerificationModelV4 } from './verification-strategy.js';
import { McpExplorationSession } from '../exploration/mcp.js';
import { ActionCandidateGroundingSessionV1 } from '../exploration/action-candidate-grounding.js';
import { TrustedObservationSessionV1 } from '../exploration/trusted-observation.js';
import { SuccessfulTraceAssemblerV5 } from '../exploration/trace-assembly-v5.js';
import { compileDeferredSuccessfulTraceV5, requireTrustedDeferredCompilationV4 } from '../exploration/deferred-trace-compiler-v4.js';
import { SuccessfulTraceV5Store, requireTrustedSuccessfulTraceReadbackV5 } from '../evidence/trace-store-v5.js';
import { parseCompilerAttemptV4 } from '../domain/deferred-action-compiler.js';
import { DeferredCompilerV4Store } from '../evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store, requireTrustedDeferredReplayReadbackV1 } from '../evidence/deferred-replay-store-v9.js';
import { DeferredWorkflowStopStoreV1 } from '../evidence/deferred-workflow-store.js';
import { DeferredInterpretationAttemptStoreV1 } from '../evidence/deferred-interpretation-attempt-store.js';
import { runDeferredTwoFreshReplaysV1, requireTrustedDeferredReplayV1 } from './deferred-action-replay.js';
import { DeferredWorkflowPrivateAccountingV1Schema } from '../domain/deferred-workflow-accounting.js';
import { z } from 'zod';
import { projectDeferredReportV2 } from '../subprocess/deferred-report-projection-v2.js';
import { ProtectedContextFactory, profilePresentationMode } from '../profile/index.js';
import {NativeOptionObservationSessionV2} from '../exploration/native-option-observation.js';
import {NativeOptionVerificationControllerV2,type NativeOptionVerificationModelV6} from './native-option-verification-controller.js';

export interface DeferredProductionModelsV1 {
  extraction: ActionSemanticExtractionModelsV2;
  grounding: ActionGroundingModelV5;
  independentGrounding: IndependentGroundingModelV1;
  verification: AgenticVerificationModelV4;
  nativeVerification?:NativeOptionVerificationModelV6;
}
const issued = new WeakSet<object>(), token = Symbol('deferred-workflow-stop');
export class TrustedDeferredWorkflowStopV1 {
  readonly #result: ResultRecordV2;
  readonly #accounting;
  constructor(authority: symbol, result: ResultRecordV2, accounting: z.infer<typeof DeferredWorkflowPrivateAccountingV1Schema>) {
    if (authority !== token) throw new Error('Runtime workflow origin required');
    this.#result = parseResultRecordV2(result); this.#accounting = DeferredWorkflowPrivateAccountingV1Schema.parse(accounting); issued.add(this);
  }
  protectedResult() { return structuredClone(this.#result); }
  protectedAccounting() { return structuredClone(this.#accounting); }
}
export function requireTrustedDeferredWorkflowStopV1(value: TrustedDeferredWorkflowStopV1) {
  if (!issued.has(value)) throw new Error('Untrusted deferred workflow stop');
  return TrustedDeferredWorkflowStopV1.prototype.protectedResult.call(value);
}
export function requireTrustedDeferredWorkflowStopAccountingV1(value: TrustedDeferredWorkflowStopV1) {
  requireTrustedDeferredWorkflowStopV1(value);
  return TrustedDeferredWorkflowStopV1.prototype.protectedAccounting.call(value);
}
class StageStop extends Error {
  constructor(readonly stage: DeferredWorkflowStageV1['stage'], readonly category: DeferredWorkflowStageV1['category'], readonly code: string) { super(code); }
}
/** Single family composition. Every downstream stage receives the actual capability issued by its predecessor. */
export async function runDeferredActionProductionV1(factory: ProtectedContextFactory, artifactRoot: string,
  request: InterpretationRequest, models: DeferredProductionModelsV1, options: { signal?: AbortSignal } = {}): Promise<{
    result: ResultRecordV2; reportAvailable: boolean;
  }> {
  const profile = factory.catalog.resolve(request.executionProfileRef);
  const mode = profilePresentationMode(profile.profile);
  let stage: DeferredWorkflowStageV1['stage'] = 'interpretation';
  let sourceDigest = hash(request.sourceInstruction), admissionDigest: string | undefined, traceDigest: string | undefined;
  let explorationAttemptId: string | undefined, successfulTraceId: string | undefined, compilerAttemptId: string | undefined;
  let session: McpExplorationSession | undefined, cleanup: 'not_started' | 'verified' | 'unverified' = 'not_started';
  const accounting: z.infer<typeof DeferredWorkflowPrivateAccountingV1Schema> = { groundingAttempts: [], successfulWitnesses: [] };
  const cancelled = () => { if (options.signal?.aborted) throw new StageStop('cancellation', 'cancelled', 'CANCELLED'); };
  const finishStop = async (stop: StageStop) => {
    if (session) { try { await session.close(); if (cleanup !== 'unverified') cleanup = 'verified'; } catch { cleanup = 'unverified'; } session = undefined; }
    const terminal: ResultRecordV2['terminal'] = cleanup === 'unverified' ? { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: 'SESSION_CLEANUP_FAILED' } :
      stop.stage === 'cancellation' ? { stage: 'cancellation', status: 'CANCELLED', reason: 'CANCELLED' } :
      ['provider', 'environment', 'provider_environment', 'persistence'].includes(stop.category) ?
        { stage: 'environment', status: 'ENVIRONMENT_FAILED', reason: safeAgenticReasonV2(stop.code) === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' :
          safeAgenticReasonV2(stop.code) === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR' : 'REDACTED_REASON' } :
      stop.stage === 'interpretation' ? stop.category === 'authored_ambiguity' ?
        { stage: 'interpretation', status: 'AMBIGUOUS_INSTRUCTION', reason: 'MATERIAL_AMBIGUITY' } :
        { stage: 'interpretation', status: 'INTERPRETATION_FAILED', reason: 'INVALID_TEST_SPEC' } :
      stop.stage === 'compilation' && compilerAttemptId ? stop.category === 'unsupported' ?
        { stage: 'compilation', status: 'COMPILATION_UNSUPPORTED', reason: 'UNSUPPORTED_CAPABILITY' } :
        { stage: 'compilation', status: 'COMPILATION_FAILED', reason: ['NON_UNIQUE_MATCH', 'TARGET_MISMATCH', 'PROFILE_MISMATCH'].includes(stop.code) ?
          stop.code as 'NON_UNIQUE_MATCH' | 'TARGET_MISMATCH' | 'PROFILE_MISMATCH' : 'REDACTED_REASON' } :
      { stage: 'exploration', status: stop.category === 'unsupported' ? 'EXPLORATION_UNSUPPORTED' : 'EXPLORATION_UNRESOLVED',
        reason: 'REDACTED_REASON' };
    const result = parseResultRecordV2({ resultVersion: '2', workflowVersion: 'deferred-action-v1', testSpecId: request.testSpecId,
      executionProfileRef: request.executionProfileRef, profileFingerprint: profile.fingerprint, presentationMode: mode,
      observation: mode === 'headed' ? 'observational' : 'unobserved', cleanup, executionRunIds: [], terminal,
      ...(explorationAttemptId ? { explorationAttemptId } : {}), ...(successfulTraceId ? { successfulTraceId } : {}),
      ...(compilerAttemptId ? { compilerAttemptId } : {}),
      deferredStage: { integrationVersion: '1', sourceSchemaVersion: '6', sourceContractVersion: '2',
        stage: stop.stage, category: stop.category, code: safeDeferredWorkflowStopCode(stop.code), sourceDigest,
        ...(admissionDigest ? { admissionDigest } : {}), ...(traceDigest ? { traceDigest } : {}) } });
    // No terminal crosses the host boundary until its isolated immutable authenticated record exists.
    await new DeferredWorkflowStopStoreV1(artifactRoot).writeStop(new TrustedDeferredWorkflowStopV1(token, result, accounting));
    return { result, reportAvailable: false };
  };
  try {
    cancelled();
    const interpreted = await interpretDeferredActionTaskV2(request, models.extraction, options);
    cancelled();
    if (interpreted.timing) accounting.interpretationTiming = interpreted.timing;
    if (interpreted.kind !== 'accepted') {
      if (interpreted.structuralDiagnostic) accounting.interpretationStructural = interpreted.structuralDiagnostic;
      throw new StageStop('interpretation', interpreted.stop.category, interpreted.stop.code);
    }
    const { admission } = interpreted, source = admission.spec, handoff = buildActionObligationHandoffV2(admission);
    sourceDigest = handoff.sourceDigest; admissionDigest = handoff.admissionDigest;
    if (interpreted.timing.attempts?.some(item => item.attempt === 2)) {
      try { await new DeferredInterpretationAttemptStoreV1(artifactRoot).writeAcceptedRetry(admission,
        interpreted.timing, profile.fingerprint); }
      catch { throw new StageStop('interpretation', 'persistence', 'PERSISTENCE_FAILED'); }
    }
    stage = 'grounding'; explorationAttemptId = `exploration-${randomUUID()}`;
    session = await McpExplorationSession.open(factory, source.executionProfileRef, profile, explorationAttemptId);
    cleanup = 'verified';
    await session.navigate(source.startState.url); cancelled();
    const runtime = new ActionCandidateGroundingSessionV1(session, admission, explorationAttemptId);
    const observations = new TrustedObservationSessionV1(session, runtime);
    const verification = new GoalDirectedVerificationControllerV1(observations, runtime, models.verification);
    const nativeObservations=models.nativeVerification?new NativeOptionObservationSessionV2(session,runtime):undefined;
    const nativeVerification=nativeObservations?new NativeOptionVerificationControllerV2(nativeObservations,runtime,models.nativeVerification!):undefined;
    const builder = await SuccessfulTraceAssemblerV5.create({ admission, runtime, observations, verification,...(nativeObservations?{nativeObservations,nativeVerification:nativeVerification!}:{}), ...options });
    for (const [ordinal, goal] of source.steps.entries()) {
      cancelled();
      if (goal.type === 'action_goal') {
        const outcome = await executeActionGoalGroundingV1({ admission, runtime, goalId: goal.id,
          model: models.grounding, independentModel: models.independentGrounding });
        accounting.groundingAttempts.push(...outcome.executionAttempts);
        if (outcome.status !== 'succeeded') throw new StageStop('grounding', outcome.category, outcome.reason);
        accounting.successfulWitnesses.push(outcome.witness);
        builder.appendActionGroundingWitness(outcome.witness); verification.noteSuccessfulGroundingWitness(outcome.witness);
      } else if (goal.type === 'navigate') {
        await session.navigate(goal.url); runtime.invalidate(); await builder.appendObservedNavigation(goal.id);
      } else {
        const outcome = 'verificationVersion' in goal ? nativeVerification?await nativeVerification.evaluate(goal,ordinal,options.signal):{conclusion:'unsupported' as const,strategy:undefined} : await verification.evaluate(goal, ordinal, options.signal);
        if('stop'in outcome&&outcome.stop)throw new StageStop('grounding',outcome.stop.category as DeferredWorkflowStageV1['category'],outcome.stop.code);
        if (!outcome.strategy || !['satisfied', 'unsatisfied'].includes(outcome.conclusion)) throw new StageStop('grounding',
          outcome.conclusion === 'unsupported' ? 'unsupported' : 'unresolved', outcome.conclusion === 'unsupported' ? 'VERIFICATION_UNSUPPORTED' : 'VERIFICATION_UNRESOLVED');
        await builder.appendVerificationGoal(goal.id);
      }
    }
    cancelled(); stage = 'trace';
    let assembled;
    try { assembled = await builder.finalize(); } catch { throw new StageStop('trace', 'integrity', 'TRACE_INTEGRITY_FAILED'); }
    let trace;
    try { trace = await new SuccessfulTraceV5Store(artifactRoot).writeSuccessfulExplorationV5(assembled); }
    catch { throw new StageStop('trace', 'persistence', 'PERSISTENCE_FAILED'); }
    successfulTraceId = trace.protectedArtifact().trace.successfulTraceId; traceDigest = trace.protectedArtifact().trace.traceDigest;
    try { await session.close(); } catch { cleanup = 'unverified'; throw new StageStop('trace', 'environment', 'SESSION_CLEANUP_FAILED'); }
    session = undefined; cancelled(); stage = 'compilation';
    const compiled = await compileDeferredSuccessfulTraceV5(factory, trace);
    accounting.compilerAttempt = parseCompilerAttemptV4(requireTrustedDeferredCompilationV4(compiled.artifact).compiler,
      requireTrustedSuccessfulTraceReadbackV5(trace).trace);
    const compilerStore = new DeferredCompilerV4Store(artifactRoot);
    cleanup = compiled.compiler.cleanup;
    let v9;
    try { v9 = await compilerStore.writeCompilationV4(compiled.artifact, trace); }
    catch { throw new StageStop('compilation', 'persistence', 'PERSISTENCE_FAILED'); }
    compilerAttemptId = compiled.compiler.compilerAttemptId;
    if (!v9) throw new StageStop('compilation', compiled.kind === 'compilation_unsupported' ? 'unsupported' :
      compiled.compiler.result.status === 'rejected' && ['ENVIRONMENT_FAILURE', 'CLEANUP_UNVERIFIED'].includes(compiled.compiler.result.reasonCode) ? 'environment' : 'integrity',
      compiled.compiler.result.status === 'rejected' ? compiled.compiler.result.reasonCode : 'SOURCE_CORRESPONDENCE');
    cancelled(); stage = 'environment';
    // Exact unchanged WP4B handoff: authenticated v9 -> runtime pair -> authenticated pair/result -> safe projection.
    const pair = await runDeferredTwoFreshReplaysV1(factory, v9);
    accounting.replay = requireTrustedDeferredReplayV1(pair);
    let stored;
    try { stored = await new DeferredReplayV9Store(artifactRoot).writeReplayV1(pair, v9); }
    catch { throw new StageStop('environment', 'persistence', 'PERSISTENCE_FAILED'); }
    const { result } = requireTrustedDeferredReplayReadbackV1(stored);
    projectDeferredReportV2(stored);
    return { result, reportAvailable: true };
  } catch (error) {
    return finishStop(options.signal?.aborted ? new StageStop('cancellation', 'cancelled', 'CANCELLED') :
      error instanceof StageStop ? error : new StageStop(stage, 'environment', 'ENVIRONMENT_STOP'));
  }
}
