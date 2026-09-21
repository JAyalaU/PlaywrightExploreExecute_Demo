import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  parseResolvedTestSpec, parseResultRecord, parseTestSpec, SCHEMA_VERSION,
  type AuthoredStep, type ExecutionStep, type ResolvedTestSpec, type ResultRecord, type TestSpec,
} from '../domain/index.js';
import { LocalArtifactStore, executeAndStoreRun, type EvidenceCapturePolicy } from '../evidence/index.js';
import { acceptGeneratedLocator, assessGeneratedLocator, type AcceptedLocator, type LocatorObservation, type QualityAssessment } from '../locator/index.js';
import { type EffectiveProfile, ProtectedContextFactory, assertEquivalentEffectiveProfile } from '../profile/index.js';
import { bindLocator, frameIdentity } from '../runner/locator.js';
import { RUNNER_VERSION, type ExecutionRun } from '../runner/index.js';
import { MCP_VERSION, McpExplorationSession, McpToolError } from './mcp.js';

type TargetAction = 'click' | 'fill' | 'select_option';
type DataValue = string | { kind: 'dataRef'; ref: string };

/** Scripted M6 choices are made from current snapshot text, never selectors or fixture source. */
export type ResolutionDecision =
  | { kind: 'find'; text: string }
  | { kind: 'wait'; text: string }
  | { kind: 'prerequisite'; ref: string; element: string; reason: string; action: TargetAction; value?: string }
  | { kind: 'target'; ref: string; element: string }
  | { kind: 'unresolved'; reason: string };

export interface ResolutionView {
  step: AuthoredStep;
  snapshot: string;
  previousFind?: string;
  prerequisites: number;
  alternativeAttempt: boolean;
  currentUrl: string;
  priorOutcomes: readonly Pick<ResultRecord, 'originStepId' | 'status'>[];
}

export type ScriptedDecision = (view: ResolutionView) => Promise<ResolutionDecision> | ResolutionDecision;

const metadataOnlyEvidence: EvidenceCapturePolicy = {
  finalScreenshot: false, failureScreenshot: false, failureTrace: false,
  failureVideo: false, sensitiveBinaryApproved: false,
};

export interface ResolutionOutcome {
  attemptId: string;
  status: 'resolved' | 'unresolved';
  failureStatus?: ResultRecord['status'];
  failureReason?: string;
  resolved?: ResolvedTestSpec;
  replay?: readonly [ExecutionRun, ExecutionRun];
}

class ResolutionFailure extends Error {
  constructor(readonly status: ResultRecord['status'], readonly reason: string,
    readonly assessment?: QualityAssessment) {
    super(reason);
  }
}

const maxPrerequisitesPerStep = 6;
const maxFindsPerStep = 2;
const maxWaitsPerStep = 2;
const refPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

function snapshotIdentity(snapshot: string, ref: string): { role?: string; accessibleName?: string } {
  const line = snapshot.split('\n').find((part) => part.includes(`[ref=${ref}]`));
  if (!line) throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'REF_NOT_IN_CURRENT_SNAPSHOT');
  const match = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?/.exec(line);
  return match ? { ...(match[1] ? { role: match[1] } : {}), ...(match[2] === undefined ? {} : { accessibleName: match[2] }) } : {};
}

function ensureSnapshotRef(snapshot: string, ref: string): void {
  if (!refPattern.test(ref) || !snapshot.includes(`[ref=${ref}]`)) {
    throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'REF_NOT_IN_CURRENT_SNAPSHOT');
  }
}

function generatedExpression(response: string): string {
  const match = /^### Result\s*\r?\n([^\r\n]+)\s*$/m.exec(response.trim());
  if (!match?.[1]) throw new ResolutionFailure('LOCATOR_GENERATION_FAILED', 'MALFORMED_LOCATOR_RESPONSE');
  return match[1].trim();
}

function pageFor(session: McpExplorationSession): Page {
  const pages = session.browserSession.context.pages();
  if (pages.length !== 1 || !pages[0]) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'UNEXPECTED_PAGE_COUNT');
  return pages[0];
}

export async function inspectGeneratedLocator(page: Page, expression: string, ref: string, snapshot: string): Promise<LocatorObservation> {
  const staticAssessment = assessGeneratedLocator(expression);
  if (!staticAssessment.validatedForm) return { matchCount: 0 };
  const form = staticAssessment.validatedForm;
  const generated = bindLocator(page, form);
  const count = await generated.count();
  if (count !== 1) return { matchCount: count };
  const frame = frameIdentity(page, form);
  if (frame && await frame.count() !== 1) return { matchCount: 0 };
  // aria-ref is the ephemeral selector carried by MCP's AI snapshot. It is
  // used only here to compare the exact DOM node, never in persisted specs.
  const chosen: Locator = frame ? frame.contentFrame().locator(`aria-ref=${ref}`) : page.locator(`aria-ref=${ref}`);
  const same = await generated.and(chosen).count() === 1;
  return {
    matchCount: count,
    observedTargetMatches: same,
    ...snapshotIdentity(snapshot, ref),
    ...(expression.includes('getByTestId(') ? { testIdProvenance: 'mcp-discovered-stable' as const } : {}),
  };
}

function targetOf(step: AuthoredStep): string | undefined {
  if ('target' in step) return step.target.description;
  if (step.type === 'wait_for' && 'target' in step.condition) return step.condition.target.description;
  return undefined;
}

function valueOf(value: DataValue): string {
  if (typeof value !== 'string') throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'DATA_REFERENCE_UNAVAILABLE_DURING_EXPLORATION');
  return value;
}

function authoredExecution(step: AuthoredStep, id: string, evidenceRef: string, locatorId?: string,
  locator?: AcceptedLocator): ExecutionStep {
  const base = { id, originStepId: step.id, source: 'authored' as const, derivationEvidenceRef: evidenceRef };
  const targeted = locatorId && locator ? { locatorId, targetDescription: targetOf(step)!, locator } : {};
  return { ...base, ...targeted, ...Object.fromEntries(Object.entries(step).filter(([key]) =>
    !['id', 'sourceText', 'target'].includes(key))) } as ExecutionStep;
}

async function perform(session: McpExplorationSession, action: TargetAction, ref: string,
  element: string, value?: string): Promise<void> {
  if (action === 'click') await session.click(ref, element);
  else if (action === 'fill') {
    if (value === undefined) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'PREREQUISITE_VALUE_MISSING');
    await session.fill(ref, element, value);
  } else {
    if (value === undefined) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'PREREQUISITE_VALUE_MISSING');
    await session.select(ref, element, value);
  }
}

function result(source: TestSpec, attemptId: string, originStepId: string | undefined,
  executionStepId: string | undefined, locatorId: string | undefined, status: ResultRecord['status'],
  reason: string | undefined, evidenceRefs: string[], startedAt: string): ResultRecord {
  return parseResultRecord({
    phase: status === 'LOCATOR_GENERATION_FAILED' || status === 'LOCATOR_QUALITY_FAILED' ? 'locator' : 'exploration',
    status, testSpecId: source.testSpecId, explorationAttemptId: attemptId,
    executionProfileRef: source.executionProfileRef,
    ...(originStepId ? { originStepId } : {}),
    ...(executionStepId ? { executionStepId } : {}),
    ...(locatorId ? { locatorId } : {}),
    ...(reason ? { reason } : {}),
    retryable: false, startedAt, finishedAt: new Date().toISOString(), evidenceRefs,
  });
}

/** M6's bounded, scripted resolver. M7 supplies model decisions later. */
export async function resolveAndReplay(
  factory: ProtectedContextFactory, store: LocalArtifactStore, sourceInput: unknown,
  decide: ScriptedDecision, evidencePolicy: EvidenceCapturePolicy = metadataOnlyEvidence,
): Promise<ResolutionOutcome> {
  const source = parseTestSpec(sourceInput);
  const stored = await store.readJob(source.testSpecId);
  if (JSON.stringify(stored.source) !== JSON.stringify(source)) throw new Error('Stored TestSpec differs from requested source');
  const expected = factory.catalog.resolve(source.executionProfileRef);
  assertEquivalentEffectiveProfile(stored.profile, expected);
  const attemptId = `explore-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const steps: ExecutionStep[] = [];
  const results: ResultRecord[] = [];
  const evidenceRefs: string[] = [];
  let nextStep = 0;
  let nextLocator = 0;
  let session: McpExplorationSession | undefined;
  let failure: ResolutionFailure | undefined;
  let activeOrigin: string | undefined;
  let activeExecution: string | undefined;
  let activeLocator: string | undefined;

  const evidence = async (originStepId: string, executionStepId: string, locatorId: string | undefined,
    content: unknown): Promise<string> => {
    const descriptor = await store.writeEvidence(source.testSpecId, {
      evidenceId: `evidence-${randomUUID()}`, owner: { kind: 'attempt', id: attemptId },
      mediaType: 'application/json', content, originStepId, executionStepId,
      ...(locatorId ? { locatorId } : {}),
    });
    evidenceRefs.push(descriptor.ref);
    return descriptor.ref;
  };

  try {
    session = await McpExplorationSession.open(factory, source.executionProfileRef, expected);
    const capabilityEvidence = await store.writeEvidence(source.testSpecId, {
      evidenceId: `evidence-${randomUUID()}`, owner: { kind: 'attempt', id: attemptId },
      mediaType: 'application/json',
      content: { mcpVersion: MCP_VERSION, toolInventory: session.toolInventory,
        profileRef: source.executionProfileRef, profileFingerprint: expected.fingerprint,
        browserVersions: session.browserSession.versions },
    });
    evidenceRefs.push(capabilityEvidence.ref);
    if (source.startState.url !== 'about:blank') await session.navigate(source.startState.url);
    for (const step of source.steps) {
      activeOrigin = step.id;
      activeExecution = undefined;
      activeLocator = undefined;
      const stepStarted = new Date().toISOString();
      if (step.type === 'navigate') {
        const id = `x${++nextStep}`;
        activeExecution = id;
        await session.navigate(step.url);
        const ref = await evidence(step.id, id, undefined, { instruction: step.sourceText, toolCalls: session.calls.slice(-1), resultingSnapshot: await session.snapshot() });
        steps.push(authoredExecution(step, id, ref));
        results.push(result(source, attemptId, step.id, id, undefined, 'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
        continue;
      }
      const target = targetOf(step);
      if (!target) {
        const id = `x${++nextStep}`;
        activeExecution = id;
        const ref = await evidence(step.id, id, undefined, { instruction: step.sourceText, currentUrl: pageFor(session).url(), snapshot: await session.snapshot() });
        steps.push(authoredExecution(step, id, ref));
        results.push(result(source, attemptId, step.id, id, undefined, 'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
        continue;
      }
      let prerequisiteCount = 0;
      let findCount = 0;
      let waitCount = 0;
      let previousFind: string | undefined;
      let alternativeAttempt = false;
      while (true) {
        const snapshot = await session.snapshot();
        const decision = await decide({
          step, snapshot, ...(previousFind ? { previousFind } : {}),
          prerequisites: prerequisiteCount, alternativeAttempt,
          currentUrl: pageFor(session).url(),
          priorOutcomes: results.filter((item) => item.originStepId !== step.id)
            .map(({ originStepId, status }) => ({ originStepId, status })),
        });
        if (decision.kind === 'unresolved') throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', decision.reason);
        if (decision.kind === 'find') {
          if (++findCount > maxFindsPerStep) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'FIND_LIMIT_EXCEEDED');
          previousFind = await session.find(decision.text);
          continue;
        }
        if (decision.kind === 'wait') {
          if (++waitCount > maxWaitsPerStep) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'WAIT_LIMIT_EXCEEDED');
          // The runner's targeted operation has its own bounded binding wait;
          // this exploration wait does not create hidden replay state.
          await session.waitForText(decision.text);
          continue;
        }
        ensureSnapshotRef(snapshot, decision.ref);
        const id = `x${++nextStep}`;
        const locatorId = `loc${++nextLocator}`;
        activeExecution = id;
        activeLocator = locatorId;
        const response = await session.generateLocator(decision.ref, decision.element);
        const expression = generatedExpression(response);
        const observation = await inspectGeneratedLocator(pageFor(session), expression, decision.ref, snapshot);
        const assessment = assessGeneratedLocator(expression, observation);
        const derivation = {
          instruction: step.sourceText, targetDescription: decision.element,
          snapshot, ...(previousFind ? { findResult: previousFind } : {}),
          selectedRef: decision.ref, generatedLocatorResponse: response, expression, observation, assessment,
          toolCalls: session.calls.slice(-3),
        };
        const ref = await evidence(step.id, id, locatorId, derivation);
        if (assessment.status !== 'accepted') {
          results.push(result(source, attemptId, step.id, id, locatorId, 'LOCATOR_QUALITY_FAILED', assessment.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED', [ref], stepStarted));
          if (!alternativeAttempt) { alternativeAttempt = true; continue; }
          throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', assessment.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED', assessment);
        }
        const locator = acceptGeneratedLocator(expression, observation);
        if (decision.kind === 'prerequisite') {
          if (++prerequisiteCount > maxPrerequisitesPerStep) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'PREREQUISITE_LIMIT_EXCEEDED');
          await perform(session, decision.action, decision.ref, decision.element, decision.value);
          const base = {
            id, originStepId: step.id, source: 'discoveredPrerequisite' as const,
            reason: decision.reason, derivationEvidenceRef: ref,
            locatorId, targetDescription: decision.element, locator,
          };
          const prerequisite = decision.action === 'click'
            ? { ...base, type: 'click' as const }
            : { ...base, type: decision.action, value: decision.value! };
          steps.push(prerequisite);
          results.push(result(source, attemptId, step.id, id, locatorId, 'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
          previousFind = undefined;
          alternativeAttempt = false;
          continue;
        }
        const execution = authoredExecution(step, id, ref, locatorId, locator);
        steps.push(execution);
        if (step.type === 'click') await session.click(decision.ref, decision.element);
        else if (step.type === 'fill') await session.fill(decision.ref, decision.element, valueOf(step.value));
        else if (step.type === 'select_option') await session.select(decision.ref, decision.element, valueOf(step.value));
        results.push(result(source, attemptId, step.id, id, locatorId, 'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
        break;
      }
    }
  } catch (error) {
    failure = error instanceof ResolutionFailure ? error
      : error instanceof McpToolError ? new ResolutionFailure('MCP_EXPLORATION_FAILED', error.message)
      : new ResolutionFailure('MCP_EXPLORATION_FAILED', error instanceof Error ? error.message : String(error));
    const descriptor = await store.writeEvidence(source.testSpecId, {
      evidenceId: `evidence-${randomUUID()}`, owner: { kind: 'attempt', id: attemptId },
      mediaType: 'application/json',
      content: { status: failure.status, reason: failure.reason, toolCalls: session?.calls.slice(-4) ?? [] },
      ...(activeOrigin ? { originStepId: activeOrigin } : {}),
      ...(activeExecution ? { executionStepId: activeExecution } : {}),
      ...(activeLocator ? { locatorId: activeLocator } : {}),
    });
    evidenceRefs.push(descriptor.ref);
    results.push(result(source, attemptId, activeOrigin, activeExecution, activeLocator, failure.status, failure.reason, [descriptor.ref], startedAt));
  } finally {
    try { await session?.close(); }
    catch (error) {
      if (!failure) {
        failure = new ResolutionFailure('MCP_EXPLORATION_FAILED', `SESSION_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
        const descriptor = await store.writeEvidence(source.testSpecId, {
          evidenceId: `evidence-${randomUUID()}`, owner: { kind: 'attempt', id: attemptId },
          mediaType: 'application/json', content: { status: failure.status, reason: failure.reason },
        });
        evidenceRefs.push(descriptor.ref);
        results.push(result(source, attemptId, undefined, undefined, undefined, failure.status, failure.reason, [descriptor.ref], startedAt));
      }
    }
  }

  let resolved: ResolvedTestSpec | undefined;
  if (!failure) {
    try {
      resolved = parseResolvedTestSpec({
        schemaVersion: SCHEMA_VERSION, resolvedSpecId: `resolved-${randomUUID()}`,
        testSpecId: source.testSpecId, explorationAttemptId: attemptId,
        executionProfileRef: source.executionProfileRef,
        runtimeVersions: { playwright: session!.browserSession.versions.playwright, mcp: MCP_VERSION, runner: RUNNER_VERSION },
        executionSteps: steps,
      }, source);
    } catch (error) {
      failure = new ResolutionFailure('TEST_BUILD_FAILED', error instanceof Error ? error.message : String(error));
      const descriptor = await store.writeEvidence(source.testSpecId, {
        evidenceId: `evidence-${randomUUID()}`, owner: { kind: 'attempt', id: attemptId },
        mediaType: 'application/json', content: { status: failure.status, reason: failure.reason },
      });
      evidenceRefs.push(descriptor.ref);
      results.push(result(source, attemptId, undefined, undefined, undefined, failure.status, failure.reason, [descriptor.ref], startedAt));
    }
  }

  const attempt = {
    schemaVersion: SCHEMA_VERSION, testSpecId: source.testSpecId, explorationAttemptId: attemptId,
    executionProfileRef: source.executionProfileRef, profileFingerprint: expected.fingerprint,
    runtimeVersions: {
      node: process.version, playwright: session?.browserSession.versions.playwright ?? 'unavailable',
      browser: session?.browserSession.versions.browser ?? 'unavailable', mcp: MCP_VERSION,
    },
    status: failure ? 'unresolved' as const : 'resolved' as const,
    startedAt, finishedAt: new Date().toISOString(), results, evidenceRefs,
  };
  await store.writeAttempt(attempt);
  if (failure) return { attemptId, status: 'unresolved', failureStatus: failure.status, failureReason: failure.reason };
  await store.writeResolved(resolved!);
  const first = await executeAndStoreRun(factory, store, source.testSpecId, resolved!.resolvedSpecId,
    `run-${randomUUID()}`, evidencePolicy, { expectedProfile: expected });
  const second = await executeAndStoreRun(factory, store, source.testSpecId, resolved!.resolvedSpecId,
    `run-${randomUUID()}`, evidencePolicy, { expectedProfile: expected });
  return { attemptId, status: 'resolved', resolved: resolved!, replay: [first, second] };
}
