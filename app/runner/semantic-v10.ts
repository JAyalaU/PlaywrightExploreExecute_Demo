import { randomUUID } from 'node:crypto';
import { type ElementHandle, type Locator, type Page } from '@playwright/test';
import { ProtectedContextFactory, ProtectedFinalCheckError, type ProtectedBrowserSession } from '../profile/context.js';
import { assertEquivalentEffectiveProfile } from '../profile/contracts.js';
import { CommittedDocumentReadiness, CommittedDocumentReadinessError } from '../browser-action/committed-document-readiness.js';
import { semanticGroundingDigestV1 as hash } from '../domain/semantic-grounding-v1.js';
import { type SemanticResolvedStepV10, type SemanticResolvedTestSpecV10,
  parseSemanticResolvedTestSpecV10 } from '../domain/semantic-resolved-v10.js';
import { sealSemanticRunnerRecordV10, sealSemanticRunnerStepV10,
  type SemanticRunnerRecordV10, type SemanticRunnerStepV10,
  type SemanticRunnerStopV10, type SemanticRunnerGuardProofV10 } from '../domain/semantic-runner-v10.js';
import { requireTrustedSemanticResolvedReadbackV10,
  type TrustedSemanticResolvedReadbackV10 } from '../evidence/semantic-compiler-store-v5.js';

type Domain = Extract<SemanticResolvedStepV10, { type: 'action' }>['domain'];
type Target = Extract<SemanticResolvedStepV10, { type: 'action' }>['target'];
type Guarded = Extract<SemanticResolvedStepV10, { domain: Domain }>;
type Raw = { domIndex: number; role: string; name: string; tag: string; inputType: string;
  path: string; contextText: string };
type Candidate = Raw & { identity: string; locator: Locator; handle: ElementHandle };
const SELECTOR = 'a,button,input,select,textarea,[role]';
const MAX_CANDIDATES = 100;
class Stop extends Error { constructor(readonly reason: SemanticRunnerStopV10) { super(reason); } }
const stop = (reason: SemanticRunnerStopV10): never => { throw new Stop(reason); };
function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
async function sameNode(a: ElementHandle, b: ElementHandle): Promise<boolean> {
  return a.evaluate((node, other) => node === other, b);
}
function compare(count: number, operator: 'equals' | 'at_least' | 'at_most', expected: number): boolean {
  return operator === 'equals' ? count === expected : operator === 'at_least' ? count >= expected : count <= expected;
}
function contextKind(context: string | null, candidate: Raw, roles: readonly string[]):
  Target['contextProof'] | null {
  if (context === null) return 'none';
  const normalized = context.toLowerCase().replace(/\b(from|in|on|of|the|a|an|control)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  const aliases: Record<string, string[]> = { dropdown: ['combobox', 'listbox'],
    checkbox: ['checkbox'], button: ['button'], link: ['link'], 'text input': ['textbox', 'searchbox'],
    input: ['textbox', 'searchbox'], textbox: ['textbox'], combobox: ['combobox'],
    control: ['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'switch'] };
  if (aliases[normalized]?.includes(candidate.role) && roles.includes(candidate.role)) return 'self_category';
  if (candidate.contextText.includes(context)) return 'ancestor_text';
  return null;
}
function proof(domain: Domain, candidates: Candidate[], url: string): SemanticRunnerGuardProofV10 {
  const selected = domain.selectedIndex === null ? null : candidates[domain.selectedIndex] ?? null;
  const body = { domainVersion: 'semantic_candidate_domain_v1' as const, complete: true as const,
    count: candidates.length, orderedIdentities: candidates.map(c => c.identity),
    selectedIndex: domain.selectedIndex, selectedIdentity: selected?.identity ?? null,
    ordinal: domain.ordinal, relationSatisfied: domain.relation ? true : null, pageUrl: url };
  return { ...body, proofDigest: hash(body) };
}

/** Replays only the closed v10 role/name/context query. No semantic interpretation or MCP. */
class Runtime {
  readonly sessionId = `semantic-runner-session-${randomUUID()}`;
  readonly #readiness: CommittedDocumentReadiness;
  readonly #selectedByStep = new Map<string, string>();
  readonly #beforeAction = new Map<string, { identities: Set<string>; paths: Set<string> }>();
  constructor(readonly session: ProtectedBrowserSession, readonly page: Page, readonly deadline: number) {
    this.#readiness = new CommittedDocumentReadiness(session);
  }
  bounded(): void {
    if (Date.now() > this.deadline) stop('BUDGET_EXHAUSTED');
    if (this.session.isClosed || this.page.isClosed() || this.session.context.pages().length !== 1 ||
      this.session.context.pages()[0] !== this.page) stop('ENVIRONMENT_FAILURE');
  }
  async ready(): Promise<void> {
    this.bounded();
    try { await this.#readiness.wait(this.page, Math.max(1, Math.min(
      this.session.effectiveProfile.profile.timeoutPolicy.navigationMs, this.deadline - Date.now()))); }
    catch (error) { if (error instanceof CommittedDocumentReadinessError) stop('ENVIRONMENT_FAILURE'); throw error; }
    this.bounded();
  }
  async raw(): Promise<Raw[]> {
    await this.ready();
    if (this.page.frames().length !== 1) stop('UNSUPPORTED_CAPABILITY');
    const found = await this.page.locator(SELECTOR).evaluateAll(nodes => nodes.map((node, domIndex) => {
      const element = node as HTMLElement, tag = element.tagName.toLowerCase();
      const input = element as HTMLInputElement;
      const inputType = tag === 'input' ? input.type.toLowerCase() : '';
      const explicit = element.getAttribute('role')?.toLowerCase() ?? '';
      const role = explicit || (tag === 'a' ? 'link' : tag === 'button' ? 'button' :
        tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ?
          inputType === 'checkbox' || inputType === 'radio' ? inputType :
          inputType === 'search' ? 'searchbox' : 'textbox' : 'generic');
      const label = tag === 'input' || tag === 'select' || tag === 'textarea' ?
        (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '' : '';
      const name = (element.getAttribute('aria-label') || label || element.getAttribute('title') ||
        element.textContent || '').trim().slice(0, 512);
      const path: number[] = []; let current: Element | null = element;
      while (current?.parentElement && path.length < 16) {
        path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement;
      }
      return { domIndex, role, name, tag, inputType, path: path.join('.'),
        contextText: element.parentElement?.textContent?.trim().slice(0, 512) ?? '' };
    }));
    if (found.length > MAX_CANDIDATES || this.page.url().length > 2048) stop('INCOMPLETE_EVIDENCE');
    this.bounded();
    return found;
  }
  async allIdentities(): Promise<{ identities: Set<string>; paths: Set<string> }> {
    const raw = await this.raw(), url = this.page.url();
    return { identities: new Set(raw.map(c => hash({ frameIndex: 0, frameUrl: url, path: c.path,
      role: c.role, name: c.name, tag: c.tag, inputType: c.inputType }))),
      paths: new Set(raw.map(c => c.path)) };
  }
  async domain(domain: Domain): Promise<{ candidates: Candidate[]; guard: SemanticRunnerGuardProofV10 }> {
    const raw = await this.raw(), url = this.page.url(), candidates: Candidate[] = [];
    try {
      const accepted = new Map<string, Set<string>>();
      for (const role of domain.roles) {
        const paths = await this.page.getByRole(role as Parameters<Page['getByRole']>[0],
          { includeHidden: true, ...(domain.exactName !== null ? { name: domain.exactName, exact: true } : {}) })
          .evaluateAll(nodes => nodes.map(node => {
            const path: number[] = []; let current: Element | null = node;
            while (current?.parentElement && path.length < 16) {
              path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement;
            }
            return path.join('.');
          }));
        accepted.set(role, new Set(paths));
      }
      for (const item of raw) {
        if (!accepted.get(item.role)?.has(item.path) || contextKind(domain.context, item, domain.roles) === null) continue;
        const name = domain.exactName ?? item.name;
        const locator = this.page.locator(SELECTOR).nth(item.domIndex);
        const handle = await locator.elementHandle();
        if (!handle || !(await handle.evaluate(node => node.isConnected))) { await handle?.dispose(); stop('STALE_EVIDENCE'); }
        const identity = hash({ frameIndex: 0, frameUrl: url, path: item.path,
          role: item.role, name, tag: item.tag, inputType: item.inputType });
        candidates.push({ ...item, name, identity, locator, handle });
      }
      if (this.page.url() !== url || this.page.frames().length !== 1) stop('STALE_EVIDENCE');
      return { candidates, guard: proof(domain, candidates, url) };
    } catch (error) { await Promise.allSettled(candidates.map(c => c.handle.dispose())); throw error; }
  }
  async guard(step: Guarded): Promise<{ candidates: Candidate[]; guard: SemanticRunnerGuardProofV10;
    selected: Candidate | null }> {
    const result = await this.domain(step.domain), { candidates } = result;
    try {
      const d = step.domain;
      if (d.requireGroundedCount && candidates.length !== d.groundedCount) stop('CARDINALITY_DRIFT');
      if (d.requireGroundedCount && (!same(candidates.map(c => c.identity), d.orderedIdentities) ||
        !same(candidates.map(c => c.path), d.orderedDomPaths))) stop(d.ordinal ? 'ORDINAL_DRIFT' : 'STALE_EVIDENCE');
      if (d.ordinal !== null && d.selectedIndex !== d.ordinal - 1) stop('ORDINAL_DRIFT');
      const selected = d.selectedIndex === null ? null : candidates[d.selectedIndex] ?? null;
      if (d.selectedIndex !== null && !selected) stop('LOCATOR_BINDING_FAILED');
      if (selected && 'target' in step && (selected.identity !== step.target.identity ||
        selected.path !== step.target.domPath || selected.role !== step.target.role ||
        selected.name !== step.target.name || selected.tag === 'generic' ||
        contextKind(step.target.context, selected, d.roles) !== step.target.contextProof)) stop('STALE_EVIDENCE');
      if (d.relation) {
        const related = selected ?? stop('RELATIONSHIP_DRIFT');
        if (d.relation.selectedIdentity !== related.identity) stop('RELATIONSHIP_DRIFT');
        if (d.relation.kind === 'same_as_step') {
          if (this.#selectedByStep.get(d.relation.relatedStepId) !== related.identity) stop('RELATIONSHIP_DRIFT');
        } else {
          const before = this.#beforeAction.get(d.relation.relatedStepId);
          if (!before || before.identities.has(related.identity) || before.paths.has(related.path))
            stop('RELATIONSHIP_DRIFT');
        }
      }
      return { ...result, selected };
    } catch (error) { await this.dispose(result.candidates); throw error; }
  }
  async dispose(candidates: Candidate[]): Promise<void> {
    await Promise.allSettled(candidates.map(c => c.handle.dispose()));
  }
  async action(step: Extract<SemanticResolvedStepV10, { type: 'action' }>, onInvoke: () => void): Promise<{
    guard: SemanticRunnerGuardProofV10; effect: boolean | string | null }> {
    const bound = await this.guard(step), selected = bound.selected ?? stop('LOCATOR_BINDING_FAILED');
    let ownedOptions: ElementHandle[] = [];
    try {
      if (!await selected.handle.isVisible() || !await selected.handle.isEnabled()) stop('LOCATOR_BINDING_FAILED');
      const currentUrl = this.page.url();
      if (step.operation === 'check' || step.operation === 'uncheck') {
        if (selected.tag !== 'input' || !['checkbox', 'radio'].includes(selected.inputType) ||
          step.operation === 'uncheck' && selected.inputType !== 'checkbox' ||
          step.expectedChecked !== (step.operation === 'check') ||
          selected.role !== selected.inputType) stop('UNSUPPORTED_CAPABILITY');
        await selected.handle.isChecked();
      } else if (step.operation === 'select_option') {
        if (selected.tag !== 'select' || selected.role !== 'combobox' || !step.option ||
          step.option.ownerIdentity !== selected.identity || step.argument !== step.option.value ||
          await selected.handle.evaluate(node => (node as HTMLSelectElement).multiple)) stop('UNSUPPORTED_CAPABILITY');
        const options = await this.options(selected);
        if (options.filter(o => o.label === step.option!.label && !o.disabled).length !== 1 ||
          options.filter(o => o.value === step.option!.value).length !== 1 ||
          !options.some(o => o.label === step.option!.label && o.value === step.option!.value && !o.disabled))
          stop('OPTION_MAPPING_MISMATCH');
        ownedOptions = await selected.handle.$$('option');
        if (ownedOptions.length !== options.length || ownedOptions.length > MAX_CANDIDATES)
          stop('OPTION_MAPPING_MISMATCH');
      } else if (step.operation === 'fill') {
        if (!['input', 'textarea'].includes(selected.tag) || !await selected.handle.isEditable() ||
          step.argument === null) stop('UNSUPPORTED_CAPABILITY');
      } else if (!['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch'].includes(selected.role))
        stop('UNSUPPORTED_CAPABILITY');
      this.#beforeAction.set(step.stepId, await this.allIdentities());
      await selected.handle.scrollIntoViewIfNeeded({ timeout: this.actionTimeout() });
      const renewed = await this.guard(step);
      try {
        const renewedTarget = renewed.selected ?? stop('LOCATOR_BINDING_FAILED');
        if (!await sameNode(selected.handle, renewedTarget.handle) ||
          this.page.url() !== currentUrl) stop('STALE_EVIDENCE');
        this.bounded();
        onInvoke();
        try {
          if (step.operation === 'check') await renewedTarget.handle.check({ timeout: this.actionTimeout() });
          else if (step.operation === 'uncheck') await renewedTarget.handle.uncheck({ timeout: this.actionTimeout() });
          else if (step.operation === 'select_option') await renewedTarget.handle.selectOption(
            { value: step.argument! }, { timeout: this.actionTimeout() });
          else if (step.operation === 'fill') await renewedTarget.handle.fill(step.argument!, { timeout: this.actionTimeout() });
          else await renewedTarget.handle.click({ timeout: this.actionTimeout() });
        } catch { stop('ACTION_FAILED_PARTIAL_OR_UNKNOWN'); }
        this.#selectedByStep.set(step.stepId, selected.identity);
        if (step.operation === 'click') return { guard: renewed.guard, effect: null };
        const after = await this.guard(step);
        try {
          const afterTarget = after.selected ?? stop('POST_EFFECT_UNPROVEN');
          if (!await sameNode(renewedTarget.handle, afterTarget.handle))
            stop('POST_EFFECT_UNPROVEN');
          if (step.operation === 'check' || step.operation === 'uncheck') {
            const checked = await afterTarget.handle.isChecked();
            if (checked !== step.expectedChecked) stop('POST_EFFECT_UNPROVEN');
            return { guard: renewed.guard, effect: checked };
          }
          if (step.operation === 'fill') {
            const value = await afterTarget.handle.inputValue();
            if (value !== step.argument) stop('POST_EFFECT_UNPROVEN');
            return { guard: renewed.guard, effect: value };
          }
          const options = await this.options(afterTarget);
          const afterOptions = await afterTarget.handle.$$('option');
          try {
            if (afterOptions.length !== ownedOptions.length ||
              (await Promise.all(afterOptions.map((item, index) => sameNode(item, ownedOptions[index]!))))
                .some(equal => !equal)) stop('POST_EFFECT_UNPROVEN');
          } finally { await Promise.allSettled(afterOptions.map(item => item.dispose())); }
          if (options.filter(o => o.selected).length !== 1 || !options.some(o => o.selected &&
            o.label === step.option?.label && o.value === step.option.value)) stop('POST_EFFECT_UNPROVEN');
          return { guard: renewed.guard, effect: step.option!.value };
        } finally { await this.dispose(after.candidates); }
      } finally { await this.dispose(renewed.candidates); }
    } finally { await this.dispose(bound.candidates);
      await Promise.allSettled(ownedOptions.map(item => item.dispose())); }
  }
  actionTimeout(): number { return Math.max(1, Math.min(this.session.effectiveProfile.profile.timeoutPolicy.actionMs,
    this.deadline - Date.now())); }
  async options(candidate: Candidate): Promise<Array<{ label: string; value: string; selected: boolean; disabled: boolean }>> {
    return candidate.handle.evaluate(node => Array.from((node as HTMLSelectElement).options).map(option => ({
      label: option.label.slice(0, 512), value: option.value.slice(0, 1024), selected: option.selected,
      disabled: option.disabled })), undefined);
  }
  async observe(step: Exclude<SemanticResolvedStepV10, { type: 'action' | 'navigate' }>): Promise<{
    guard: SemanticRunnerGuardProofV10 | null; observed: boolean | string | number; passed: boolean }> {
    if (step.type === 'assert_url') {
      this.bounded(); const observed = this.page.url(); this.bounded();
      return { guard: null, observed, passed: observed === step.expected };
    }
    const bound = await this.guard(step);
    try {
      if (step.type === 'assert_count') {
        const observed = bound.candidates.length;
        return { guard: bound.guard, observed, passed: compare(observed, step.operator, step.expected) };
      }
      const target = bound.selected ?? stop('LOCATOR_BINDING_FAILED');
      let observed: boolean | string;
      if (step.type === 'assert_boolean') observed = step.property === 'visible' ?
        await target.handle.isVisible() : step.property === 'enabled' ?
          await target.handle.isEnabled() : await target.handle.isChecked();
      else if (step.type === 'assert_value') observed = await target.handle.inputValue();
      else {
        if (target.tag !== 'select' || target.role !== 'combobox') stop('UNSUPPORTED_CAPABILITY');
        const options = await this.options(target);
        if (options.filter(o => o.label === step.label && o.value === step.value).length !== 1 ||
          options.filter(o => o.value === step.value).length !== 1) stop('OPTION_MAPPING_MISMATCH');
        observed = options.some(o => o.label === step.label && o.value === step.value && o.selected);
      }
      this.bounded();
      return { guard: bound.guard, observed, passed: observed === step.expected };
    } finally { await this.dispose(bound.candidates); }
  }
  async assert(step: Exclude<SemanticResolvedStepV10, { type: 'action' | 'navigate' }>): Promise<{
    guard: SemanticRunnerGuardProofV10 | null; observed: boolean | string | number; passed: boolean }> {
    const initial = await this.observe(step);
    if (initial.passed || step.wait.mode !== 'bounded_resulting_state') return initial;
    const deadline = Math.min(this.deadline, Date.now() +
      (this.session.effectiveProfile.profile.timeoutPolicy.waits.default ?? 3000));
    let previous = initial;
    while (Date.now() < deadline) {
      this.bounded();
      const remaining = Math.max(1, deadline - Date.now());
      try {
        if (step.type === 'assert_url') {
          try { await this.page.waitForURL(step.expected, { waitUntil: 'commit', timeout: remaining }); }
          catch (error) { if (!/Timeout/i.test(String(error))) throw error; }
        } else if (step.type === 'assert_count') {
          await this.page.evaluate((timeout) => new Promise<void>((resolve) => {
            const observer = new MutationObserver(() => { observer.disconnect(); clearTimeout(timer); resolve(); });
            observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            const timer = setTimeout(() => { observer.disconnect(); resolve(); }, timeout);
          }), remaining);
        } else {
          // A property may change without a DOM mutation; observe at browser frame cadence.
          await this.page.evaluate((timeout) => new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeout);
            requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
          }), remaining);
        }
      } catch { stop('ENVIRONMENT_FAILURE'); }
      previous = await this.observe(step);
      if (previous.passed) return previous;
    }
    return previous;
  }
}

const issued = new WeakSet<object>(), token = Symbol('semantic-runner-v10-origin');
export class TrustedSemanticRunV10 {
  readonly #record: SemanticRunnerRecordV10;
  constructor(authority: symbol, record: SemanticRunnerRecordV10) {
    if (authority !== token) throw new Error('Runner v10 origin required');
    this.#record = structuredClone(record); issued.add(this);
  }
  protectedRecord(): SemanticRunnerRecordV10 { return structuredClone(this.#record); }
}
export function requireTrustedSemanticRunV10(input: TrustedSemanticRunV10): SemanticRunnerRecordV10 {
  if (!issued.has(input)) throw new Error('Untrusted runner v10 origin');
  return TrustedSemanticRunV10.prototype.protectedRecord.call(input);
}
/** One independent deterministic replay; only a trusted v10 readback can enter this boundary. */
export async function runSemanticResolvedTestV10(factory: ProtectedContextFactory,
  input: TrustedSemanticResolvedReadbackV10): Promise<TrustedSemanticRunV10> {
  const executionRunId = `semantic-run-${randomUUID()}`, startedAt = new Date().toISOString();
  let artifact: ReturnType<typeof requireTrustedSemanticResolvedReadbackV10> | undefined;
  let session: ProtectedBrowserSession | undefined, runtime: Runtime | undefined;
  let reason: SemanticRunnerStopV10 | undefined, failedStepId: string | null = null;
  let cleanup: 'verified' | 'unverified' = 'verified';
  const steps: SemanticRunnerStepV10[] = [];
  try {
    try { artifact = requireTrustedSemanticResolvedReadbackV10(input);
      parseSemanticResolvedTestSpecV10(artifact.resolved, artifact.trace);
    } catch { stop('UNAUTHENTICATED_INPUT'); }
    const trusted = artifact ?? stop('UNAUTHENTICATED_INPUT');
    const resolved = trusted.resolved;
    const profileRef = trusted.admission.spec.executionProfileRef;
    const profile = factory.catalog.resolve(profileRef);
    if (profile.fingerprint !== resolved.profileFingerprint) stop('PROFILE_MISMATCH');
    session = await factory.open(profileRef, profile, { observationOwner: { kind: 'run', id: executionRunId } });
    assertEquivalentEffectiveProfile(profile, session.effectiveProfile);
    if (session.effectiveProfile.fingerprint !== resolved.profileFingerprint) stop('PROFILE_MISMATCH');
    const page = await session.context.newPage();
    runtime = new Runtime(session, page, Date.now() + 120_000);
    for (const step of resolved.executionSteps) {
      failedStepId = step.stepId;
      runtime.bounded();
      let guard: SemanticRunnerGuardProofV10 | null = null, invocation: SemanticRunnerStepV10['invocation'] = 'not_invoked';
      let operation: SemanticRunnerStepV10['operation'] = null, effect: SemanticRunnerStepV10['effect'] = null;
      let observation: SemanticRunnerStepV10['observation'] = null, expected: SemanticRunnerStepV10['expected'] = null;
      let status: SemanticRunnerStepV10['status'];
      try {
        if (step.type === 'navigate') {
          operation = 'navigate'; invocation = 'unknown';
          const response = await page.goto(step.url, { waitUntil: 'domcontentloaded',
            timeout: Math.max(1, Math.min(profile.profile.timeoutPolicy.navigationMs, 120_000)) });
          if (response?.status() === 403 && await response.text() === 'Network policy denied request')
            stop('ENVIRONMENT_FAILURE');
          if (page.url() !== new URL(step.url).href) stop('ENVIRONMENT_FAILURE');
          invocation = 'returned'; status = 'action_succeeded';
        } else if (step.type === 'action') {
          operation = step.operation;
          const result = await runtime.action(step, () => { invocation = 'unknown'; });
          guard = result.guard; effect = result.effect; invocation = 'returned'; status = 'action_succeeded';
        } else {
          const result = await runtime.assert(step);
          guard = result.guard; observation = result.observed;
          expected = step.type === 'assert_count' ? step.expected : step.expected;
          status = result.passed ? 'assertion_true' : 'assertion_false';
        }
        steps.push(sealSemanticRunnerStepV10({ stepId: step.stepId, resolvedType: step.type, status,
          guard, invocation, operation, effect, observation, expected, stopReason: null }));
      } catch (error) {
        const code: SemanticRunnerStopV10 = error instanceof Stop ? error.reason :
          invocation === 'unknown' ? 'ACTION_FAILED_PARTIAL_OR_UNKNOWN' : 'ENVIRONMENT_FAILURE';
        steps.push(sealSemanticRunnerStepV10({ stepId: step.stepId, resolvedType: step.type,
          status: 'stopped', guard, invocation, operation, effect, observation, expected, stopReason: code }));
        stop(code);
      }
    }
    failedStepId = null;
  } catch (error) { reason = error instanceof Stop ? error.reason : 'ENVIRONMENT_FAILURE'; }
  finally {
    if (session) try { await session.closeWithFinalCheck(async () => {
      if (!runtime || runtime.page.isClosed() || session!.context.pages().length !== 1 ||
        session!.context.pages()[0] !== runtime.page) stop('ENVIRONMENT_FAILURE');
    }); } catch (error) {
      if (error instanceof ProtectedFinalCheckError) reason = 'ENVIRONMENT_FAILURE';
      else { cleanup = 'unverified'; reason = 'CLEANUP_UNVERIFIED'; }
    }
  }
  const resolved = artifact?.resolved;
  const record = sealSemanticRunnerRecordV10({ runnerVersion: '10', executionRunId,
    sessionId: runtime?.sessionId ?? null, startedAt, finishedAt: new Date().toISOString(),
    resolvedSpecId: resolved?.resolvedSpecId ?? 'unavailable', resolvedDigest: resolved?.resolvedDigest ?? '0'.repeat(64),
    compilerAttemptId: resolved?.compilerAttemptId ?? 'unavailable', traceDigest: resolved?.traceDigest ?? '0'.repeat(64),
    profileFingerprint: resolved?.profileFingerprint ?? '0'.repeat(64), cleanup, steps,
    result: reason ? { kind: 'non_qa_stop', reason, failedStepId } :
      { kind: 'completed', assertions: steps.filter(s => s.status.startsWith('assertion_')).length,
        passed: !steps.some(s => s.status === 'assertion_false') } });
  return new TrustedSemanticRunV10(token, record);
}
