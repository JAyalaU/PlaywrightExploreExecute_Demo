import { createHash, randomUUID } from 'node:crypto';
import type { Frame, Locator, Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CompiledExecutionStepV1Schema, parseCompilerAttemptV1, parseResolvedTestSpecV6,
  parseSuccessfulExplorationTraceV1, parseSuccessfulExplorationTraceV2, parseTestSpec, type CompilerAttemptV1,
  type CompilerCheckV1, type CompiledExecutionStepV1, type CompiledLocatorV1,
  type ExplorationAttemptV3, type ExplorationTargetBindingV1, type LocatorForm,
  type ResolvedTestSpecV6, type SuccessfulExplorationTraceV2, type SuccessfulPathRecordV1,
  type SuccessfulPathRecordV2, type TraceBindingV2, type FrameOwnershipV2,
  type TestSpec,
} from '../domain/index.js';
import { LocalArtifactStore } from '../evidence/index.js';
import { parseAuthoredRoleNameIdentity, reviewAuthoredRoleNameIdentity } from '../locator/index.js';
import { type EffectiveProfile, ProtectedContextFactory, assertEquivalentEffectiveProfile } from '../profile/index.js';
import { bindLocator } from '../runner/locator.js';
import { RUNNER_VERSION } from '../runner/index.js';
import { MCP_VERSION, McpExplorationSession } from './mcp.js';

const digest = (value: unknown): string => createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const id = (prefix: string): string => `${prefix}-${randomUUID()}`;

export class TraceCompilationEnvironmentError extends Error {
  constructor(readonly cleanup: 'verified' | 'unverified', cause?: unknown) {
    super('Fresh protected compiler verification was unavailable', { cause });
    this.name = 'TraceCompilationEnvironmentError';
  }
}

type Reason = Exclude<CompilerAttemptV1['result'], { status: 'accepted' }>['reasonCode'];
type CheckKind = CompilerCheckV1['kind'];
type CheckReason = CompilerCheckV1['reasonCode'];
type TraceRecord = SuccessfulPathRecordV1 | SuccessfulPathRecordV2;
type TargetRecord = Extract<SuccessfulPathRecordV1, { bindingId: string }> |
  Extract<SuccessfulPathRecordV1, { type: 'wait_for' }>;

export type TraceCompilationResult =
  | { kind: 'compiled'; compiler: CompilerAttemptV1; resolved: ResolvedTestSpecV6; cleanup: 'verified' }
  | { kind: 'compilation_stop'; compiler: CompilerAttemptV1; reason: Reason; cleanup: 'verified' };

interface CompilerVerificationSession {
  readonly page: Page;
  readonly effectiveProfile: EffectiveProfile;
  readonly playwrightVersion: string;
  navigate(url: string): Promise<void>;
  snapshot(): Promise<string>;
  close(): Promise<void>;
}

async function openProtected(factory: ProtectedContextFactory, source: TestSpec,
  expected: EffectiveProfile): Promise<CompilerVerificationSession> {
  const session = await McpExplorationSession.open(factory, source.executionProfileRef, expected);
  try {
    if (source.startState.url !== 'about:blank') await session.navigate(source.startState.url);
    else await session.snapshot();
    const pages = session.browserSession.context.pages();
    if (pages.length !== 1) throw new Error('Compiler requires exactly one protected page');
    return {
      page: pages[0]!, effectiveProfile: session.browserSession.effectiveProfile,
      playwrightVersion: session.browserSession.versions.playwright,
      navigate: async (url) => { await session.navigate(url); },
      snapshot: () => session.snapshot(), close: () => session.close(),
    };
  } catch (error) { await session.close(); throw error; }
}

interface SnapshotNode { ref: string; role: string; name: string; line: number; indentation: number;
  destination?: string; }

function nodes(snapshot: string, pageUrl: string): SnapshotNode[] {
  const lines = snapshot.split('\n');
  const result: SnapshotNode[] = [];
  for (const [index, line] of lines.entries()) {
    const found = /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?(?:\s+\[[^\]]+\])*\s+\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line);
    if (!found) continue;
    const next = lines[index + 1];
    const href = next && /^\s+-\s+\/url:\s+(\S+)/.exec(next)?.[1];
    let destination: string | undefined;
    if (href) {
      try { destination = new URL(href, pageUrl).href; } catch { /* no trusted URL fact */ }
    }
    result.push({ ref: found[4]!, role: found[2]!, name: found[3] ?? '',
      line: index, indentation: found[1]!.length, ...(destination ? { destination } : {}) });
  }
  return result;
}

function exactPhrase(text: string, value: string): boolean {
  if (!value || value.length > 512) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(text);
}

export function authoredIdentity(source: TestSpec, record: TraceRecord,
  selected: ExplorationTargetBindingV1, form: LocatorForm): boolean {
  const step = source.steps.find((entry) => entry.id === record.originStepId);
  if (!step) return false;
  const target = step.type === 'wait_for' && 'target' in step.condition ? step.condition.target :
    'target' in step ? step.target : undefined;
  if (!target) return false;
  const { role, accessibleName: name } = selected.selectedNode;
  if (!name) return false;
  if (record.source === 'discoveredPrerequisite' && record.type !== 'state_observed') {
    // A prerequisite cannot become durable from an incidental name overlap.
    // Its role/name must also be explicitly stated in authored step context.
    const phrase = step.sourceText.toLocaleLowerCase('en-US');
    return selected.justificationCode === 'discovered_prerequisite' &&
      exactPhrase(phrase, `${name} ${role}`) && !/\b(?:or|either|another|one of)\b/i.test(phrase);
  }
  const explicit = parseAuthoredRoleNameIdentity(target.description);
  if (!explicit) return false;
  if (target.scope?.length) return explicit.role === role && explicit.name === name;
  return reviewAuthoredRoleNameIdentity(target, form, {
    role, accessibleName: name, matchCount: 1, observedTargetMatches: true,
  }) !== null;
}

function rowCell(snapshot: string, description: string): string | undefined {
  const names = new Set<string>();
  for (const line of snapshot.split('\n')) {
    const match = /^\s+-\s+cell "([^"]+)"/.exec(line);
    if (match?.[1] && exactPhrase(description, match[1])) names.add(match[1]);
  }
  return names.size === 1 ? [...names][0] : undefined;
}

function inRow(snapshot: string, node: SnapshotNode, cellName: string): boolean {
  const lines = snapshot.split('\n');
  for (let index = node.line - 1; index >= 0; index--) {
    const row = /^(\s*)-\s+row(?:\s|$)/.exec(lines[index]!);
    if (!row || row[1]!.length >= node.indentation) continue;
    for (let child = index + 1; child < lines.length; child++) {
      if (/^\s*/.exec(lines[child]!)![0].length <= row[1]!.length) break;
      if (new RegExp(`^\\s+-\\s+cell "${cellName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"(?:\\s|$)`).test(lines[child]!))
        return true;
    }
    return false;
  }
  return false;
}

export function formFor(source: TestSpec, record: TraceRecord,
  binding: ExplorationTargetBindingV1, snapshot: string): LocatorForm | undefined {
  const step = source.steps.find((entry) => entry.id === record.originStepId)!;
  const target = step.type === 'wait_for' && 'target' in step.condition ? step.condition.target :
    'target' in step ? step.target : undefined;
  const { role, accessibleName } = binding.selectedNode;
  if (!accessibleName) return undefined;
  const leaf = { type: 'role' as const, role, name: accessibleName, exact: true as const };
  if (!target?.scope?.length) return leaf;
  // An old opaque frameId cannot prove a fresh frame's identity. The v1
  // binding stores no durable frame title/test-id; refuse frame projections.
  if (target.scope.length !== 1 || target.scope[0]?.kind !== 'row') return undefined;
  const cellName = rowCell(snapshot, target.scope[0].description);
  return cellName ? { type: 'within', scope: { type: 'rowWithCell', cellName }, target: leaf } : undefined;
}

function matchesExpected(actual: string, expected: string, mode: 'exact' | 'pattern'): boolean {
  if (mode === 'exact') return actual === new URL(expected).href;
  const prefix = new URL(expected.slice(0, -1));
  const url = new URL(actual);
  return url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname);
}

function check(record: TraceRecord, kind: CheckKind, passed: boolean,
  reasonCode: CheckReason, extras: Partial<CompilerCheckV1> = {}): CompilerCheckV1 {
  return { checkId: id('check'), traceRecordId: record.recordId, kind,
    result: passed ? 'passed' : 'failed', reasonCode: passed ? 'NONE' : reasonCode,
    ...extras } as CompilerCheckV1;
}

function compiledBase(record: TraceRecord) {
  return { id: id('x'), traceRecordId: record.recordId, originStepId: record.originStepId,
    source: record.source, ...(record.prerequisiteReasonCode ?
      { prerequisiteReasonCode: record.prerequisiteReasonCode } : {}) };
}

export function targeted(record: TargetRecord, locator: CompiledLocatorV1): CompiledExecutionStepV1 {
  const base = { ...compiledBase(record), locatorId: id('locator'), locator };
  switch (record.type) {
    case 'click': return { ...base, type: 'click' };
    case 'fill': return { ...base, type: 'fill', value: record.value };
    case 'select_option': return { ...base, type: 'select_option', value: record.value };
    case 'assert_visible': return { ...base, type: 'assert_visible' };
    case 'assert_text': return { ...base, type: 'assert_text', expectedText: record.expectedText, match: record.match };
    case 'assert_value': return { ...base, type: 'assert_value', expectedValue: record.expectedValue };
    case 'wait_for': return { ...base, type: 'wait_for', condition: record.condition,
      timeoutPolicyRef: record.timeoutPolicyRef };
  }
}

export function untargeted(record: TraceRecord): CompiledExecutionStepV1 | undefined {
  const base = compiledBase(record);
  switch (record.type) {
    case 'navigate': return { ...base, type: 'navigate', url: record.url };
    case 'assert_url': return { ...base, type: 'assert_url', expectedUrl: record.expectedUrl, match: record.match };
    case 'assert_link_collection': return { ...base, type: 'assert_link_collection', linkName: record.linkName,
      expectedCount: record.expectedCount, expectedHref: record.expectedHref };
    case 'wait_for': return { ...base, type: 'wait_for', condition: record.condition,
      timeoutPolicyRef: record.timeoutPolicyRef };
    case 'state_observed': return !('condition' in record) ||
      ('bindingId' in record && record.bindingId) ? undefined :
      { ...base, type: 'wait_for', condition: record.condition,
        timeoutPolicyRef: record.timeoutPolicyRef };
    default: return undefined;
  }
}

function actualPredicate(page: Page, locator: Locator, record: TargetRecord): Promise<boolean> | boolean {
  switch (record.type) {
    case 'assert_visible': return locator.isVisible();
    case 'assert_text': return locator.innerText().then((text) => record.match === 'exact'
      ? text === record.expectedText : text.includes(record.expectedText));
    case 'assert_value': return typeof record.expectedValue === 'string' &&
      locator.inputValue().then((value) => value === record.expectedValue);
    case 'wait_for': {
      const condition = record.condition;
      if (condition.type === 'target_visible') return locator.isVisible();
      if (condition.type !== 'target_value' || typeof condition.expectedValue !== 'string') return false;
      return locator.inputValue().then((value) => value === condition.expectedValue);
    }
    default: return false;
  }
}

type ClosedPageForm = Exclude<LocatorForm, { type: 'frame' }>;

export function bindInFrame(root: Frame | Locator, form: ClosedPageForm): Locator {
  if (form.type === 'within') return bindInFrame(bindInFrame(root, form.scope), form.target);
  if (form.type === 'rowWithCell') return root.getByRole('row').filter({
    has: root.getByRole('cell', { name: form.cellName, exact: true }),
  });
  switch (form.type) {
    case 'role': return root.getByRole(form.role as Parameters<Frame['getByRole']>[0],
      { name: form.name, exact: form.exact === true });
    case 'label': return root.getByLabel(form.value, { exact: form.exact === true });
    case 'placeholder': return root.getByPlaceholder(form.value, { exact: form.exact === true });
    case 'text': return root.getByText(form.value, { exact: form.exact === true });
    case 'testId': return root.getByTestId(form.value);
  }
}

export async function verifiedFrame(page: Page, ownership: FrameOwnershipV2): Promise<Frame | undefined> {
  if (ownership.kind === 'unproven') return undefined;
  let frame = page.mainFrame();
  if (ownership.kind === 'main') return frame;
  for (const anchor of ownership.anchors) {
    const identity = frame.locator('iframe').and(anchor.identity.kind === 'title' ?
      frame.getByTitle(anchor.identity.value, { exact: true }) :
      frame.getByTestId(anchor.identity.value));
    if (await identity.count() !== 1) return undefined;
    const handle = await identity.elementHandle();
    try {
      const child = await handle?.contentFrame();
      if (!child || child.parentFrame() !== frame) return undefined;
      frame = child;
    } finally { await handle?.dispose(); }
  }
  return frame;
}

export async function waitForRecordedCondition(page: Page, locator: Locator | undefined,
  condition: Extract<SuccessfulPathRecordV2, { type: 'state_observed' }>['condition'],
  timeoutMs: number): Promise<boolean> {
  const satisfied = async (): Promise<boolean> => {
    if (condition.type === 'url_exact') return page.url() === condition.url;
    if (condition.type === 'url_pattern') return matchesExpected(page.url(), condition.pattern, 'pattern');
    if (!locator) return false;
    if (condition.type === 'target_visible') return locator.isVisible().catch(() => false);
    return typeof condition.expectedValue === 'string' &&
      locator.inputValue().then((value) => value === condition.expectedValue).catch(() => false);
  };
  const deadline = Date.now() + timeoutMs;
  do {
    if (await satisfied()) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, deadline - Date.now()));
  } while (true);
}

/** WP3 ends at an immutable compiled artifact. It never runs authoritative QA. */
export async function compileSuccessfulTraceV1(factory: ProtectedContextFactory,
  store: LocalArtifactStore, testSpecId: string, attemptId: string,
): Promise<TraceCompilationResult> {
  const { source, profile } = await store.readJob(testSpecId);
  const { attempt, trace } = await store.readSuccessfulExploration(testSpecId, attemptId);
  if (trace.traceVersion === '2') parseSuccessfulExplorationTraceV2(trace, source, attempt);
  else parseSuccessfulExplorationTraceV1(trace, source, attempt);
  const startedAt = new Date(Math.max(Date.now(), Date.parse(trace.finishedAt))).toISOString();
  const compilerAttemptId = id('compiler');
  const resolvedSpecId = id('resolved');
  const checks: CompilerCheckV1[] = [];
  const steps: CompiledExecutionStepV1[] = [];
  const first = trace.successfulPath[0]!;
  const finishedAt = () => new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
  const owner = { testSpecId: source.testSpecId, explorationAttemptId: attempt.explorationAttemptId,
    successfulTraceId: trace.successfulTraceId, executionProfileRef: source.executionProfileRef,
    profileFingerprint: trace.profileFingerprint };
  const persistStop = async (reason: Reason): Promise<TraceCompilationResult> => {
    if (!checks.some((entry) => entry.result === 'failed'))
      checks.push(check(first, 'closed_form', false, 'UNSUPPORTED_GRAMMAR'));
    const compiler = parseCompilerAttemptV1({ compilerVersion: '1', compilerAttemptId,
      ...owner, startedAt, finishedAt: finishedAt(), checks,
      result: { status: 'rejected', reasonCode: reason } }, trace, source, attempt);
    await store.writeCompilerAttemptV1(compiler);
    return { kind: 'compilation_stop', compiler, reason, cleanup: 'verified' };
  };
  if (!same(source.executionProfileRef, trace.executionProfileRef) || profile.fingerprint !== trace.profileFingerprint) {
    checks.push(check(first, 'profile_equivalence', false, 'PROFILE_MISMATCH'));
    return persistStop('PROFILE_MISMATCH');
  }
  // A digest-only passive transition has no reviewed deterministic wait
  // predicate. Omitting it would silently lose successful-path state.
  if (trace.traceVersion === '1' && trace.successfulPath.some((record) => record.type === 'state_observed')) {
    checks.push(check(trace.successfulPath.find((record) => record.type === 'state_observed')!,
      'closed_form', false, 'UNSUPPORTED_GRAMMAR'));
    return persistStop('UNSUPPORTED_CAPABILITY');
  }
  // Binding v1 records only opaque frameId/pageId UUIDs. Those identifiers
  // cannot prove whether the original target belonged to the main document or
  // to a child frame. A fresh main-page role/name match would be an unsafe
  // substitution for an original child-frame target. Wait for a reviewed
  // versioned binding/trace contract that attests durable frame ownership.
  const frameUnproven = trace.traceVersion === '1' ? trace.successfulPath.find((record) =>
    'bindingId' in record && !!record.bindingId) :
    trace.successfulPath.find((record) => 'bindingId' in record && !!record.bindingId &&
      trace.bindings.find((binding) => binding.bindingId === record.bindingId)?.frameOwnership.kind === 'unproven');
  if (frameUnproven) {
    checks.push(check(frameUnproven, 'selected_target', false, 'TARGET_MISMATCH',
      { selectedTargetMatches: false }));
    return persistStop('UNSUPPORTED_CAPABILITY');
  }
  let session: CompilerVerificationSession | undefined;
  try {
    session = await openProtected(factory, source, profile);
    assertEquivalentEffectiveProfile(profile, session.effectiveProfile);
    checks.push(check(first, 'profile_equivalence', true, 'NONE'));
    const page = session.page;
    for (const [index, record] of trace.successfulPath.entries()) {
      let reason: Reason | undefined;
      let step: CompiledExecutionStepV1 | undefined;
      const passive = record.type === 'state_observed' && 'condition' in record ?
        record as Extract<SuccessfulPathRecordV2, { type: 'state_observed' }> : undefined;
      if ('bindingId' in record && record.bindingId) {
        const binding = trace.bindings.find((item) => item.bindingId === record.bindingId)!;
        const ownership = trace.traceVersion === '2' ?
          (binding as TraceBindingV2).frameOwnership : undefined;
        const frame = ownership && await verifiedFrame(page, ownership);
        if (!frame) {
          checks.push(check(record, 'selected_target', false, 'TARGET_MISMATCH',
            { selectedTargetMatches: false }));
          return persistStop('TARGET_MISMATCH');
        }
        const snapshot = frame === page.mainFrame() ? await session.snapshot() :
          await frame.locator('body').ariaSnapshot();
        const beforeUrl = page.url();
        const form = formFor(source, record, binding, snapshot);
        const framePath = ownership?.kind === 'nested' ?
          ownership.anchors.map((anchor) => anchor.identity) : undefined;
        const formHash = form && digest(framePath ? { form, framePath } : form);
        checks.push(check(record, 'closed_form', !!form, 'UNSUPPORTED_GRAMMAR',
          formHash ? { candidateDigest: formHash } : {}));
        if (!form) return persistStop('UNSUPPORTED_CAPABILITY');
        if (form.type === 'frame') return persistStop('UNSUPPORTED_CAPABILITY');
        const locator = frame === page.mainFrame() ? bindLocator(page, form) : bindInFrame(frame, form);
        // A recorded passive readiness condition may be what makes the target
        // appear. Wait for that *recorded* predicate before correspondence.
        if (passive) {
          const timeoutMs = profile.profile.timeoutPolicy.waits[passive.timeoutPolicyRef];
          if (typeof timeoutMs !== 'number' || timeoutMs <= 0 ||
              !await waitForRecordedCondition(page, locator, passive.condition, timeoutMs)) {
            checks.push(check(record, 'ordered_postcondition', false, 'POSTCONDITION_MISMATCH'));
            return persistStop('POSTCONDITION_MISMATCH');
          }
        }
        const verifiedSnapshot = passive && frame === page.mainFrame() ? await session.snapshot() : snapshot;
        const freshNodes = nodes(verifiedSnapshot, page.url()).filter((node) =>
          node.role === binding.selectedNode.role && node.name === binding.selectedNode.accessibleName &&
          (form.type !== 'within' || form.scope.type !== 'rowWithCell' ||
            inRow(verifiedSnapshot, node, form.scope.cellName)));
        const count = await locator.count();
        checks.push(check(record, 'unique_match', count === 1, 'NON_UNIQUE_MATCH',
          { candidateDigest: formHash, observedMatchCount: count }));
        if (count !== 1) return persistStop('NON_UNIQUE_MATCH');
        // Fresh MCP refs are used only as an independent equality witness.
        // Exploration's selectedRef is never reused in this context.
        let correspondence = frame === page.mainFrame() ? freshNodes.length === 1 &&
          await locator.and(page.locator(`aria-ref=${freshNodes[0]!.ref}`)).count() === 1 :
          count === 1 && form.type !== 'rowWithCell' &&
          binding.selectedNode.role === (form.type === 'within' && form.target.type === 'role' ?
            form.target.role : form.type === 'role' ? form.role : undefined) &&
          binding.selectedNode.accessibleName === (form.type === 'within' && form.target.type === 'role' ?
            form.target.name : form.type === 'role' ? form.name : undefined);
        if (correspondence && form.type === 'within' && form.scope.type === 'rowWithCell') {
          const rowCount = await frame.getByRole('row').filter({
            has: frame.getByRole('cell', { name: form.scope.cellName, exact: true }),
          }).count();
          correspondence = rowCount === 1;
        }
        if (correspondence && binding.selectedNode.destination) {
          const href = await locator.getAttribute('href');
          correspondence = !!href && new URL(href, page.url()).href === binding.selectedNode.destination;
        }
        checks.push(check(record, 'selected_target', correspondence, 'TARGET_MISMATCH',
          { candidateDigest: formHash, selectedTargetMatches: correspondence }));
        if (!correspondence) return persistStop('TARGET_MISMATCH');
        const durable = authoredIdentity(source, record, binding, form);
        checks.push(check(record, 'durable_identity', durable, 'WEAK_IDENTITY',
          { candidateDigest: formHash }));
        if (!durable) return persistStop('WEAK_IDENTITY');
        const compiledLocator: CompiledLocatorV1 = {
          origin: 'verifiedTraceCompilation', validatedForm: form,
          ...(framePath ? { framePath } : {}),
          observed: { role: binding.selectedNode.role,
            accessibleName: binding.selectedNode.accessibleName, matchCount: 1,
            selectedTargetMatches: true },
          quality: { status: 'accepted', identityBasis: form.type === 'within' || framePath
            ? 'scoped-role-and-accessible-name' : 'role-and-accessible-name' },
        };
        step = passive ?
          { ...compiledBase(record), type: 'wait_for', condition: passive.condition,
            timeoutPolicyRef: passive.timeoutPolicyRef, locatorId: id('locator'), locator: compiledLocator } :
          targeted(record as TargetRecord, compiledLocator);
        try {
          if (record.type === 'click') await locator.click();
          else if (record.type === 'fill' && typeof record.value === 'string') await locator.fill(record.value);
          else if (record.type === 'select_option' && typeof record.value === 'string')
            await locator.selectOption(record.value);
          else if (record.type === 'fill' || record.type === 'select_option') reason = 'UNSUPPORTED_CAPABILITY';
          else if (passive) {
            const timeoutMs = profile.profile.timeoutPolicy.waits[passive.timeoutPolicyRef];
            if (typeof timeoutMs !== 'number' || timeoutMs <= 0 ||
                !await waitForRecordedCondition(page, locator, passive.condition, timeoutMs))
              reason = 'POSTCONDITION_MISMATCH';
          }
          else if (record.type === 'assert_visible' || record.type === 'assert_text' ||
            record.type === 'assert_value' || record.type === 'wait_for') {
            const observed = await actualPredicate(page, locator, record as TargetRecord);
            if (observed !== (record.result === 'passed' || record.result === 'satisfied'))
              reason = 'POSTCONDITION_MISMATCH';
          }
          if (!reason && (record.type === 'click' || record.type === 'fill' ||
            record.type === 'select_option')) {
            const afterSnapshot = await session.snapshot();
            const changed = digest(`${beforeUrl}\n${snapshot}`) !==
              digest(`${page.url()}\n${afterSnapshot}`);
            if (changed !== (record.observedEffect === 'state_changed'))
              reason = 'POSTCONDITION_MISMATCH';
            if (!reason && (record.type === 'fill' || record.type === 'select_option') &&
              typeof record.value === 'string' && await locator.inputValue() !== record.value)
              reason = 'POSTCONDITION_MISMATCH';
          }
        } catch { reason = 'POSTCONDITION_MISMATCH'; }
      } else {
        step = untargeted(record);
        if (!step) reason = 'UNSUPPORTED_CAPABILITY';
        else if (record.type === 'navigate') await session.navigate(record.url);
        else if (passive) {
          const timeoutMs = profile.profile.timeoutPolicy.waits[passive.timeoutPolicyRef];
          if (typeof timeoutMs !== 'number' || timeoutMs <= 0 ||
              !await waitForRecordedCondition(page, undefined, passive.condition, timeoutMs))
            reason = 'POSTCONDITION_MISMATCH';
        }
        else if (record.type === 'assert_url') {
          const observed = matchesExpected(page.url(), record.expectedUrl, record.match);
          if (observed !== (record.result === 'passed')) reason = 'POSTCONDITION_MISMATCH';
        } else if (record.type === 'assert_link_collection') {
          const links = await page.getByRole('link', { name: record.linkName, exact: true })
            .evaluateAll((elements) => elements.map((element) =>
              element instanceof HTMLAnchorElement ? element.href : null));
          const observed = links.length === record.expectedCount &&
            links.every((href) => href === record.expectedHref);
          if (observed !== (record.result === 'passed')) reason = 'POSTCONDITION_MISMATCH';
        } else if (record.type === 'wait_for') {
          const condition = record.condition;
          if (condition.type !== 'url_exact' && condition.type !== 'url_pattern') reason = 'UNSUPPORTED_CAPABILITY';
          else if (!matchesExpected(page.url(), condition.type === 'url_exact' ? condition.url : condition.pattern,
            condition.type === 'url_exact' ? 'exact' : 'pattern')) reason = 'POSTCONDITION_MISMATCH';
        }
      }
      if (!reason && (record.type === 'navigate' || record.type === 'click') &&
        record.type === 'navigate' && page.url() !== new URL(record.url).href)
        reason = 'POSTCONDITION_MISMATCH';
      if (!reason && record.type === 'click') {
        const binding = trace.bindings.find((item) => item.bindingId === record.bindingId)!;
        const next = trace.successfulPath[index + 1];
        // A changed/unchanged digest alone does not establish the intended
        // application transition. Require a recorded destination or the next
        // successful-path URL predicate as a concrete postcondition.
        const nextUrl = next?.type === 'assert_url' && next.result === 'passed'
          ? { value: next.expectedUrl, mode: next.match } :
          next?.type === 'wait_for' && next.result === 'satisfied' &&
            (next.condition.type === 'url_exact' || next.condition.type === 'url_pattern')
            ? { value: next.condition.type === 'url_exact' ? next.condition.url : next.condition.pattern,
                mode: next.condition.type === 'url_exact' ? 'exact' as const : 'pattern' as const } : undefined;
        if (!binding.selectedNode.destination && !nextUrl) reason = 'POSTCONDITION_MISMATCH';
        if (binding.selectedNode.destination && page.url() !== binding.selectedNode.destination)
          reason = 'POSTCONDITION_MISMATCH';
        if (!reason && nextUrl && !matchesExpected(page.url(), nextUrl.value, nextUrl.mode))
          reason = 'POSTCONDITION_MISMATCH';
      }
      checks.push(check(record, 'ordered_postcondition', !reason,
        reason === 'UNSUPPORTED_CAPABILITY' ? 'UNSUPPORTED_GRAMMAR' : 'POSTCONDITION_MISMATCH'));
      if (reason) return persistStop(reason);
      if (!step) return persistStop('UNSUPPORTED_CAPABILITY');
      steps.push(CompiledExecutionStepV1Schema.parse(step));
    }
    const compiler = parseCompilerAttemptV1({ compilerVersion: '1', compilerAttemptId,
      ...owner, startedAt, finishedAt: finishedAt(), checks,
      result: { status: 'accepted', resolvedSpecId } }, trace, source, attempt);
    const resolved = parseResolvedTestSpecV6({ schemaVersion: '6',
      sourceSchemaVersion: source.schemaVersion, resolvedSpecId,
      testSpecId: source.testSpecId, explorationAttemptId: attempt.explorationAttemptId,
      executionProfileRef: source.executionProfileRef, profileFingerprint: profile.fingerprint,
      successfulTraceId: trace.successfulTraceId, compilerAttemptId,
      runtimeVersions: { playwright: session.playwrightVersion, mcp: MCP_VERSION,
        runner: RUNNER_VERSION, compiler: '1' }, executionSteps: steps },
    source, attempt, trace, compiler);
    await store.writeCompiledExplorationV6({ compiler, resolved });
    return { kind: 'compiled', compiler, resolved, cleanup: 'verified' };
  } catch (error) {
    throw new TraceCompilationEnvironmentError('verified', error);
  } finally {
    if (session) {
      try { await session.close(); }
      catch (error) { throw new TraceCompilationEnvironmentError('unverified', error); }
    }
  }
}
