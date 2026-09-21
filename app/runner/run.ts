import { randomUUID } from 'node:crypto';
import { errors, type Locator, type Page } from '@playwright/test';
import {
  parseResolvedTestSpec, parseResultRecord, parseTestSpec,
  type ExecutionStep, type ResolvedTestSpec, type ResultRecord, type TestSpec,
} from '../domain/index.js';
import { bindingResultFromObservation, type BindingResult } from '../locator/index.js';
import {
  type EffectiveProfile, type ProtectedBrowserSession, ProtectedContextFactory,
} from '../profile/index.js';
import { bindLocator, frameIdentity } from './locator.js';

export const RUNNER_VERSION = '1';

export interface DataValueProvider {
  resolve(reference: string): Promise<string>;
}

export interface RunnerOptions {
  executionRunId?: string;
  expectedProfile?: EffectiveProfile;
  dataValues?: DataValueProvider;
  observer?: RunObserver;
}

/** Optional observation only; it cannot influence operation selection or binding. */
export interface RunObserver {
  videoDir?: string;
  onStart?(session: ProtectedBrowserSession, page: Page, runId: string): Promise<void>;
  onStep?(page: Page, result: ResultRecord): Promise<readonly string[]>;
  onFinish?(page: Page, outcomes: readonly ResultRecord[]): Promise<readonly string[]>;
}

export interface ExecutionRun {
  executionRunId: string;
  effectiveProfile: EffectiveProfile;
  versions: ProtectedBrowserSession['versions'];
  outcomes: readonly ResultRecord[];
}

type Outcome = Pick<ResultRecord, 'status' | 'reason' | 'expected' | 'actual' | 'retryable'>;
const success = (status: 'OPERATION_SUCCEEDED' | 'QA_ASSERTION_PASSED'): Outcome => ({ status, retryable: false });
const failure = (status: 'LOCATOR_BINDING_FAILED' | 'BROWSER_EXECUTION_FAILED' | 'QA_ASSERTION_FAILED' | 'TEST_BUILD_FAILED', reason: string, expected?: string, actual?: string): Outcome => ({
  status, reason, retryable: false,
  ...(expected === undefined ? {} : { expected }),
  ...(actual === undefined ? {} : { actual }),
});

function urlMatches(actual: string, expected: string, mode: 'exact' | 'pattern'): boolean {
  if (mode === 'exact') return actual === new URL(expected).href;
  const prefix = new URL(expected.slice(0, -1));
  const current = new URL(actual);
  return current.origin === prefix.origin && current.pathname.startsWith(prefix.pathname);
}

async function navigate(page: Page, url: string, timeout: number): Promise<Outcome> {
  const response = await page.goto(url, { timeout });
  if (response?.status() === 403 && await response.text() === 'Network policy denied request') {
    return failure('BROWSER_EXECUTION_FAILED', 'NETWORK_POLICY_DENIED');
  }
  return success('OPERATION_SUCCEEDED');
}

function snapshotIdentityMatches(snapshot: unknown, observed: { role?: string | undefined; accessibleName?: string | undefined }): boolean {
  if (!observed.role && observed.accessibleName === undefined) return true;
  const root = Array.isArray(snapshot) ? snapshot[0] : snapshot;
  if (!root || typeof root !== 'object') return false;
  const node = root as Record<string, unknown>;
  return (observed.role === undefined || node.role === observed.role) &&
    (observed.accessibleName === undefined || node.name === observed.accessibleName);
}

async function inspectBinding(page: Page, step: Extract<ExecutionStep, { locatorId: string }>, timeoutMs: number): Promise<{ locator?: Locator; result: BindingResult }> {
  const deadline = Date.now() + timeoutMs;
  try {
    const frame = frameIdentity(page, step.locator.validatedForm);
    const locator = bindLocator(page, step.locator.validatedForm);
    while (true) {
      if (frame && await frame.count() !== 1) {
        if (Date.now() >= deadline) return { result: { reason: 'FRAME_RESOLUTION_FAILED' } };
      } else {
        const count = await locator.count();
        if (count > 1) return { result: bindingResultFromObservation(count) };
        if (count === 1) {
          const observed = step.locator.observed;
          // A hidden positive-assertion target has been bound; its failed
          // visibility is a QA result even if the accessibility tree omits it.
          const hiddenVisibilityTarget = (step.type === 'assert_visible' ||
            (step.type === 'wait_for' && step.condition.type === 'target_visible')) && !await locator.isVisible();
          const sameTarget = hiddenVisibilityTarget || (!observed.role && observed.accessibleName === undefined)
            ? true
            : snapshotIdentityMatches(await locator.ariaSnapshotJSON({ depth: 0, timeout: Math.max(250, timeoutMs) }), observed);
          return { locator, result: bindingResultFromObservation(1, sameTarget) };
        }
        if (Date.now() >= deadline) return { result: bindingResultFromObservation(0) };
      }
      await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  } catch {
    if (page.isClosed()) throw new Error('Browser page closed during locator binding');
    return { result: { reason: 'EVALUATION_FAILED' } };
  }
}

export function classifyBinding(step: ExecutionStep, binding: BindingResult): Outcome {
  const assertion = step.type === 'assert_visible' || step.type === 'assert_text' || step.type === 'assert_value';
  if (binding.reason === 'NO_MATCH' && assertion) return failure('QA_ASSERTION_FAILED', 'NO_MATCH');
  return failure('LOCATOR_BINDING_FAILED', binding.reason);
}

class DataReferenceUnavailable extends Error {}

async function dataValue(value: string | { kind: 'dataRef'; ref: string }, provider?: DataValueProvider): Promise<string> {
  if (typeof value === 'string') return value;
  if (!provider) throw new DataReferenceUnavailable();
  try { return await provider.resolve(value.ref); }
  catch { throw new DataReferenceUnavailable(); }
}

async function executeStep(page: Page, step: ExecutionStep, profile: EffectiveProfile, provider?: DataValueProvider): Promise<Outcome> {
  const { actionMs, navigationMs, waits } = profile.profile.timeoutPolicy;
  try {
    if (step.type === 'navigate') {
      return await navigate(page, step.url, navigationMs);
    }
    if (step.type === 'assert_url') {
      const actual = page.url();
      return urlMatches(actual, step.expectedUrl, step.match)
        ? success('QA_ASSERTION_PASSED')
        : failure('QA_ASSERTION_FAILED', 'URL_MISMATCH', step.expectedUrl, actual);
    }
    if (step.type === 'wait_for' && (step.condition.type === 'url_exact' || step.condition.type === 'url_pattern')) {
      const timeout = waits[step.timeoutPolicyRef];
      if (timeout === undefined) return failure('TEST_BUILD_FAILED', 'UNKNOWN_TIMEOUT_POLICY');
      const condition = step.condition;
      try {
        await page.waitForURL((url) => urlMatches(url.href, condition.type === 'url_exact' ? condition.url : condition.pattern, condition.type === 'url_exact' ? 'exact' : 'pattern'), { timeout });
        return success('OPERATION_SUCCEEDED');
      } catch (error) {
        return failure('BROWSER_EXECUTION_FAILED', error instanceof errors.TimeoutError ? 'WAIT_CONDITION_TIMEOUT' : 'OPERATION_ERROR');
      }
    }
    if (!('locatorId' in step)) return failure('TEST_BUILD_FAILED', 'TARGET_LOCATOR_MISSING');
    const waitTimeout = step.type === 'wait_for' ? waits[step.timeoutPolicyRef] : undefined;
    if (step.type === 'wait_for' && waitTimeout === undefined) return failure('TEST_BUILD_FAILED', 'UNKNOWN_TIMEOUT_POLICY');
    const waitStarted = Date.now();
    const { locator, result } = await inspectBinding(page, step, waitTimeout ?? actionMs);
    if (result.reason !== 'BOUND' || !locator) return classifyBinding(step, result);
    switch (step.type) {
      case 'click': await locator.click({ timeout: actionMs }); return success('OPERATION_SUCCEEDED');
      case 'fill': await locator.fill(await dataValue(step.value, provider), { timeout: actionMs }); return success('OPERATION_SUCCEEDED');
      case 'select_option': await locator.selectOption(await dataValue(step.value, provider), { timeout: actionMs }); return success('OPERATION_SUCCEEDED');
      case 'assert_visible': return await locator.isVisible() ? success('QA_ASSERTION_PASSED') : failure('QA_ASSERTION_FAILED', 'NOT_VISIBLE');
      case 'assert_text': {
        const actual = await locator.innerText({ timeout: actionMs });
        const matches = step.match === 'exact' ? actual === step.expectedText : actual.includes(step.expectedText);
        return matches ? success('QA_ASSERTION_PASSED') : failure('QA_ASSERTION_FAILED', 'TEXT_MISMATCH', step.expectedText, actual);
      }
      case 'assert_value': {
        const expected = await dataValue(step.expectedValue, provider);
        const actual = await locator.inputValue({ timeout: actionMs });
        return actual === expected ? success('QA_ASSERTION_PASSED') : failure('QA_ASSERTION_FAILED', 'VALUE_MISMATCH');
      }
      case 'wait_for': {
        const timeout = waitTimeout!;
        const deadline = waitStarted + timeout;
        const expected = step.condition.type === 'target_value' ? await dataValue(step.condition.expectedValue, provider) : undefined;
        while (Date.now() <= deadline) {
          const matched = step.condition.type === 'target_visible' ? await locator.isVisible() : await locator.inputValue({ timeout: Math.min(actionMs, timeout) }) === expected;
          if (matched) {
            const renewed = await inspectBinding(page, step, 0);
            return renewed.result.reason === 'BOUND' ? success('OPERATION_SUCCEEDED') : classifyBinding(step, renewed.result);
          }
          await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
        }
        return failure('BROWSER_EXECUTION_FAILED', 'WAIT_CONDITION_TIMEOUT');
      }
    }
  } catch (error) {
    if (error instanceof DataReferenceUnavailable) return failure('TEST_BUILD_FAILED', 'DATA_REFERENCE_UNAVAILABLE');
    if (page.isClosed()) return failure('BROWSER_EXECUTION_FAILED', 'PAGE_CLOSED');
    if ('locatorId' in step) {
      try {
        const rebound = await inspectBinding(page, step, 0);
        if (rebound.result.reason !== 'BOUND') return classifyBinding(step, rebound.result);
      } catch { return failure('BROWSER_EXECUTION_FAILED', 'PAGE_CLOSED'); }
    }
    return failure('BROWSER_EXECUTION_FAILED', 'OPERATION_ERROR');
  }
}

function resultRecord(source: TestSpec, resolved: ResolvedTestSpec, runId: string, startedAt: string, step: ExecutionStep | undefined, outcome: Outcome): ResultRecord {
  return parseResultRecord({
    phase: 'execution', ...outcome,
    testSpecId: source.testSpecId,
    resolvedSpecId: resolved.resolvedSpecId,
    explorationAttemptId: resolved.explorationAttemptId,
    executionRunId: runId,
    executionProfileRef: resolved.executionProfileRef,
    ...(step ? { originStepId: step.originStepId, executionStepId: step.id } : {}),
    ...(step && 'locatorId' in step ? { locatorId: step.locatorId } : {}),
    startedAt, finishedAt: new Date().toISOString(), evidenceRefs: [],
  });
}

/** Execute validated, accepted data. Each invocation owns and closes one protected browser session. */
export async function executeResolvedTestSpec(factory: ProtectedContextFactory, sourceInput: unknown, resolvedInput: unknown, options: RunnerOptions = {}): Promise<ExecutionRun> {
  const source = parseTestSpec(sourceInput);
  const resolved = parseResolvedTestSpec(resolvedInput, source);
  const runId = options.executionRunId ?? `run-${randomUUID()}`;
  const session = await factory.open(resolved.executionProfileRef, options.expectedProfile,
    options.observer?.videoDir ? { videoDir: options.observer.videoDir } : undefined);
  const outcomes: ResultRecord[] = [];
  try {
    const page = await session.context.newPage();
    await options.observer?.onStart?.(session, page, runId);
    const record = async (result: ResultRecord): Promise<void> => {
      const refs = await options.observer?.onStep?.(page, result) ?? [];
      outcomes.push(refs.length ? parseResultRecord({ ...result, evidenceRefs: [...result.evidenceRefs, ...refs] }) : result);
    };
    let blocked = false;
    if (source.startState.url !== 'about:blank') {
      const started = new Date().toISOString();
      let start: Outcome;
      try {
        start = await navigate(page, source.startState.url, session.effectiveProfile.profile.timeoutPolicy.navigationMs);
      }
      catch { start = failure('BROWSER_EXECUTION_FAILED', 'START_STATE_FAILED'); }
      if (start.status !== 'OPERATION_SUCCEEDED') {
        await record(resultRecord(source, resolved, runId, started, undefined, start));
        blocked = true;
      }
    }
    for (const step of resolved.executionSteps) {
      const started = new Date().toISOString();
      const outcome = blocked ? { status: 'NOT_RUN', reason: 'DEPENDENCY_FAILED', retryable: false } as const
        : await executeStep(page, step, session.effectiveProfile, options.dataValues);
      await record(resultRecord(source, resolved, runId, started, step, outcome));
      if (outcome.status !== 'OPERATION_SUCCEEDED' && outcome.status !== 'QA_ASSERTION_PASSED') blocked = true;
    }
    const finalRefs = await options.observer?.onFinish?.(page, outcomes) ?? [];
    if (finalRefs.length && outcomes.length) {
      let index = outcomes.length - 1;
      while (index > 0 && outcomes[index]?.status === 'NOT_RUN') index -= 1;
      const target = index >= 0 ? index : outcomes.length - 1;
      const result = outcomes[target]!;
      outcomes[target] = parseResultRecord({ ...result, evidenceRefs: [...result.evidenceRefs, ...finalRefs] });
    }
    return { executionRunId: runId, effectiveProfile: session.effectiveProfile, versions: session.versions, outcomes };
  } finally {
    await session.close();
  }
}

/** Repeat from two independent protected contexts under one effective profile. */
export async function replayTwice(factory: ProtectedContextFactory, source: unknown, resolved: unknown, options: Omit<RunnerOptions, 'executionRunId' | 'expectedProfile'> = {}): Promise<readonly [ExecutionRun, ExecutionRun]> {
  const first = await executeResolvedTestSpec(factory, source, resolved, options);
  const second = await executeResolvedTestSpec(factory, source, resolved, { ...options, expectedProfile: first.effectiveProfile });
  return [first, second];
}
