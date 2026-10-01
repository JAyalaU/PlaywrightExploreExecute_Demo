import { createHash, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  assertionFromStrategyV1, parseCompilerAttemptV2, parseResolvedTestSpecV7,
  type CompilerAttemptV2, type CompiledExecutionStepV1, type CompiledLocatorV1,
  type DeterministicVerificationAssertionV1, type ResolvedTestSpecV7,
  type SuccessfulExplorationTraceV3, type SuccessfulVerificationRecordV3,
  type TrustedObservationResultV1, type TestSpec, type LocatorForm,
} from '../domain/index.js';
import { LocalArtifactStore } from '../evidence/index.js';
import { assertEquivalentEffectiveProfile, ProtectedContextFactory } from '../profile/index.js';
import { bindLocator } from '../runner/locator.js';
import { RUNNER_VERSION } from '../runner/index.js';
import { CurrentStateExploration } from './current-state.js';
import { MCP_VERSION, McpExplorationSession } from './mcp.js';
import { TrustedObservationSessionV1 } from './trusted-observation.js';
import { authoredIdentity, bindInFrame, formFor, targeted, untargeted,
  verifiedFrame, waitForRecordedCondition } from './trace-compiler.js';

type Reason = Extract<CompilerAttemptV2['result'], { status: 'rejected' }>['reasonCode'];
type CheckKind = CompilerAttemptV2['checks'][number]['kind'];
type TraceRecord = SuccessfulExplorationTraceV3['successfulPath'][number];
type ActionRecord = Exclude<TraceRecord, { type: 'verification_goal' }>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class CompilerStop extends Error {
  constructor(readonly reason: Reason, readonly record: TraceRecord,
    readonly kind: CheckKind) { super(reason); }
}

export type GoalDirectedCompilationResult =
  | { kind: 'compiled'; compiler: CompilerAttemptV2; resolved: ResolvedTestSpecV7; cleanup: 'verified' }
  | { kind: 'compilation_unsupported' | 'compilation_stop'; compiler: CompilerAttemptV2;
      reason: Reason; cleanup: 'verified' };

export class GoalDirectedCompilationEnvironmentError extends Error {
  constructor(readonly cleanup: 'verified' | 'unverified', cause?: unknown) {
    super('Fresh protected v3 compiler context was unavailable', { cause });
  }
}

function freshEvaluation(assertion: DeterministicVerificationAssertionV1,
  observation: TrustedObservationResultV1): boolean | undefined {
  if (observation.status !== 'complete') return undefined;
  const result = observation.result;
  if (assertion.kind === 'semantic_count' && result.kind === 'matches') {
    const count = result.count;
    if (assertion.operator === 'equal') return count === assertion.expected;
    if (assertion.operator === 'greater_than') return count > assertion.expected;
    if (assertion.operator === 'at_least') return count >= assertion.expected;
    return count <= assertion.expected;
  }
  if (assertion.kind === 'unique_boolean_property' && result.kind === 'property' &&
      result.property === assertion.property && typeof result.value === 'boolean')
    return result.value === assertion.expected;
  if (assertion.kind === 'unique_string_property' && result.kind === 'property' &&
      result.property === assertion.property && typeof result.value === 'string')
    return assertion.operator === 'equal' ? result.value === assertion.expected :
      result.value.includes(assertion.expected);
  if (assertion.kind === 'url' && result.kind === 'url') {
    if (assertion.operator === 'equal') return result.value === new URL(assertion.expected).href;
    const prefix = new URL(assertion.expected.slice(0, -1));
    const url = new URL(result.value);
    return url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname);
  }
  return undefined;
}

function observationRequest(assertion: DeterministicVerificationAssertionV1) {
  if (assertion.kind === 'semantic_count') return { kind: 'semantic_query' as const, query: assertion.query };
  if (assertion.kind === 'url') return { kind: 'current_url' as const };
  return { kind: 'target_property' as const, query: assertion.query, property: assertion.property };
}

/** Exact authored role/name form with punctuation in a human-readable name. */
function authoredActionIdentityV3(source: TestSpec, record: ActionRecord,
  binding: SuccessfulExplorationTraceV3['bindings'][number], form: LocatorForm): boolean {
  if (authoredIdentity(source, record, binding, form)) return true;
  const step = source.steps.find((item) => item.id === record.originStepId);
  const description = step && 'target' in step ? step.target.description : undefined;
  if (!step || !description || binding.selectedNode.role !== 'link' &&
      binding.selectedNode.role !== 'button') return false;
  const canonical = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  const role = binding.selectedNode.role;
  const name = binding.selectedNode.accessibleName;
  if (!name || /\b(?:or|either|another|one of)\b/i.test(description)) return false;
  if (form.type !== 'role' || form.role !== role || form.name !== name || form.exact !== true)
    return false;
  if ([ `${name} ${role}`, `the ${name} ${role}`, `${role} ${name}` ]
    .some((phrase) => canonical(description) === canonical(phrase))) return true;
  // The interpreter may preserve the authored locator sentence while phrasing
  // its structured target as a role plus exact accessible name. Require both
  // to identify the same literal target before accepting that projection.
  return canonical(description) === canonical(`${role} with accessible name "${name}"`) &&
    [ `Locate the ${role} that says ${name} and click it.`,
      `Click the "${name}" ${role}.`, `Click the ${name} ${role}.` ]
      .some((clause) => canonical(step.sourceText) === canonical(clause));
}

/** Private v3 consumer. It never invokes a runner or creates a QA result. */
export async function compileSuccessfulTraceV3(factory: ProtectedContextFactory,
  store: LocalArtifactStore, testSpecId: string, attemptId: string,
): Promise<GoalDirectedCompilationResult> {
  const { source, profile } = await store.readJob(testSpecId);
  const { attempt, trace } = await store.readSuccessfulExplorationV3(testSpecId, attemptId);
  if (source.schemaVersion !== '4') throw new Error('V3 compiler requires TestSpec v4');
  const startedAt = new Date(Math.max(Date.now(), Date.parse(trace.finishedAt))).toISOString();
  const compilerAttemptId = id('compiler');
  const resolvedSpecId = id('resolved');
  const checks: CompilerAttemptV2['checks'] = [];
  const steps: ResolvedTestSpecV7['executionSteps'] = [];
  const strategyLinks: CompilerAttemptV2['strategyLinks'] = trace.successfulPath.flatMap((record) =>
    record.type === 'verification_goal' ? [{ traceRecordId: record.recordId,
      goalStepId: record.goalStepId, strategyDigest: record.strategyDigest,
      observationIds: record.observationIds }] : []);
  const first = trace.successfulPath[0]!;
  let activeRecord: TraceRecord = first;
  const mark = (record: TraceRecord, kind: CheckKind, passed: boolean,
    reason: Reason, candidateDigest?: string) => {
    checks.push({ checkId: id('check'), traceRecordId: record.recordId, kind,
      result: passed ? 'passed' : 'failed', reasonCode: passed ? 'NONE' : reason,
      ...(candidateDigest ? { candidateDigest } : {}) });
    if (!passed) throw new CompilerStop(reason, record, kind);
  };
  const owner = { testSpecId: source.testSpecId, explorationAttemptId: attempt.explorationAttemptId,
    successfulTraceId: trace.successfulTraceId, executionProfileRef: source.executionProfileRef,
    profileFingerprint: trace.profileFingerprint };
  let session: McpExplorationSession | undefined;
  let freshSessionId: string | undefined;
  let stopped: CompilerStop | undefined;
  let unexpected: unknown;
  try {
    session = await McpExplorationSession.open(factory, source.executionProfileRef, profile);
    assertEquivalentEffectiveProfile(profile, session.browserSession.effectiveProfile);
    const current = new CurrentStateExploration(session, source, compilerAttemptId);
    freshSessionId = current.sessionId;
    mark(first, 'profile_equivalence', profile.fingerprint === trace.profileFingerprint &&
      same(source.executionProfileRef, trace.executionProfileRef), 'PROFILE_MISMATCH');
    const observations = new TrustedObservationSessionV1(session, current);
    if (source.startState.url !== 'about:blank') await session.navigate(source.startState.url);
    else await session.snapshot();
    const pages = session.browserSession.context.pages();
    if (pages.length !== 1) throw new Error('Fresh compiler requires one protected page');
    const page = pages[0]!;

    for (const record of trace.successfulPath) {
      activeRecord = record;
      if (record.type === 'verification_goal') {
        const projection = assertionFromStrategyV1(record);
        if (!projection) {
          const reason = record.comparison.kind === 'transition' ?
            'UNSUPPORTED_TEMPORAL_REPLAY' : 'UNSUPPORTED_REPRESENTATION';
          mark(record, 'deterministic_representation', false, reason);
        }
        const request = observationRequest(projection!);
        const sourceObservation = record.observations.find((item) => item.observationId ===
          (record.comparison.kind === 'transition' ? record.comparison.laterObservationId :
            record.comparison.observationId));
        mark(record, 'strategy_correspondence', !!sourceObservation &&
          same(sourceObservation.request, request), 'OBSERVATION_MISMATCH');
        const fresh = await observations.observe(request);
        if (fresh.status === 'error') {
          const reason: Reason = fresh.reason === 'INVALID_SCOPE' ? 'UNPROVEN_IDENTITY' :
            fresh.reason === 'NON_UNIQUE' ? 'NON_UNIQUE_MATCH' :
            fresh.reason === 'NO_MATCH' ? 'TARGET_MISMATCH' :
            fresh.reason === 'BROWSER_FAILURE' ? 'ENVIRONMENT_FAILURE' : 'OBSERVATION_MISMATCH';
          mark(record, 'fresh_observation', false, reason);
        }
        const currentFact = await observations.currentEvidence(fresh);
        mark(record, 'fresh_observation', !!currentFact && fresh.status === 'complete' &&
          fresh.result.kind !== 'snapshot', 'OBSERVATION_MISMATCH');
        const evaluated = freshEvaluation(projection!, fresh);
        mark(record, 'strategy_correspondence', evaluated === record.evaluated,
          'POSTCONDITION_MISMATCH');
        mark(record, 'deterministic_representation', true, 'UNSUPPORTED_REPRESENTATION', hash(projection));
        const executionId = id('x');
        const link = strategyLinks.find((item) => item.traceRecordId === record.recordId)!;
        link.assertionStepId = executionId;
        steps.push({ id: executionId, traceRecordId: record.recordId,
          originStepId: record.originStepId, source: 'authored',
          type: 'verification_goal', goalStepId: record.goalStepId, assertion: projection! });
      } else {
        const step = await reconstructAction(source, trace, record, page, session, profile.profile.timeoutPolicy.waits,
          mark);
        steps.push(step);
      }
      mark(record, 'ordered_postcondition', true, 'POSTCONDITION_MISMATCH');
    }
  } catch (error) {
    if (error instanceof CompilerStop) stopped = error;
    else unexpected = error;
  } finally {
    if (session) {
      try { await session.close(); }
      catch (error) { throw new GoalDirectedCompilationEnvironmentError('unverified', error); }
    }
  }
  if (!freshSessionId)
    throw new GoalDirectedCompilationEnvironmentError('verified', unexpected ?? stopped);
  if (unexpected) {
    // Browser/session failures are non-QA. Keep an authenticated failed check.
    checks.push({ checkId: id('check'), traceRecordId: activeRecord.recordId,
      kind: 'fresh_observation', result: 'failed', reasonCode: 'ENVIRONMENT_FAILURE' });
    stopped = new CompilerStop('ENVIRONMENT_FAILURE', activeRecord, 'fresh_observation');
  }
  const finishedAt = new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
  if (stopped) {
    const compiler = parseCompilerAttemptV2({ compilerVersion: '2', compilerAttemptId,
      ...owner, startedAt, finishedAt, freshSessionId,
      strategyLinks: strategyLinks.map(({ assertionStepId: _unused, ...link }) => link),
      checks, result: { status: 'rejected', reasonCode: stopped.reason,
        failedTraceRecordId: stopped.record.recordId } }, source, attempt, trace,
    // Readback supplies the protected capture, and the store revalidates before write.
    await store.readSuccessfulExplorationV3Proof(testSpecId, attemptId));
    await store.writeCompilerAttemptV2(compiler);
    return { kind: stopped.reason.startsWith('UNSUPPORTED_') ? 'compilation_unsupported' :
      'compilation_stop', compiler, reason: stopped.reason, cleanup: 'verified' };
  }
  const compiler = parseCompilerAttemptV2({ compilerVersion: '2', compilerAttemptId,
    ...owner, startedAt, finishedAt, freshSessionId, strategyLinks, checks,
    result: { status: 'accepted', resolvedSpecId } }, source, attempt, trace,
  await store.readSuccessfulExplorationV3Proof(testSpecId, attemptId));
  const resolved = parseResolvedTestSpecV7({ schemaVersion: '7', sourceSchemaVersion: '4',
    resolvedSpecId, ...owner, compilerAttemptId,
    runtimeVersions: { playwright: session!.browserSession.versions.playwright,
      mcp: MCP_VERSION, runner: RUNNER_VERSION, compiler: '2' }, executionSteps: steps },
  source, attempt, trace, await store.readSuccessfulExplorationV3Proof(testSpecId, attemptId), compiler);
  await store.writeCompiledExplorationV7({ compiler, resolved });
  return { kind: 'compiled', compiler, resolved, cleanup: 'verified' };
}

async function reconstructAction(source: TestSpec, trace: SuccessfulExplorationTraceV3, record: ActionRecord,
  page: Page, session: McpExplorationSession, waits: Record<string, number>,
  mark: (record: TraceRecord, kind: CheckKind, passed: boolean, reason: Reason,
    digest?: string) => void): Promise<CompiledExecutionStepV1> {
  if (!('bindingId' in record) || !record.bindingId) {
    const step = untargeted(record);
    mark(record, 'closed_form', !!step, 'UNSUPPORTED_REPRESENTATION');
    if (record.type === 'navigate') {
      await session.navigate(record.url);
      mark(record, 'ordered_postcondition', page.url() === new URL(record.url).href,
        'POSTCONDITION_MISMATCH');
    } else if (record.type === 'assert_url') {
      const actual = record.match === 'exact' ? page.url() === new URL(record.expectedUrl).href :
        page.url().startsWith(new URL(record.expectedUrl.slice(0, -1)).href);
      mark(record, 'ordered_postcondition', actual === (record.result === 'passed'),
        'POSTCONDITION_MISMATCH');
    } else if (record.type === 'assert_link_collection') {
      const links = page.getByRole('link', { name: record.linkName, exact: true });
      const count = await links.count();
      const hrefs: string[] = [];
      for (let index = 0; index < count && index <= 10_000; index++) {
        const href = await links.nth(index).getAttribute('href');
        hrefs.push(href ? new URL(href, page.url()).href : '');
      }
      const actual = count === record.expectedCount && count <= 10_000 &&
        hrefs.every((href) => href === record.expectedHref);
      mark(record, 'ordered_postcondition', actual === (record.result === 'passed'),
        'POSTCONDITION_MISMATCH');
    } else if (record.type === 'wait_for' || record.type === 'state_observed') {
      const condition = record.condition;
      mark(record, 'ordered_postcondition', await waitForRecordedCondition(page, undefined,
        condition, waits[record.timeoutPolicyRef] ?? 0), 'POSTCONDITION_MISMATCH');
    }
    return step!;
  }
  const binding = trace.bindings.find((item) => item.bindingId === record.bindingId);
  mark(record, 'durable_identity', !!binding && binding.frameOwnership.kind !== 'unproven',
    'UNPROVEN_IDENTITY');
  const frame = await verifiedFrame(page, binding!.frameOwnership);
  mark(record, 'durable_identity', !!frame, 'UNPROVEN_IDENTITY');
  const snapshot = frame === page.mainFrame() ? await session.snapshot() :
    await frame!.locator('body').ariaSnapshot();
  const form = formFor(source, record, binding!, snapshot);
  const framePath = binding!.frameOwnership.kind === 'nested' ?
    binding!.frameOwnership.anchors.map((anchor) => anchor.identity) : undefined;
  const formDigest = form && hash(framePath ? { form, framePath } : form);
  mark(record, 'closed_form', !!form && form.type !== 'frame', 'UNSUPPORTED_REPRESENTATION', formDigest);
  const closedForm = form as Exclude<LocatorForm, { type: 'frame' }>;
  const locator = frame === page.mainFrame() ? bindLocator(page, closedForm) : bindInFrame(frame!, closedForm);
  const count = await locator.count();
  mark(record, 'unique_match', count === 1,
    count === 0 ? 'TARGET_MISMATCH' : 'NON_UNIQUE_MATCH', formDigest);
  let corresponds = form!.type === 'role' && form!.role === binding!.selectedNode.role &&
    form!.name === binding!.selectedNode.accessibleName ||
    form!.type === 'within' && form!.target.type === 'role' &&
    form!.target.role === binding!.selectedNode.role &&
    form!.target.name === binding!.selectedNode.accessibleName;
  if (corresponds && binding!.selectedNode.destination) {
    const href = await locator.getAttribute('href');
    corresponds = !!href && new URL(href, page.url()).href === binding!.selectedNode.destination;
  }
  mark(record, 'selected_target', corresponds, 'TARGET_MISMATCH', formDigest);
  mark(record, 'durable_identity', authoredActionIdentityV3(source, record, binding!, form!),
    'UNPROVEN_IDENTITY', formDigest);
  const compiledLocator: CompiledLocatorV1 = { origin: 'verifiedTraceCompilation',
    validatedForm: form!, ...(framePath ? { framePath } : {}),
    observed: { role: binding!.selectedNode.role,
      accessibleName: binding!.selectedNode.accessibleName, matchCount: 1,
      selectedTargetMatches: true },
    quality: { status: 'accepted', identityBasis: form!.type === 'within' || framePath ?
      'scoped-role-and-accessible-name' : 'role-and-accessible-name' } };
  const step = record.type === 'state_observed' ? {
    id: id('x'), traceRecordId: record.recordId, originStepId: record.originStepId,
    source: record.source, ...(record.prerequisiteReasonCode ?
      { prerequisiteReasonCode: record.prerequisiteReasonCode } : {}),
    type: 'wait_for' as const, condition: record.condition,
    timeoutPolicyRef: record.timeoutPolicyRef, locatorId: id('locator'), locator: compiledLocator,
  } : targeted(record as Parameters<typeof targeted>[0], compiledLocator);
  const beforeUrl = page.url();
  const before = snapshot;
  if (record.type === 'click') await locator.click();
  else if (record.type === 'fill' && typeof record.value === 'string') await locator.fill(record.value);
  else if (record.type === 'select_option' && typeof record.value === 'string')
    await locator.selectOption(record.value);
  else if (record.type === 'fill' || record.type === 'select_option')
    mark(record, 'closed_form', false, 'UNSUPPORTED_REPRESENTATION');
  else if (record.type === 'assert_visible')
    mark(record, 'ordered_postcondition', await locator.isVisible() === (record.result === 'passed'),
      'POSTCONDITION_MISMATCH');
  else if (record.type === 'assert_text') {
    const value = await locator.innerText();
    const satisfied = record.match === 'exact' ? value === record.expectedText : value.includes(record.expectedText);
    mark(record, 'ordered_postcondition', satisfied === (record.result === 'passed'), 'POSTCONDITION_MISMATCH');
  } else if (record.type === 'assert_value' && typeof record.expectedValue === 'string')
    mark(record, 'ordered_postcondition', await locator.inputValue() === record.expectedValue,
      'POSTCONDITION_MISMATCH');
  else if (record.type === 'wait_for' || record.type === 'state_observed')
    mark(record, 'ordered_postcondition', await waitForRecordedCondition(page, locator,
      record.condition, waits[record.timeoutPolicyRef] ?? 0), 'POSTCONDITION_MISMATCH');
  if (record.type === 'click' || record.type === 'fill' || record.type === 'select_option') {
    const after = frame === page.mainFrame() ? await session.snapshot() :
      await frame!.locator('body').ariaSnapshot();
    mark(record, 'ordered_postcondition', (hash({ url: beforeUrl, snapshot: before }) !==
      hash({ url: page.url(), snapshot: after })) === (record.observedEffect === 'state_changed'),
    'POSTCONDITION_MISMATCH');
    if (record.type === 'click' && binding!.selectedNode.destination)
      mark(record, 'ordered_postcondition', page.url() === binding!.selectedNode.destination,
        'POSTCONDITION_MISMATCH');
  }
  return step;
}
