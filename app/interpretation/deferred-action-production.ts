import { randomUUID } from 'node:crypto';
import { parseResultRecordV2, safeAgenticReasonV2, type ResultRecordV2 } from '../domain/agentic-result-v2.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { buildActionObligationHandoffV2 } from '../domain/action-semantic-admission.js';
import { DeferredWorkflowStopCodeV1Schema, safeDeferredWorkflowStopCode, type DeferredWorkflowStageV1 } from '../domain/deferred-workflow.js';
import { DeferredStartupDiagnosticV1Schema, type DeferredStartupDiagnosticV1 } from '../domain/deferred-startup-diagnostics.js';
import type { InterpretationRequest } from './interpret.js';
import { interpretDeferredActionTaskPoc, type PocSemanticModels } from './deferred-action-poc-interpret.js';
import type { ActionGroundingModelV5, IndependentGroundingModelV1, ActionGroundingOutcomeV1 } from './action-grounding-controller.js';
import { executeActionGoalGroundingV1 } from './action-grounding-execution-controller.js';
import { GoalDirectedVerificationControllerV1, type AgenticVerificationModelV4 } from './verification-strategy.js';
import { McpExplorationSession, McpToolError } from '../exploration/mcp.js';
import { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } from '../exploration/action-candidate-grounding.js';
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
import { DeferredGroundingStopDiagnosticV1Schema, DeferredWorkflowPrivateAccountingV1Schema } from '../domain/deferred-workflow-accounting.js';
import { z } from 'zod';
import { projectDeferredReportV2 } from '../subprocess/deferred-report-projection-v2.js';
import { ProtectedContextFactory, profilePresentationMode } from '../profile/index.js';
import {NativeOptionObservationSessionV2} from '../exploration/native-option-observation.js';
import {NativeOptionVerificationControllerV2,type NativeOptionVerificationModelV6} from './native-option-verification-controller.js';
import { DeferredVerificationDiagnosticV1Schema, diagnosticText, diagnosticOptionValue,
  type DeferredVerificationObservationAttemptV1 } from '../domain/deferred-verification-diagnostic.js';
import type { TrustedObservationResultV1 } from '../domain/observation-contracts.js';
import type { NativeOptionObservationV2 } from '../domain/native-option-verification.js';

export interface DeferredProductionModelsV1 {
  extraction: PocSemanticModels;
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
  const accounting: z.infer<typeof DeferredWorkflowPrivateAccountingV1Schema> = { groundingAttempts: [], successfulWitnesses: [], verificationDiagnostics: [] };
  const startupDiagnostics: DeferredStartupDiagnosticV1[] = [];
  accounting.startupDiagnostics = startupDiagnostics;
  const safeException = (error: unknown): DeferredStartupDiagnosticV1['exceptionName'] => {
    const name = error instanceof Error ? error.name : undefined;
    return DeferredStartupDiagnosticV1Schema.shape.exceptionName.unwrap().safeParse(name).success
      ? name as DeferredStartupDiagnosticV1['exceptionName'] : 'OtherError';
  };
  const safeCode = (error: unknown, step: DeferredStartupDiagnosticV1['stage']): DeferredStartupDiagnosticV1['code'] | undefined => {
    if (error instanceof McpToolError) return step === 'root_navigation' &&
      /(?:^|\n)(?:Error:\s*)?(?:page\.goto:\s*)?TimeoutError\b|\bpage\.goto:\s*Timeout \d+ms exceeded\b/i.test(error.reason)
      ? 'NAVIGATION_TIMEOUT' : 'MCP_TOOL_ERROR';
    if (error instanceof ActionCandidateGroundingError) return DeferredWorkflowStopCodeV1Schema.safeParse(error.reason).success
      ? error.reason as DeferredStartupDiagnosticV1['code'] : undefined;
    if (error instanceof StageStop) return DeferredWorkflowStopCodeV1Schema.safeParse(error.code).success
      ? error.code as DeferredStartupDiagnosticV1['code'] : undefined;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(code))
      ? code as DeferredStartupDiagnosticV1['code'] : undefined;
  };
  const recordStartup = async <T>(step: DeferredStartupDiagnosticV1['stage'], run: () => Promise<T>): Promise<T> => {
    const startedAt = new Date().toISOString(), started = performance.now();
    try {
      const value = await run();
      startupDiagnostics.push({ stage: step, startedAt,
        endedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started))), status: 'completed' });
      return value;
    } catch (error) {
      const code = safeCode(error, step);
      startupDiagnostics.push({ stage: step, startedAt,
        endedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started))),
        status: 'failed', exceptionName: safeException(error), ...(code ? { code } : {}) });
      throw error;
    }
  };
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
    const interpreted = await interpretDeferredActionTaskPoc(request, models.extraction, options);
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
    session = await recordStartup('session_open', () => McpExplorationSession.open(factory, source.executionProfileRef, profile, explorationAttemptId));
    cleanup = 'verified';
    await recordStartup('root_navigation', () => session!.navigate(source.startState.url)); cancelled();
    const runtime = new ActionCandidateGroundingSessionV1(session, admission, explorationAttemptId);
    const observations = new TrustedObservationSessionV1(session, runtime);
    const verification = new GoalDirectedVerificationControllerV1(observations, runtime, models.verification);
    const nativeObservations=models.nativeVerification?new NativeOptionObservationSessionV2(session,runtime):undefined;
    const nativeVerification=nativeObservations?new NativeOptionVerificationControllerV2(nativeObservations,runtime,models.nativeVerification!):undefined;
    const builder = await recordStartup('initial_protected_state', () => SuccessfulTraceAssemblerV5.create({ admission, runtime, observations, verification,
      aroundInitialObservation: (read) => recordStartup('initial_observation', read),
      ...(nativeObservations?{nativeObservations,nativeVerification:nativeVerification!}:{}), ...options }));
    let firstGroundingDecision = true;
    for (const [ordinal, goal] of source.steps.entries()) {
      cancelled();
      if (goal.type === 'action_goal') {
        const outcome = await executeActionGoalGroundingV1({ admission, runtime, goalId: goal.id,
          model: models.grounding, independentModel: models.independentGrounding,
          ...(firstGroundingDecision ? { aroundFirstDecision: async (prepare: () => Promise<ActionGroundingOutcomeV1>) => {
            const decision = await recordStartup('first_grounding_decision', prepare);
            if (decision.status === 'stop') {
              const diagnostic = startupDiagnostics[startupDiagnostics.length - 1]!;
              diagnostic.status = 'stopped';
              const code = DeferredWorkflowStopCodeV1Schema.safeParse(decision.reason);
              if (code.success) diagnostic.code = code.data;
            }
            return decision;
          } } : {}) });
        firstGroundingDecision = false;
        accounting.groundingAttempts.push(...outcome.executionAttempts);
        if (outcome.status !== 'succeeded') {
          if (outcome.diagnostic) {
            const privateDiagnostic = DeferredGroundingStopDiagnosticV1Schema.safeParse({
              diagnosticVersion: '1', stepId: outcome.diagnostic.goalId,
              ...(outcome.diagnostic.operation ? { operation: outcome.diagnostic.operation } : {}),
              pending: outcome.diagnostic.pending,
              ...(outcome.diagnostic.candidateCount !== undefined ?
                { candidateCount: outcome.diagnostic.candidateCount } : {}),
            });
            if (privateDiagnostic.success && privateDiagnostic.data.stepId === goal.id)
              accounting.groundingStop = privateDiagnostic.data;
          }
          throw new StageStop('grounding', outcome.category, outcome.reason);
        }
        accounting.successfulWitnesses.push(outcome.witness);
        builder.appendActionGroundingWitness(outcome.witness); verification.noteSuccessfulGroundingWitness(outcome.witness);
      } else if (goal.type === 'navigate') {
        await session.navigate(goal.url); runtime.invalidate(); await builder.appendObservedNavigation(goal.id);
      } else {
        const native = 'verificationVersion' in goal;
        const started = performance.now();
        const ordinaryGoal = !native ? goal as Exclude<typeof goal, { verificationVersion: '2' }> : undefined;
        const urlLiteral = ordinaryGoal?.sourceText.match(/https?:\/\/[^\s<>"']+/)?.[0]?.replace(/[.,;!?]+$/, '');
        const safeUrl = diagnosticText(urlLiteral);
        const resultingUrl = !!safeUrl && /\b(?:url|takes?\s+(?:you\s+)?to)\b/i.test(ordinaryGoal!.sourceText);
        const attemptStrategy = native ? 'native_owned_option' as const : resultingUrl ? 'poc_resulting_url' as const : 'ordinary_model' as const;
        const observationAttempts:DeferredVerificationObservationAttemptV1[]=[];
        const unsubscribeAttempt = native ? nativeObservations?.onPrivateObservationAttempt((probe)=>{
          if(observationAttempts.length<8)observationAttempts.push({attemptVersion:'1',stepId:goal.id,strategy:attemptStrategy,...probe});
        }) : observations.onPrivateObservationAttempt((probe)=>{
          if(observationAttempts.length<8)observationAttempts.push({attemptVersion:'1',stepId:goal.id,strategy:attemptStrategy,...probe});
        });
        const captured: Array<TrustedObservationResultV1 | NativeOptionObservationV2> = [];
        const unsubscribe = native
          ? nativeObservations?.onProtectedRecord((record) => { if (captured.length < 8 && record.goalStepId === goal.id) captured.push(record); })
          : observations.onProtectedRecord((record) => { if (captured.length < 8) captured.push(record); });
        let outcome;
        let evaluationError: unknown;
        try { outcome = native ? nativeVerification?await nativeVerification.evaluate(goal,ordinal,options.signal):{conclusion:'unsupported' as const,strategy:undefined,reason:'NATIVE_VERIFIER_UNAVAILABLE'}
          : await verification.evaluate(goal, ordinal, options.signal); }
        catch (error) { evaluationError = error; outcome = { conclusion: 'unresolved' as const, strategy: undefined, reason: 'EVALUATION_EXCEPTION' }; }
        finally { unsubscribe?.(); unsubscribeAttempt?.(); }
        const last = captured.at(-1);
        const nativeRead = native ? nativeObservations?.protectedDiagnostic(goal.id) : undefined;
        const nativeGoal = native ? goal as Extract<typeof goal, { verificationVersion: '2' }> : undefined;
        const observationKind = last?.status === 'complete' ? last.result.kind : last?.status === 'error' ? 'error' : undefined;
        const observed = last?.status === 'complete' ? last.result.kind === 'native_owned_option_state' ? last.result.selected :
          last.result.kind === 'url' ? diagnosticText(last.result.value) : last.result.kind === 'matches' ? last.result.count :
          last.result.kind === 'property' && (typeof last.result.value === 'boolean' || typeof last.result.value === 'number') ? last.result.value : undefined : undefined;
        const comparison = outcome.strategy?.comparison;
        const comparisonAttempted = native ? 'comparisonAttempted' in outcome && outcome.comparisonAttempted === true :
          !!comparison || !!outcome.strategy;
        const verificationStop = (outcome as { stop?: { category: string; code: string } }).stop;
        const reason = 'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason :
          last?.status === 'error' ? last.reason : verificationStop?.code;
        const decision = outcome.conclusion === 'satisfied' ? 'true' : outcome.conclusion === 'unsatisfied' ? 'false' : outcome.conclusion;
        const diagnostic = DeferredVerificationDiagnosticV1Schema.safeParse({
          diagnosticVersion: '1', stepId: goal.id, verificationVersion: native ? '2' : '1',
          ...(goal.dependsOnStepId ? { dependencyStepId: goal.dependsOnStepId } : {}),
          claimKind: native ? nativeGoal!.claim.kind : resultingUrl ? 'resulting_url' : ordinaryGoal?.intent?.kind ?? 'unhinted',
          ...(native ? { expected: nativeGoal!.claim.expectedSelected, optionLabel: diagnosticText(nativeGoal!.claim.optionLabel),
            controlConstraints: nativeGoal!.claim.controlConstraints.map(({ kind, text }) => ({ kind, text: diagnosticText(text) })).filter((item): item is {kind:'role'|'name'|'label';text:string} => !!item.text) } :
            resultingUrl ? { expected: safeUrl } : ordinaryGoal?.intent && 'expected' in ordinaryGoal.intent ? { expected: ordinaryGoal.intent.expected } :
              ordinaryGoal?.intent && 'count' in ordinaryGoal.intent ? { expected: ordinaryGoal.intent.count } : {}),
          ...(ordinaryGoal?.subject ? { subject: { ...(ordinaryGoal.subject.role ? { role: ordinaryGoal.subject.role } : {}),
            ...(diagnosticText(ordinaryGoal.subject.accessibleName) ? { name: diagnosticText(ordinaryGoal.subject.accessibleName) } : {}) } } : {}),
          ...(ordinaryGoal?.intent ? { intentKind: ordinaryGoal.intent.kind } : {}),
          strategy: native ? 'native_owned_option' : resultingUrl ? 'poc_resulting_url' : 'ordinary_model',
          ...(observationKind ? { observationKind } : {}), ...(observed !== undefined ? { observed } : {}),
          ...(nativeRead?.ownerCandidateCount !== undefined ? { ownerCandidateCount: nativeRead.ownerCandidateCount } : {}),
          ...(nativeRead?.ownerRole ? { ownerRole: nativeRead.ownerRole } : {}),
          ...(nativeGoal?.claim.controlConstraints.find((c) => c.kind === 'name') ? { ownerName: diagnosticText(nativeGoal.claim.controlConstraints.find((c) => c.kind === 'name')!.text) } : {}),
          ...(nativeRead?.optionCandidateCount !== undefined ? { optionCandidateCount: nativeRead.optionCandidateCount } : {}),
          ...(nativeRead?.optionSelected !== undefined ? { optionSelected: nativeRead.optionSelected } : {}),
          ...(last?.status === 'complete' && last.result.kind === 'native_owned_option_state' ?
            { optionValue: diagnosticOptionValue(last.result.optionValue) } : {}),
          ...(nativeRead?.unresolvedConstraint ? { unresolvedConstraint: diagnosticText(nativeRead.unresolvedConstraint) } : {}),
          comparisonAttempted,
          ...('decisionKind' in outcome && outcome.decisionKind ? { decisionKind: outcome.decisionKind } : {}),
          ...('decisionTurn' in outcome && outcome.decisionTurn ? { decisionTurn: outcome.decisionTurn } : {}),
          ...(comparisonAttempted ? { comparisonKind: native ? 'native_owned_option_selected' : comparison?.kind ?? (resultingUrl ? 'string_equal_url' : undefined) } : {}),
          ...(comparisonAttempted ? native ? { comparisonExpected: nativeGoal!.claim.expectedSelected } : comparison && 'expected' in comparison ?
            { comparisonExpected: comparison.expected } : resultingUrl ? { comparisonExpected: safeUrl } : {} : {}),
          decision, ...(reason ? { reason: diagnosticText(reason) } : {}),
          elapsedMs: Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started))),
          observationAttempts,
        });
        if (diagnostic.success && accounting.verificationDiagnostics!.length < 100)
          accounting.verificationDiagnostics!.push(diagnostic.data);
        if (evaluationError !== undefined) throw evaluationError;
        if(verificationStop)throw new StageStop('grounding',verificationStop.category as DeferredWorkflowStageV1['category'],verificationStop.code);
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
    // Diagnostics never change a completed QA result if their private write fails.
    if (explorationAttemptId && startupDiagnostics.length) {
      try { await new DeferredWorkflowStopStoreV1(artifactRoot).writeStartupDiagnostics(request.testSpecId,
        explorationAttemptId, profile.fingerprint, startupDiagnostics); } catch { /* Best-effort private diagnostics. */ }
    }
    if (explorationAttemptId && accounting.verificationDiagnostics?.length) {
      try { await new DeferredWorkflowStopStoreV1(artifactRoot).writeVerificationDiagnostics(request.testSpecId,
        explorationAttemptId, profile.fingerprint, accounting.verificationDiagnostics); }
      catch { /* Best-effort private diagnostics never change QA. */ }
    }
    return { result, reportAvailable: true };
  } catch (error) {
    return finishStop(options.signal?.aborted ? new StageStop('cancellation', 'cancelled', 'CANCELLED') :
      error instanceof StageStop ? error : new StageStop(stage, 'environment', 'ENVIRONMENT_STOP'));
  }
}
