import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  AcceptedLocatorSchema, parseResolvedTestSpec, parseResultRecord, parseTestSpec, SCHEMA_VERSION,
  SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION, SEMANTIC_ROLE_NAME_SCHEMA_VERSION,
  type AuthoredStep, type ExecutionStep, type ResolvedTestSpec, type ResultRecord, type TestSpec,
} from '../domain/index.js';
import { LocalArtifactStore, executeAndStoreRun, type EvidenceCapturePolicy, type M7DecisionDiagnostic } from '../evidence/index.js';
import {
  acceptAbsentLinkCollectionLocator, acceptGeneratedLinkCollectionLocator, acceptGeneratedLocator, acceptSemanticRowLocator,
  assessGeneratedLinkCollectionLocator, assessGeneratedLocator, parseAuthoredRoleNameIdentity,
  reviewAuthoredRoleNameIdentity,
  type AcceptedLinkCollectionLocator, type AcceptedLocator,
  type LocatorObservation, type LocatorQualityReason, type QualityAssessment,
} from '../locator/index.js';
import { type EffectiveProfile, ProtectedContextFactory, assertEquivalentEffectiveProfile } from '../profile/index.js';
import { bindLocator, frameIdentity } from '../runner/locator.js';
import { RUNNER_VERSION, type ExecutionRun } from '../runner/index.js';
import { MCP_VERSION, McpExplorationSession, McpToolError } from './mcp.js';
import type { LiveEventProducer } from '../observability/live-events.js';

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
  locatorRejection?: LocatorRejectionFeedback;
  currentUrl: string;
  priorOutcomes: readonly Pick<ResultRecord, 'originStepId' | 'status'>[];
}

/** Closed quality facts from the one rejected candidate that triggered refinement. */
export interface LocatorRejectionFeedback {
  schemaVersion: '2';
  retryMode: 'same_node_refinement' | 'different_node_selection';
  selectedRef: string;
  targetDescription: string;
  reasons: readonly LocatorQualityReason[];
  checks: QualityAssessment['checks'];
}

function retryMode(assessment: QualityAssessment, step: AuthoredStep, snapshot: string,
  selectedRef: string): LocatorRejectionFeedback['retryMode'] {
  const target = step.type === 'wait_for' && 'target' in step.condition
    ? step.condition.target : 'target' in step ? step.target : undefined;
  const explicit = target ? parseAuthoredRoleNameIdentity(target.description) : null;
  const selected = explicit ? snapshotIdentity(snapshot, selectedRef) : undefined;
  const selectionWrong = explicit && (selected?.role?.toLocaleLowerCase('en-US') !== explicit.role ||
    selected?.accessibleName !== explicit.name);
  return !selectionWrong && assessment.reasons.length > 0 &&
    assessment.reasons.every((reason) => reason === 'WEAK_IDENTITY' || reason === 'TEST_ID_PROVENANCE_UNVERIFIED') &&
    assessment.checks.uniqueness === 'passed' && assessment.checks.observedTarget === 'passed'
    ? 'same_node_refinement' : 'different_node_selection';
}

function hasNewSemanticEvidence(snapshot: string, step: AuthoredStep,
  decision: Extract<ResolutionDecision, { kind: 'target' | 'prerequisite' }>,
  rejection: LocatorRejectionFeedback): boolean {
  if (decision.element === rejection.targetDescription) return false;
  const identity = snapshotIdentity(snapshot, decision.ref);
  const description = decision.element.toLocaleLowerCase('en-US');
  const previous = rejection.targetDescription.toLocaleLowerCase('en-US');
  const explicit = parseAuthoredRoleNameIdentity(decision.element);
  const roleAndName = explicit && identity.role && identity.accessibleName &&
    explicit.role === identity.role.toLocaleLowerCase('en-US') &&
    explicit.name === identity.accessibleName &&
    (!containsExactPhrase(previous, identity.role) ||
      !containsExactPhrase(previous, identity.accessibleName));
  const target = step.type === 'wait_for' && 'target' in step.condition
    ? step.condition.target : 'target' in step ? step.target : undefined;
  const scope = target?.scope?.some((item) =>
    containsExactPhrase(description, item.description) &&
    !containsExactPhrase(previous, item.description) &&
    snapshot.toLocaleLowerCase('en-US').includes(item.description.toLocaleLowerCase('en-US')));
  return Boolean(roleAndName || scope);
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

/** Read only the current MCP accessibility tree; do not infer row identity from DOM/source. */
function snapshotRows(snapshot: string): string[][] {
  const lines = snapshot.split('\n');
  const rows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)- row(?:\s|:|$)/.exec(lines[i]!);
    if (!match) continue;
    const indentation = match[1]!.length;
    const descendants: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = /^(\s*)- /.exec(lines[j]!);
      if (candidate && candidate[1]!.length <= indentation) break;
      descendants.push(lines[j]!);
    }
    rows.push(descendants);
  }
  return rows;
}

function containsExactPhrase(description: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(description);
}

/** Resolve an authored natural-language row description to one exact cell in the current snapshot. */
function cellNameFromScope(snapshot: string, description: string): string | undefined {
  const names = new Set(snapshotRows(snapshot).flatMap((row) => row.flatMap((line) => {
    const match = /- cell "([^\"]+)"(?:\s|:|$)/.exec(line);
    return match?.[1] ? [match[1]] : [];
  })).filter((name) => containsExactPhrase(description, name)));
  return names.size === 1 ? [...names][0] : undefined;
}

/** The selected MCP ref must belong to exactly one authored cell row and exact-name link. */
function rowContainsSelectedLink(snapshot: string, cellName: string, linkName: string, ref: string): boolean {
  const rows = snapshotRows(snapshot);
  const matchingRows = rows.filter((row) => row.some((line) => {
    const match = /- cell "([^"]+)"(?:\s|:|$)/.exec(line);
    return match?.[1] === cellName;
  }));
  if (matchingRows.length !== 1) return false;
  const links = matchingRows[0]!.filter((line) => {
    const match = /- link "([^"]+)" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line);
    return match?.[1] === linkName;
  });
  return links.length === 1 && links[0]!.includes(`[ref=${ref}]`);
}

function describesLink(description: string, accessibleName: string): boolean {
  const authored = description.trim().toLocaleLowerCase('en-US');
  const name = accessibleName.trim().toLocaleLowerCase('en-US');
  return authored === name || authored === `${name} link`;
}

async function semanticRowProjection(page: Page, step: AuthoredStep, snapshot: string,
  selectedRef: string, rawExpression: string): Promise<{ locator: AcceptedLocator; observation: LocatorObservation } | undefined> {
  if (step.type !== 'click' || step.target.scope?.length !== 1 || step.target.scope[0]?.kind !== 'row') return undefined;
  const cellName = cellNameFromScope(snapshot, step.target.scope[0].description);
  if (!cellName) {
    throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'SCOPED_ROW_OR_LINK_NOT_UNIQUE_IN_SNAPSHOT');
  }
  const identity = snapshotIdentity(snapshot, selectedRef);
  if (identity.role !== 'link' || !identity.accessibleName ||
      !describesLink(step.target.description, identity.accessibleName)) {
    throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'SCOPED_LINK_IDENTITY_MISMATCH');
  }
  const linkName = identity.accessibleName;
  const baseExpression = rawExpression.replace(/\.nth\([0-9]+\)$/, '');
  const positionalBase = baseExpression === rawExpression ? undefined : assessGeneratedLocator(baseExpression).validatedForm;
  const positionalLink = positionalBase?.type === 'role' && positionalBase.role === 'link' && positionalBase.name === linkName;
  const rowLink = /^getByRole\('row', \{ name: '[^']+' \}\)\.getByRole\('link'\)$/.test(rawExpression);
  if (!positionalLink && !rowLink) return undefined;
  if (!rowContainsSelectedLink(snapshot, cellName, linkName, selectedRef)) {
    throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'SCOPED_ROW_OR_LINK_NOT_UNIQUE_IN_SNAPSHOT');
  }
  const form = { type: 'within' as const, scope: { type: 'rowWithCell' as const, cellName },
    target: { type: 'role' as const, role: 'link' as const, name: linkName, exact: true as const } };
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: cellName, exact: true }) });
  if (await row.count() !== 1) throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'SCOPED_ROW_NOT_UNIQUE');
  const matches = bindLocator(page, form);
  const count = await matches.count();
  if (count !== 1) throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', 'NON_UNIQUE_MATCH');
  const same = await matches.and(page.locator(`aria-ref=${selectedRef}`)).count() === 1;
  if (!same) throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', 'TARGET_MISMATCH');
  const observation: LocatorObservation = { role: 'link', accessibleName: linkName,
    matchCount: 1, observedTargetMatches: true };
  return { locator: acceptSemanticRowLocator(rawExpression, cellName, linkName, observation), observation };
}

/** Recheck one exact authored identity in the protected page against the MCP-selected node. */
async function semanticRoleNameProjection(page: Page, step: AuthoredStep, snapshot: string,
  selectedRef: string, rawExpression: string): Promise<AcceptedLocator | undefined> {
  const target = step.type === 'wait_for' && 'target' in step.condition
    ? step.condition.target : 'target' in step ? step.target : undefined;
  if (!target || target.scope?.length) return undefined;
  const selected = snapshotIdentity(snapshot, selectedRef);
  if (!selected.role || !selected.accessibleName) return undefined;
  const form = { type: 'role' as const, role: selected.role,
    name: selected.accessibleName, exact: true as const };
  const matches = bindLocator(page, form);
  const count = await matches.count();
  if (count !== 1) return undefined;
  const same = await matches.and(page.locator(`aria-ref=${selectedRef}`)).count() === 1;
  const observation: LocatorObservation = { role: selected.role, accessibleName: selected.accessibleName,
    matchCount: count, observedTargetMatches: same };
  const witness = reviewAuthoredRoleNameIdentity(target, form, observation);
  if (!witness) return undefined;
  return AcceptedLocatorSchema.parse({
    origin: 'verifiedRoleNameProjection', mcpGeneratedExpression: rawExpression,
    rawRejection: { reasons: ['WEAK_IDENTITY'], matchCount: 1, observedTargetMatches: true },
    validatedForm: witness.validatedForm, observed: witness.observed,
    quality: { status: 'accepted', identityBasis: witness.identityBasis },
  });
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

/** Compare one MCP-selected exemplar with the generated main-document collection. */
export async function inspectGeneratedLinkCollectionLocator(page: Page, expression: string,
  linkName: string, ref: string, snapshot: string): Promise<LocatorObservation> {
  const identity = snapshotIdentity(snapshot, ref);
  const assessment = assessGeneratedLinkCollectionLocator(expression, linkName);
  if (!assessment.validatedForm || assessment.reasons.length) {
    return { matchCount: 0, observedTargetMatches: false, ...identity };
  }
  const generated = bindLocator(page, assessment.validatedForm);
  const count = await generated.count();
  const chosen = page.locator(`aria-ref=${ref}`);
  return {
    matchCount: count, observedTargetMatches: count > 0 && await generated.and(chosen).count() === 1,
    ...identity,
  };
}

function targetOf(step: AuthoredStep): string | undefined {
  if (step.type === 'assert_link_collection') return step.linkName;
  if ('target' in step) return step.target.description;
  if (step.type === 'wait_for' && 'target' in step.condition) return step.condition.target.description;
  return undefined;
}

function valueOf(value: DataValue): string {
  if (typeof value !== 'string') throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'DATA_REFERENCE_UNAVAILABLE_DURING_EXPLORATION');
  return value;
}

function authoredExecution(step: AuthoredStep, id: string, evidenceRef: string, locatorId?: string,
  locator?: AcceptedLocator | AcceptedLinkCollectionLocator): ExecutionStep {
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
  events?: LiveEventProducer,
): Promise<ResolutionOutcome> {
  const source = parseTestSpec(sourceInput);
  const stored = await store.readJob(source.testSpecId);
  if (JSON.stringify(stored.source) !== JSON.stringify(source)) throw new Error('Stored TestSpec differs from requested source');
  const expected = factory.catalog.resolve(source.executionProfileRef);
  assertEquivalentEffectiveProfile(stored.profile, expected);
  events?.registerOriginSteps(source.steps);
  const attemptId = `explore-${randomUUID()}`;
  events?.emit('exploration_started', {}, { explorationAttemptId: attemptId });
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
  let decisionOrdinal = 0;

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
    session = await McpExplorationSession.open(factory, source.executionProfileRef, expected, attemptId,
      ({ callId, tool, state }) => {
        const ids = { explorationAttemptId: attemptId, mcpCallId: callId };
        if (state === 'started') events?.emit('mcp_tool_started', { tool }, ids);
        else events?.emit('mcp_tool_finished', { tool, outcome: state === 'completed' ? 'completed' : 'failed' }, ids);
      });
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
      let locatorRejection: LocatorRejectionFeedback | undefined;
      while (true) {
        const snapshot = await session.snapshot();
        const ordinal = ++decisionOrdinal;
        const diagnosticStepId = `x${nextStep + 1}`;
        const snapshotDigest = createHash('sha256').update(snapshot).digest('hex');
        const diagnosticRetryMode = locatorRejection?.retryMode ?? 'none';
        const retryCodes = [...(locatorRejection?.reasons ?? [])];
        let rejectionCodes: LocatorQualityReason[] = [];
        let decisionKind: M7DecisionDiagnostic['decisionKind'] = 'none';
        let selectedReferenceRelation: M7DecisionDiagnostic['selectedReferenceRelation'] = 'absent';
        let validationCode: M7DecisionDiagnostic['validationCode'] = 'accepted';
        let resultCode: M7DecisionDiagnostic['resultCode'] = 'none';
        let resolverOutcome: M7DecisionDiagnostic['resolverOutcome'] = 'decision_failed';
        try {
        events?.emit('step_decision_started', {}, { explorationAttemptId: attemptId, originStepId: step.id });
        let decision: Awaited<ReturnType<ScriptedDecision>>;
        try { decision = await decide({
          step, snapshot, ...(previousFind ? { previousFind } : {}),
          prerequisites: prerequisiteCount, alternativeAttempt,
          ...(locatorRejection ? { locatorRejection } : {}),
          currentUrl: pageFor(session).url(),
          priorOutcomes: results.filter((item) => item.originStepId !== step.id)
            .map(({ originStepId, status }) => ({ originStepId, status })),
        }); } finally {
          events?.emit('step_decision_finished', {}, { explorationAttemptId: attemptId, originStepId: step.id });
        }
        decisionKind = decision.kind;
        if ('ref' in decision) selectedReferenceRelation = locatorRejection
          ? decision.ref === locatorRejection.selectedRef ? 'same' : 'different' : 'absent';
        if (decision.kind === 'unresolved') {
          resolverOutcome = 'unresolved';
          if (alternativeAttempt && locatorRejection) {
            throw new ResolutionFailure('LOCATOR_QUALITY_FAILED',
              locatorRejection.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED');
          }
          if (step.type === 'assert_link_collection' && decision.reason === 'TARGET_NOT_FOUND' &&
              await pageFor(session).getByRole('link', { name: step.linkName, exact: true }).count() === 0) {
            let locator: AcceptedLinkCollectionLocator;
            try { locator = acceptAbsentLinkCollectionLocator(step.linkName); }
            catch { throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', 'WEAK_IDENTITY'); }
            const id = `x${++nextStep}`;
            const locatorId = `loc${++nextLocator}`;
            activeExecution = id;
            activeLocator = locatorId;
            const ref = await evidence(step.id, id, locatorId, {
              instruction: step.sourceText, snapshot, decision, locatorOrigin: 'closedZeroMatch',
              observation: locator.observed, toolCalls: session.calls.slice(-2),
            });
            steps.push(authoredExecution(step, id, ref, locatorId, locator));
            results.push(result(source, attemptId, step.id, id, locatorId,
              'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
            resolverOutcome = 'closed_zero_match';
            resultCode = 'OPERATION_SUCCEEDED';
            break;
          }
          throw new ResolutionFailure('TARGET_RESOLUTION_FAILED', decision.reason);
        }
        if (decision.kind === 'find') {
          resolverOutcome = 'find';
          if (++findCount > maxFindsPerStep) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'FIND_LIMIT_EXCEEDED');
          previousFind = await session.find(decision.text);
          continue;
        }
        if (decision.kind === 'wait') {
          resolverOutcome = 'wait';
          if (++waitCount > maxWaitsPerStep) throw new ResolutionFailure('MCP_EXPLORATION_FAILED', 'WAIT_LIMIT_EXCEEDED');
          // The runner's targeted operation has its own bounded binding wait;
          // this exploration wait does not create hidden replay state.
          await session.waitForText(decision.text);
          continue;
        }
        ensureSnapshotRef(snapshot, decision.ref);
        if (alternativeAttempt && locatorRejection) {
          if (locatorRejection.retryMode === 'same_node_refinement') {
            if (decision.ref !== locatorRejection.selectedRef) {
              validationCode = 'REFINEMENT_REQUIRES_SAME_NODE';
              throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', 'REFINEMENT_REQUIRES_SAME_NODE');
            }
            if (!hasNewSemanticEvidence(snapshot, step, decision, locatorRejection)) {
              validationCode = 'REPEATED_CANDIDATE_NO_NEW_EVIDENCE';
              throw new ResolutionFailure('LOCATOR_QUALITY_FAILED',
                locatorRejection.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED');
            }
          } else if (decision.ref === locatorRejection.selectedRef) {
            validationCode = 'SELECTION_REQUIRES_DIFFERENT_NODE';
            throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', 'SELECTION_REQUIRES_DIFFERENT_NODE');
          }
        }
        const id = `x${++nextStep}`;
        const locatorId = `loc${++nextLocator}`;
        activeExecution = id;
        activeLocator = locatorId;
        const response = await session.generateLocator(decision.ref, decision.element);
        const expression = generatedExpression(response);
        const collection = step.type === 'assert_link_collection' && decision.kind === 'target';
        const observation = collection
          ? await inspectGeneratedLinkCollectionLocator(pageFor(session), expression, step.linkName, decision.ref, snapshot)
          : await inspectGeneratedLocator(pageFor(session), expression, decision.ref, snapshot);
        const assessment = collection
          ? assessGeneratedLinkCollectionLocator(expression, step.linkName, observation)
          : assessGeneratedLocator(expression, observation);
        if (assessment.status === 'rejected') rejectionCodes = [...assessment.reasons];
        let semanticProjection: Awaited<ReturnType<typeof semanticRowProjection>>;
        let roleNameProjection: AcceptedLocator | undefined;
        if (decision.kind === 'target' && assessment.status === 'rejected' &&
            assessment.reasons.length === 1 && assessment.reasons[0] === 'WEAK_IDENTITY' &&
            observation.matchCount === 1 && observation.observedTargetMatches === true) {
          try {
            roleNameProjection = await semanticRoleNameProjection(pageFor(session), step,
              snapshot, decision.ref, expression);
          } catch {
            // Failed derivation or live verification remains the original MCP quality rejection.
          }
        }
        const selectedIdentity = decision.kind === 'target' && step.type === 'click' &&
          step.target.scope?.length === 1 && step.target.scope[0]?.kind === 'row'
          ? snapshotIdentity(snapshot, decision.ref) : undefined;
        const selectedCellName = selectedIdentity && step.type === 'click' && step.target.scope?.[0]?.kind === 'row'
          ? cellNameFromScope(snapshot, step.target.scope[0].description) : undefined;
        let projectionFailure: ResolutionFailure | undefined = selectedIdentity && step.type === 'click' &&
          (selectedIdentity.role !== 'link' || !selectedIdentity.accessibleName ||
            !describesLink(step.target.description, selectedIdentity.accessibleName) ||
            !selectedCellName || !rowContainsSelectedLink(snapshot, selectedCellName,
              selectedIdentity.accessibleName, decision.ref))
          ? new ResolutionFailure('TARGET_RESOLUTION_FAILED', 'SCOPED_ROW_OR_LINK_NOT_UNIQUE_IN_SNAPSHOT') : undefined;
        if (!projectionFailure && decision.kind === 'target' && assessment.status === 'rejected' &&
            assessment.reasons.includes('UNSUPPORTED_GRAMMAR')) {
          try { semanticProjection = await semanticRowProjection(pageFor(session), step, snapshot, decision.ref, expression); }
          catch (error) {
            projectionFailure = error instanceof ResolutionFailure ? error
              : new ResolutionFailure('LOCATOR_QUALITY_FAILED', error instanceof Error ? error.message : String(error));
          }
        }
        const derivation = {
          instruction: step.sourceText, targetDescription: decision.element,
          snapshot, ...(previousFind ? { findResult: previousFind } : {}),
          selectedRef: decision.ref, generatedLocatorResponse: response, expression, observation, assessment,
          ...(roleNameProjection ? { semanticRoleNameProjection: {
            validatedForm: roleNameProjection.validatedForm, observed: roleNameProjection.observed,
            source: 'authoredTargetAndCurrentMcpSnapshot',
          } } : {}),
          ...(semanticProjection ? { semanticScope: { validatedForm: semanticProjection.locator.validatedForm,
            observation: semanticProjection.observation, source: 'authoredRowScopeAndCurrentMcpSnapshot' } } : {}),
          ...(projectionFailure ? { semanticScopeFailure: { status: projectionFailure.status, reason: projectionFailure.reason } } : {}),
          toolCalls: session.calls.slice(-3),
        };
        const ref = await evidence(step.id, id, locatorId, derivation);
        const locatorContext = { explorationAttemptId: attemptId, originStepId: step.id,
          executionStepId: id, locatorId };
        if (assessment.status === 'accepted' || assessment.status === 'rejected') {
          events?.emit('locator_assessed', { outcome: assessment.status, basis: 'mcp_generated',
            reasons: [...assessment.reasons] }, locatorContext);
        }
        if (semanticProjection) events?.emit('locator_assessed', {
          outcome: 'accepted', basis: 'semantic_row_scope', reasons: [],
        }, locatorContext);
        if (projectionFailure) throw projectionFailure;
        if (assessment.status !== 'accepted' && !semanticProjection && !roleNameProjection) {
          resolverOutcome = alternativeAttempt ? 'quality_failed' : 'quality_retry';
          resultCode = 'LOCATOR_QUALITY_FAILED';
          results.push(result(source, attemptId, step.id, id, locatorId, 'LOCATOR_QUALITY_FAILED', assessment.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED', [ref], stepStarted));
          if (!alternativeAttempt) {
            locatorRejection = {
              schemaVersion: '2', retryMode: retryMode(assessment, step, snapshot, decision.ref),
              selectedRef: decision.ref,
              targetDescription: decision.element,
              reasons: assessment.reasons,
              checks: assessment.checks,
            };
            alternativeAttempt = true;
            continue;
          }
          throw new ResolutionFailure('LOCATOR_QUALITY_FAILED', assessment.reasons.join(', ') || 'QUALITY_NOT_ACCEPTED', assessment);
        }
        if (decision.kind === 'prerequisite') {
          const locator = acceptGeneratedLocator(expression, observation);
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
          resolverOutcome = 'prerequisite_completed';
          resultCode = 'OPERATION_SUCCEEDED';
          previousFind = undefined;
          alternativeAttempt = false;
          locatorRejection = undefined;
          continue;
        }
        const locator = step.type === 'assert_link_collection'
          ? acceptGeneratedLinkCollectionLocator(expression, step.linkName, observation)
          : semanticProjection?.locator ?? roleNameProjection ?? acceptGeneratedLocator(expression, observation);
        const execution = authoredExecution(step, id, ref, locatorId, locator);
        steps.push(execution);
        if (step.type === 'click') await session.click(decision.ref, decision.element);
        else if (step.type === 'fill') await session.fill(decision.ref, decision.element, valueOf(step.value));
        else if (step.type === 'select_option') await session.select(decision.ref, decision.element, valueOf(step.value));
        results.push(result(source, attemptId, step.id, id, locatorId, 'OPERATION_SUCCEEDED', undefined, [ref], stepStarted));
        resolverOutcome = semanticProjection ? 'row_scope_projected'
          : roleNameProjection ? 'role_name_projected' : 'raw_accepted';
        resultCode = 'OPERATION_SUCCEEDED';
        break;
        } catch (error) {
          if (resolverOutcome === 'decision_failed' && decisionKind !== 'none') resolverOutcome = 'resolver_failed';
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code === 'MODEL_TIMEOUT' || code === 'MODEL_ERROR' || code === 'MODEL_OUTPUT_INVALID' ||
              code === 'REF_OUTSIDE_BOUNDED_CONTEXT' || code === 'DECISION_LIMIT_EXCEEDED' ||
              code === 'LOCATOR_REFINEMENT_CONTEXT_INVALID') validationCode = code;
          else if (validationCode === 'accepted') validationCode = 'RESOLVER_REJECTED';
          if (error instanceof ResolutionFailure) {
            if (error.status === 'TARGET_RESOLUTION_FAILED' || error.status === 'LOCATOR_GENERATION_FAILED' ||
                error.status === 'LOCATOR_QUALITY_FAILED' || error.status === 'MCP_EXPLORATION_FAILED') {
              resultCode = error.status;
            }
          } else resultCode = 'MCP_EXPLORATION_FAILED';
          throw error;
        } finally {
          await store.writeM7DecisionDiagnostic(source.testSpecId, {
            schemaVersion: '1', explorationAttemptId: attemptId, originStepId: step.id,
            executionStepId: diagnosticStepId, callOrdinal: ordinal, snapshotDigest,
            retryMode: diagnosticRetryMode, retryCodes, rejectionCodes, decisionKind,
            selectedReferenceRelation, validationCode, resultCode, resolverOutcome,
          });
        }
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
    if (!failure && session) await factory.pauseForObservation(session.browserSession).catch(() => undefined);
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
        schemaVersion: steps.some((step) => 'locator' in step && 'origin' in step.locator &&
          step.locator.origin === 'verifiedRoleNameProjection') ? SEMANTIC_ROLE_NAME_SCHEMA_VERSION
          : steps.some((step) => 'locator' in step && 'origin' in step.locator &&
            step.locator.origin === 'semanticRowScope') ? SEMANTIC_ROW_LOCATOR_SCHEMA_VERSION : source.schemaVersion,
        ...(steps.some((step) => 'locator' in step && 'origin' in step.locator &&
          (step.locator.origin === 'semanticRowScope' || step.locator.origin === 'verifiedRoleNameProjection'))
          ? { sourceSchemaVersion: source.schemaVersion } : {}),
        resolvedSpecId: `resolved-${randomUUID()}`,
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
  events?.emit('resolved_spec_ready', {}, { explorationAttemptId: attemptId,
    resolvedSpecId: resolved!.resolvedSpecId });
  const replay = async (ordinal: 1 | 2): Promise<ExecutionRun> => {
    const executionRunId = `run-${randomUUID()}`;
    const ids = { explorationAttemptId: attemptId, resolvedSpecId: resolved!.resolvedSpecId, executionRunId };
    events?.emit('replay_started', { ordinal }, ids);
    const run = await executeAndStoreRun(factory, store, source.testSpecId, resolved!.resolvedSpecId,
      executionRunId, evidencePolicy, { expectedProfile: expected });
    const automation = run.outcomes.find((record) => ![
      'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED', 'QA_ASSERTION_FAILED', 'NOT_RUN',
    ].includes(record.status));
    const qa = run.outcomes.find((record) => record.status === 'QA_ASSERTION_FAILED');
    const selected = automation ?? qa ?? [...run.outcomes].reverse().find((record) => record.status !== 'NOT_RUN');
    if (selected) events?.emit('replay_finished', { ordinal, status: selected.status }, ids);
    return run;
  };
  const first = await replay(1);
  const second = await replay(2);
  return { attemptId, status: 'resolved', resolved: resolved!, replay: [first, second] };
}
