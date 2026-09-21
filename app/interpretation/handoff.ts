import { parseResultRecord, SCHEMA_VERSION, type ResultRecord, type TestSpec } from '../domain/index.js';
import { LocalArtifactStore, type EvidenceCapturePolicy } from '../evidence/index.js';
import { resolveAndReplay } from '../exploration/index.js';
import { ProtectedContextFactory } from '../profile/index.js';
import type { ExecutionRun } from '../runner/index.js';
import { interpretTask, type InterpretationModel, type InterpretationRequest } from './interpret.js';
import { createStepDecision, type StepDecisionModel, type StepOrchestrationOptions } from './orchestrate.js';

const metadataOnlyEvidence: EvidenceCapturePolicy = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

export type HandoffOutcome =
  | { kind: 'stopped'; result: ResultRecord; attemptId?: string }
  | { kind: 'executed'; testSpec: TestSpec; resolvedSpecId: string; attemptId: string;
      replay: readonly [ExecutionRun, ExecutionRun] };

export interface HandoffOptions {
  interpretation?: { timeoutMs?: number; maxResponseChars?: number };
  steps?: StepOrchestrationOptions;
  evidencePolicy?: EvidenceCapturePolicy;
}

/** Connect one validated interpretation to M6's accepted-spec and M4 replay path. */
export async function handoffTask(
  factory: ProtectedContextFactory, store: LocalArtifactStore, request: InterpretationRequest,
  interpretationModel: InterpretationModel, stepModel: StepDecisionModel,
  options: HandoffOptions = {},
): Promise<HandoffOutcome> {
  const interpretation = await interpretTask(request, interpretationModel, options.interpretation);
  const recordBase = {
    schemaVersion: SCHEMA_VERSION, testSpecId: request.testSpecId,
    sourceInstruction: request.sourceInstruction,
    executionProfileRef: request.executionProfileRef, startState: request.startState,
  };
  if (interpretation.kind === 'rejected') {
    const record = await store.writeInterpretation({
      ...recordBase, outcome: 'rejected', result: interpretation.result,
      ...(interpretation.explanation ? { explanation: interpretation.explanation } : {}),
    });
    return { kind: 'stopped', result: record.result };
  }

  const profile = factory.catalog.resolve(interpretation.testSpec.executionProfileRef);
  await store.createJob(interpretation.testSpec, profile);
  const now = new Date().toISOString();
  await store.writeInterpretation({
    ...recordBase, outcome: 'accepted',
    result: parseResultRecord({
      phase: 'interpretation', status: 'OPERATION_SUCCEEDED',
      testSpecId: request.testSpecId, executionProfileRef: request.executionProfileRef,
      retryable: false, startedAt: now, finishedAt: now, evidenceRefs: [],
    }),
  });

  const decide = createStepDecision(stepModel, options.steps);
  const resolved = await resolveAndReplay(
    factory, store, interpretation.testSpec, decide,
    options.evidencePolicy ?? metadataOnlyEvidence,
  );
  if (resolved.status === 'unresolved') {
    const attempt = await store.readAttempt(request.testSpecId, resolved.attemptId);
    const result = attempt.results.at(-1);
    if (!result || result.status !== resolved.failureStatus) throw new Error('Resolution result correlation failure');
    return { kind: 'stopped', result, attemptId: resolved.attemptId };
  }
  if (!resolved.resolved || !resolved.replay) throw new Error('Accepted resolution is missing persisted replay');
  return {
    kind: 'executed', testSpec: interpretation.testSpec,
    resolvedSpecId: resolved.resolved.resolvedSpecId,
    attemptId: resolved.attemptId, replay: resolved.replay,
  };
}
