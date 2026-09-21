import type { ResolvedTestSpec, ResultRecord, TestSpec } from '../domain/index.js';
import type { EffectiveProfile } from '../profile/index.js';
import { LocalArtifactStore, type EvidenceDescriptor, type ExplorationAttempt, type InterpretationRecord, type StoredRun } from './store.js';

export interface StoredJobReport {
  interpretation?: InterpretationRecord;
  testSpec: TestSpec;
  effectiveProfile: EffectiveProfile;
  attempts: readonly ExplorationAttempt[];
  resolvedSpecs: readonly ResolvedTestSpec[];
  runs: readonly StoredRun[];
  evidence: readonly EvidenceDescriptor[];
  byOriginStep: readonly {
    originStepId: string;
    sourceText: string;
    executionSteps: readonly {
      executionStepId: string;
      source: 'authored' | 'discoveredPrerequisite';
      locatorId?: string;
      outcomes: readonly ResultRecord[];
      evidenceRefs: readonly string[];
    }[];
  }[];
}

/** Reconstruct a typed report solely from persisted artifacts, without a browser. */
export async function readStoredJobReport(store: LocalArtifactStore, testSpecId: string): Promise<StoredJobReport> {
  const { source, profile } = await store.readJob(testSpecId);
  const interpretation = await store.readInterpretation(testSpecId).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (interpretation && (interpretation.outcome !== 'accepted' ||
    interpretation.testSpecId !== source.testSpecId ||
    JSON.stringify(interpretation.executionProfileRef) !== JSON.stringify(source.executionProfileRef))) {
    throw new Error('Interpretation report link mismatch');
  }
  const attemptIds = await store.listIds(testSpecId, 'attempts');
  const resolvedIds = await store.listIds(testSpecId, 'resolved');
  const runIds = await store.listIds(testSpecId, 'runs');
  const attempts = await Promise.all(attemptIds.map((value) => store.readAttempt(testSpecId, value)));
  const resolvedSpecs = await Promise.all(resolvedIds.map((value) => store.readResolved(testSpecId, value)));
  const runs = await Promise.all(runIds.map((value) => store.readRun(testSpecId, value)));
  const attemptById = new Map(attempts.map((attempt) => [attempt.explorationAttemptId, attempt]));
  const resolvedById = new Map(resolvedSpecs.map((resolved) => [resolved.resolvedSpecId, resolved]));
  const evidence = new Map<string, EvidenceDescriptor>();
  const addEvidence = async (ref: string): Promise<void> => {
    if (!evidence.has(ref)) evidence.set(ref, await store.readEvidence(testSpecId, ref));
  };
  for (const attempt of attempts) {
    if (attempt.testSpecId !== source.testSpecId || attempt.profileFingerprint !== profile.fingerprint) {
      throw new Error('Attempt report link mismatch');
    }
    for (const ref of attempt.evidenceRefs) {
      await addEvidence(ref);
      const descriptor = evidence.get(ref)!;
      if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attempt.explorationAttemptId) {
        throw new Error('Attempt evidence report link mismatch');
      }
    }
    for (const result of attempt.results) {
      if (result.explorationAttemptId !== attempt.explorationAttemptId || result.testSpecId !== source.testSpecId) throw new Error('Attempt result report link mismatch');
      for (const ref of result.evidenceRefs) {
        await addEvidence(ref);
        const descriptor = evidence.get(ref)!;
        if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== attempt.explorationAttemptId ||
          descriptor.originStepId !== result.originStepId ||
          descriptor.executionStepId !== result.executionStepId || descriptor.locatorId !== result.locatorId) {
          throw new Error('Attempt result evidence report link mismatch');
        }
      }
    }
  }
  for (const resolved of resolvedSpecs) {
    if (!attemptById.has(resolved.explorationAttemptId)) throw new Error('Resolved spec has no originating attempt');
    for (const step of resolved.executionSteps) {
      await addEvidence(step.derivationEvidenceRef);
      const descriptor = evidence.get(step.derivationEvidenceRef)!;
      if (descriptor.owner.kind !== 'attempt' || descriptor.owner.id !== resolved.explorationAttemptId ||
        descriptor.executionStepId !== step.id || descriptor.originStepId !== step.originStepId ||
        descriptor.locatorId !== ('locatorId' in step ? step.locatorId : undefined)) {
        throw new Error('Derivation evidence report link mismatch');
      }
    }
  }
  for (const run of runs) {
    const resolved = resolvedById.get(run.resolvedSpecId);
    if (!resolved || run.testSpecId !== source.testSpecId ||
      run.explorationAttemptId !== resolved.explorationAttemptId ||
      run.profileFingerprint !== profile.fingerprint) throw new Error('Run report link mismatch');
    const steps = new Map(resolved.executionSteps.map((step) => [step.id, step]));
    for (const result of run.outcomes) {
      if (result.executionRunId !== run.executionRunId || result.resolvedSpecId !== run.resolvedSpecId) {
        throw new Error('Run outcome report link mismatch');
      }
      if (result.executionStepId) {
        const step = steps.get(result.executionStepId);
        if (!step || step.originStepId !== result.originStepId ||
          result.locatorId !== ('locatorId' in step ? step.locatorId : undefined)) {
          throw new Error('Run step report link mismatch');
        }
      }
      for (const ref of result.evidenceRefs) {
        await addEvidence(ref);
        const descriptor = evidence.get(ref)!;
        if (descriptor.owner.kind !== 'run' || descriptor.owner.id !== run.executionRunId ||
          descriptor.originStepId !== result.originStepId || descriptor.executionStepId !== result.executionStepId ||
          descriptor.locatorId !== result.locatorId) {
          throw new Error('Run evidence report link mismatch');
        }
      }
    }
  }
  const byOriginStep = source.steps.map((authored) => ({
    originStepId: authored.id, sourceText: authored.sourceText,
    executionSteps: resolvedSpecs.flatMap((resolved) => resolved.executionSteps
      .filter((step) => step.originStepId === authored.id)
      .map((step) => ({
        executionStepId: step.id, source: step.source,
        ...('locatorId' in step ? { locatorId: step.locatorId } : {}),
        outcomes: runs.filter((run) => run.resolvedSpecId === resolved.resolvedSpecId)
          .flatMap((run) => run.outcomes.filter((outcome) => outcome.executionStepId === step.id)),
        evidenceRefs: [step.derivationEvidenceRef],
      }))),
  }));
  return { ...(interpretation ? { interpretation } : {}), testSpec: source, effectiveProfile: profile, attempts, resolvedSpecs, runs,
    evidence: [...evidence.values()], byOriginStep };
}
