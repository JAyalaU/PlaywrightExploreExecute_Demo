import { randomUUID } from 'node:crypto';
import { type ElementHandle, type Frame, type Page } from '@playwright/test';
import { requireTrustedSemanticIntentAdmissionV3, type SemanticIntentStepV3,
  type SemanticTargetIntentV3, type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { sealSemanticGroundingEvidenceV1, sealSemanticGroundingWitnessV1,
  sealSemanticActionExecutionReceiptV1, parseSemanticGroundingWitnessV1, semanticGroundingDigestV1,
  type SemanticActionGroundingWitnessV1, type SemanticGroundingCandidateV1,
  type SemanticGroundingEvidenceV1, type SemanticVerificationGroundingWitnessV1,
  type SemanticActionExecutionReceiptV1 } from '../domain/semantic-grounding-v1.js';
import { CommittedDocumentReadiness, CommittedDocumentReadinessError } from '../browser-action/committed-document-readiness.js';
import type { McpExplorationSession } from './mcp.js';

type Action = Extract<SemanticIntentStepV3, { type: 'action_intent' }>;
type Verification = Extract<SemanticIntentStepV3, { type: 'verification_intent' }>;
export type SemanticGroundingDiagnosticBoundaryV1 =
  'document_readiness_started' | 'document_readiness_completed' |
  'candidate_read_started' | 'candidate_read_completed' |
  'action_dispatch_started' | 'action_dispatch_completed' |
  'action_effect_started' | 'action_effect_completed' |
  'verification_observation_started' | 'verification_observation_completed';
export type SemanticGroundingDiagnosticV1 = (event: {
  boundary: SemanticGroundingDiagnosticBoundaryV1; stepId: string | null;
  documentGenerationId?: string; domContentLoadedObserved?: boolean;
}) => void;
type StopReason = 'UNTRUSTED_ADMISSION' | 'INVALID_STEP' | 'ENVIRONMENT_UNAVAILABLE' |
  'UNRESOLVED_TARGET' | 'AMBIGUOUS_TARGET' | 'ORDINAL_OUT_OF_BOUNDS' |
  'UNSUPPORTED_CAPABILITY' | 'EXPLICIT_MECHANIC_MISMATCH' | 'STALE_EVIDENCE' |
  'EFFECT_UNPROVEN' | 'RESULT_LIMIT' | 'BROWSER_FAILURE';
export class SemanticGroundingStopV1 extends Error {
  readonly code = 'SEMANTIC_GROUNDING_STOP';
  constructor(readonly reason: StopReason) { super(reason); this.name = 'SemanticGroundingStopV1'; }
}
const stop = (reason: StopReason): never => { throw new SemanticGroundingStopV1(reason); };
const MAX_CANDIDATES = 100;
const MAX_FRAMES = 8;
const MAX_AGE_MS = 10_000;
const SELECTOR = 'a,button,input,select,textarea,[role]';
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
type RawCandidate = Omit<SemanticGroundingCandidateV1, 'frameIndex' | 'frameUrl' | 'domainIndex' |
  'identity' | 'exactNameProven' | 'domPath' | 'contextProof'> &
  { domIndex: number; path: string; contextText: string };
type Captured = { candidates: SemanticGroundingCandidateV1[]; raw: RawCandidate[]; handles: ElementHandle[];
  page: Page; revision: number; url: string; frames: Frame[] };
class CaptureInvalidatedByMutation extends Error {}

function matchesCategory(category: string | null, candidate: RawCandidate): boolean {
  if (!category) return true;
  const value = category.toLocaleLowerCase('en-US').trim();
  const aliases: Record<string, string[]> = {
    dropdown: ['combobox', 'listbox'], 'text input': ['textbox', 'searchbox'],
    input: ['textbox', 'searchbox'], checkbox: ['checkbox'], button: ['button'], link: ['link'],
    option: ['option'], radio: ['radio'], textbox: ['textbox'], searchbox: ['searchbox'],
    combobox: ['combobox'], listbox: ['listbox'], control: ['button', 'link', 'checkbox', 'radio',
      'textbox', 'searchbox', 'combobox', 'listbox', 'switch'],
  };
  return (aliases[value] ?? [value]).includes(candidate.role);
}
function contextProof(target: SemanticTargetIntentV3 | null, candidate: RawCandidate):
  SemanticGroundingCandidateV1['contextProof'] | null {
  if (!target?.context) return 'none';
  const category = target.category?.toLowerCase().trim();
  const normalized = target.context.toLowerCase().replace(/\b(from|in|on|of|the|a|an|control)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (category && normalized === category && matchesCategory(target.category, candidate)) return 'self_category';
  if (candidate.contextText.includes(target.context)) return 'ancestor_text';
  return null;
}
function sameDomain(a: SemanticGroundingCandidateV1[], b: SemanticGroundingCandidateV1[]): boolean {
  return a.length === b.length && a.every((item, index) => item.identity === b[index]?.identity &&
    item.checked === b[index]?.checked && item.enabled === b[index]?.enabled &&
    item.value === b[index]?.value && JSON.stringify(item.options) === JSON.stringify(b[index]?.options));
}

/** Inactive v7-only protected browser adapter. It does not issue a runnable artifact or a QA verdict. */
export class SemanticGroundingSessionV1 {
  readonly #session: McpExplorationSession;
  readonly #admission: TrustedSemanticIntentAdmissionV3;
  readonly #attemptId: string;
  readonly #sessionId = `semantic-grounding-${randomUUID()}`;
  readonly #readiness: CommittedDocumentReadiness;
  readonly #performed = new Map<string, SemanticActionGroundingWitnessV1>();
  readonly #receipts = new Map<string, SemanticActionExecutionReceiptV1>();
  readonly #before = new Map<string, Set<string>>();
  readonly #issued = new WeakSet<object>();
  readonly #consumed = new WeakSet<object>();
  readonly #diagnostic: SemanticGroundingDiagnosticV1 | undefined;
  #activeStepId: string | null = null;
  constructor(session: McpExplorationSession, admission: TrustedSemanticIntentAdmissionV3, attemptId: string,
    diagnostic?: SemanticGroundingDiagnosticV1) {
    try { requireTrustedSemanticIntentAdmissionV3(admission); }
    catch { stop('UNTRUSTED_ADMISSION'); }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(attemptId) ||
      JSON.stringify(admission.spec.executionProfileRef) !== JSON.stringify({
        id: session.browserSession.effectiveProfile.profile.id,
        version: session.browserSession.effectiveProfile.profile.version })) stop('UNTRUSTED_ADMISSION');
    this.#session = session; this.#admission = admission; this.#attemptId = attemptId;
    this.#diagnostic = diagnostic;
    this.#readiness = new CommittedDocumentReadiness(session.browserSession);
  }
  #emit(boundary: SemanticGroundingDiagnosticBoundaryV1, extra?: {
    documentGenerationId?: string; domContentLoadedObserved?: boolean }): void {
    try { this.#diagnostic?.({ boundary, stepId: this.#activeStepId, ...extra }); }
    catch { /* Diagnostics cannot affect grounding. */ }
  }
  #step(id: string): SemanticIntentStepV3 {
    const step = this.#admission.spec.steps.find((item) => item.id === id);
    if (!step) stop('INVALID_STEP');
    return step!;
  }
  async #ready(): Promise<Page> {
    if (this.#session.browserSession.isClosed) stop('ENVIRONMENT_UNAVAILABLE');
    this.#emit('document_readiness_started');
    try { const observation = await this.#readiness.waitForCurrentPage(
      this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.navigationMs);
      this.#emit('document_readiness_completed', {
        ...(observation.generationId ? { documentGenerationId: observation.generationId } : {}),
        domContentLoadedObserved: observation.domContentLoadedReached }); }
    catch (error) {
      if (error instanceof CommittedDocumentReadinessError) stop('ENVIRONMENT_UNAVAILABLE');
      throw error;
    }
    const pages = this.#session.browserSession.context.pages();
    if (pages.length !== 1 || pages[0]!.isClosed()) stop('ENVIRONMENT_UNAVAILABLE');
    return pages[0]!;
  }
  async #capture(target: SemanticTargetIntentV3 | null): Promise<Captured> {
    const windowMs = this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.waits.default ??
      this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.actionMs;
    const deadline = performance.now() + windowMs;
    for (;;) {
      try { return await this.#captureOnce(target); }
      catch (error) {
        if (!(error instanceof CaptureInvalidatedByMutation)) throw error;
        // A retry follows a witnessed mutation, never a timer or a blind browser failure.
        if (performance.now() >= deadline) stop('STALE_EVIDENCE');
      }
    }
  }
  async #captureOnce(target: SemanticTargetIntentV3 | null): Promise<Captured> {
    const page = await this.#ready();
    this.#emit('candidate_read_started');
    const revision = this.#session.groundingRevision;
    const url = page.url();
    const frames = page.frames();
    if (frames.length > MAX_FRAMES || url.length > 2048) stop('RESULT_LIMIT');
    // A fresh compiler cannot safely reconstruct an unanchored nested frame from its index.
    if (frames.length !== 1) stop('UNSUPPORTED_CAPABILITY');
    const candidates: SemanticGroundingCandidateV1[] = [], raw: RawCandidate[] = [], handles: ElementHandle[] = [];
    for (const [frameIndex, frame] of frames.entries()) {
      // The observer is scoped to this scan. A changed generation invalidates every
      // previously read candidate, including role/name membership and ordered indexes.
      const generation = await frame.evaluateHandle(() => {
        let revision = 0;
        const observer = new MutationObserver(() => { revision++; });
        observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
        const current = () => { if (observer.takeRecords().length) revision++; return revision; };
        return { current, close: () => { const final = current(); observer.disconnect(); return final; } };
      });
      const checkGeneration = async () => {
        if (await generation.evaluate((guard) => guard.current()) !== 0)
          throw new CaptureInvalidatedByMutation();
      };
      try {
      const found = await frame.locator(SELECTOR).evaluateAll((nodes) => nodes.map((node, domIndex) => {
        const element = node as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const inputType = tag === 'input' ? input.type.toLowerCase() : '';
        const explicit = element.getAttribute('role')?.toLowerCase() ?? '';
        const role = explicit || (tag === 'a' ? 'link' : tag === 'button' ? 'button' :
          tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' :
          tag === 'input' ? inputType === 'checkbox' || inputType === 'radio' ? inputType :
            inputType === 'search' ? 'searchbox' : 'textbox' : 'generic');
        const label = tag === 'input' || tag === 'select' || tag === 'textarea' ?
          (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '' : '';
        const name = (element.getAttribute('aria-label') || label ||
          element.getAttribute('title') || element.textContent || '').trim().slice(0, 512);
        const style = getComputedStyle(element);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
          !!element.getClientRects().length;
        const enabled = !(element as HTMLInputElement).disabled && element.getAttribute('aria-disabled') !== 'true';
        const editable = (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden'].includes(inputType) &&
          !input.readOnly || tag === 'textarea' && !(element as HTMLTextAreaElement).readOnly ||
          element.isContentEditable) && enabled;
        const checked = inputType === 'checkbox' || inputType === 'radio' ? input.checked :
          explicit === 'checkbox' || explicit === 'switch' ? element.getAttribute('aria-checked') === 'true' : null;
        const value = tag === 'input' || tag === 'textarea' || tag === 'select' ? input.value.slice(0, 1024) : null;
        const select = tag === 'select' ? element as HTMLSelectElement : null;
        const options = select ? [...select.options].slice(0, 100).map((option) => ({
          label: option.label.slice(0, 512), value: option.value.slice(0, 1024),
          selected: option.selected, disabled: option.disabled })) : [];
        const path: number[] = []; let current: Element | null = element;
        while (current?.parentElement && path.length < 16) {
          path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement;
        }
        return { domIndex, role, name, tag, inputType, visible, enabled: !!enabled,
          editable: !!editable, checked, value, nativeSelect: !!select, multiple: !!select?.multiple,
          options, path: path.join('.'), contextText: element.parentElement?.textContent?.trim().slice(0, 512) ?? '' };
      })) as RawCandidate[];
      await checkGeneration();
      if (found.length > MAX_CANDIDATES) stop('RESULT_LIMIT');
      const scannedHandles = await frame.locator(SELECTOR).elementHandles();
      await checkGeneration();
      if (scannedHandles.length !== found.length) stop('STALE_EVIDENCE');
      // Role and exact accessible-name membership are checked by Playwright's role engine.
      // DOM tag/ARIA hints alone never make a candidate eligible.
      const rolePaths = new Map<string, Set<string>>();
      const namedPaths = new Map<string, Set<string>>();
      for (const role of new Set(found.map((item) => item.role))) {
        if (!['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option',
          'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox'].includes(role)) continue;
        const paths = await frame.getByRole(role as Parameters<Frame['getByRole']>[0],
          { includeHidden: true }).evaluateAll((nodes) => nodes.map((node) => {
            const path: number[] = []; let current: Element | null = node;
            while (current?.parentElement && path.length < 16) {
              path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement;
            }
            return path.join('.');
          }));
        rolePaths.set(role, new Set(paths));
        await checkGeneration();
        if (target?.exactName) {
          const named = await frame.getByRole(role as Parameters<Frame['getByRole']>[0],
            { name: target.exactName, exact: true, includeHidden: true }).evaluateAll((nodes) => nodes.map((node) => {
              const path: number[] = []; let current: Element | null = node;
              while (current?.parentElement && path.length < 16) {
                path.unshift([...current.parentElement.children].indexOf(current)); current = current.parentElement;
              }
              return path.join('.');
            }));
          namedPaths.set(role, new Set(named));
          await checkGeneration();
        }
      }
      for (const item of found) {
        const context = contextProof(target, item);
        if (!matchesCategory(target?.category ?? null, item) ||
            !rolePaths.get(item.role)?.has(item.path) ||
            target?.exactName !== null && target?.exactName !== undefined &&
              !namedPaths.get(item.role)?.has(item.path) || context === null) continue;
        const name = target?.exactName ?? item.name;
        const handle = scannedHandles[item.domIndex]!;
        await checkGeneration();
        if (!await handle.evaluate((node, index) =>
          node.isConnected && document.querySelectorAll('a,button,input,select,textarea,[role]')[index] === node,
          item.domIndex)) {
          await checkGeneration();
          stop('STALE_EVIDENCE');
        }
        const visible = await handle.isVisible();
        const enabled = await handle.isEnabled();
        const editable = item.editable && await handle.isEditable();
        const checked = ['checkbox', 'radio'].includes(item.inputType) ?
          await handle.isChecked() : item.checked;
        await checkGeneration();
        const identity = semanticGroundingDigestV1({ frameIndex, frameUrl: frame.url(),
          path: item.path, role: item.role, name, tag: item.tag, inputType: item.inputType });
        candidates.push({ frameIndex, frameUrl: frame.url(), domainIndex: candidates.length,
          role: item.role, name, exactNameProven: !!target?.exactName,
          domPath: item.path, contextProof: context,
          tag: item.tag, inputType: item.inputType,
          visible, enabled, editable, checked, value: item.value, nativeSelect: item.nativeSelect,
          multiple: item.multiple, options: item.options, identity });
        raw.push(item); handles.push(handle);
        if (candidates.length > MAX_CANDIDATES) stop('RESULT_LIMIT');
      }
      await checkGeneration();
      if (await generation.evaluate((guard) => guard.close()) !== 0)
        throw new CaptureInvalidatedByMutation();
      } catch (error) {
        // A browser read may fail as a node disappears. Only an observed mutation
        // converts that failure into a full recapture; unrelated failures still stop.
        if (!(error instanceof CaptureInvalidatedByMutation)) {
          try { await checkGeneration(); } catch (changed) {
            if (changed instanceof CaptureInvalidatedByMutation) throw changed;
          }
        }
        throw error;
      } finally {
        await generation.evaluate((guard) => guard.close()).catch(() => {});
        await generation.dispose().catch(() => {});
      }
    }
    if (this.#session.groundingRevision !== revision || page.isClosed() ||
      this.#session.browserSession.context.pages()[0] !== page || page.url() !== url ||
      page.frames().length !== frames.length || frames.some((frame, index) => frame !== page.frames()[index]))
      stop('STALE_EVIDENCE');
    this.#emit('candidate_read_completed');
    return { candidates, raw, handles, page, revision, url, frames };
  }
  #chooseIndex(target: SemanticTargetIntentV3, capture: Captured): number {
    const count = capture.candidates.length;
    if (target.ordinal !== null) {
      if (target.ordinal > count) stop('ORDINAL_OUT_OF_BOUNDS');
      return target.ordinal - 1;
    }
    if (target.relation === 'same_as_step') {
      const prior = this.#performed.get(target.relatedStepId!);
      if (!prior) throw new SemanticGroundingStopV1('UNRESOLVED_TARGET');
      const identity = prior.evidence.candidates.find((candidate) =>
        candidate.domainIndex === prior.evidence.selectedDomainIndex)?.identity;
      const match = capture.candidates.findIndex((candidate) => candidate.identity === identity);
      if (match < 0) stop('UNRESOLVED_TARGET');
      return match;
    }
    if (target.relation === 'created_by_step') {
      const before = this.#before.get(target.relatedStepId!);
      if (!before) throw new SemanticGroundingStopV1('UNRESOLVED_TARGET');
      const created = capture.candidates.filter((candidate) => !before.has(candidate.identity));
      if (created.length !== 1) stop(created.length ? 'AMBIGUOUS_TARGET' : 'UNRESOLVED_TARGET');
      return created[0]!.domainIndex;
    }
    if (!count) stop('UNRESOLVED_TARGET');
    if (count !== 1) stop('AMBIGUOUS_TARGET');
    return 0;
  }
  #evidence(step: SemanticIntentStepV3, target: SemanticTargetIntentV3 | null,
    capture: Captured, index: number | null): SemanticGroundingEvidenceV1 {
    const selected = index === null ? null : capture.candidates[index]!;
    const relation = target?.relation === 'same_as_step' || target?.relation === 'created_by_step' ?
      { kind: target.relation, relatedStepId: target.relatedStepId!, identity: selected!.identity } : null;
    const now = Date.now();
    return sealSemanticGroundingEvidenceV1({ evidenceVersion: 'semantic_grounding_evidence_v1',
      groundingStrategyVersion: 'semantic_capability_discovery_v1',
      attemptId: this.#attemptId, sessionId: this.#sessionId, testSpecId: this.#admission.spec.testSpecId,
      stepId: step.id, profileFingerprint: this.#session.browserSession.effectiveProfile.fingerprint,
      pageUrl: capture.url, observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + MAX_AGE_MS).toISOString(), mcpRevision: capture.revision,
      dependentActionReceiptDigest: step.dependsOnStepId ?
        this.#receipts.get(step.dependsOnStepId)?.receiptDigest ?? null : null,
      domainComplete: true, target, candidates: capture.candidates, selectedDomainIndex: index,
      ordinalProof: target?.ordinal !== null && target?.ordinal !== undefined ?
        { authoredOrdinal: target.ordinal, completeDomainCount: capture.candidates.length,
          selectedDomainIndex: index! } : null, relationProof: relation });
  }
  async groundAction(stepId: string): Promise<SemanticActionGroundingWitnessV1> {
    const step = this.#step(stepId);
    if (step.type !== 'action_intent') throw new SemanticGroundingStopV1('INVALID_STEP');
    this.#activeStepId = stepId;
    try { return await this.#session.withExclusiveGrounding(async () => {
      const capture = await this.#capture(step.target);
      const index = this.#chooseIndex(step.target, capture);
      const candidate = capture.candidates[index]!;
      if (!candidate.visible || !candidate.enabled) stop('UNSUPPORTED_CAPABILITY');
      let mechanic: SemanticActionGroundingWitnessV1['mechanic'];
      let argument: string | null = null, optionProof: SemanticActionGroundingWitnessV1['optionProof'] = null;
      if (step.desiredEffect === 'activate') {
        if (!['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch'].includes(candidate.role))
          stop('UNSUPPORTED_CAPABILITY');
        mechanic = 'click';
      } else if (step.desiredEffect === 'set_checked') {
        if (candidate.tag !== 'input' || !['checkbox', 'radio'].includes(candidate.inputType) ||
            candidate.checked === null || step.checkedState === false && candidate.inputType === 'radio')
          stop('UNSUPPORTED_CAPABILITY');
        mechanic = step.checkedState ? 'check' : 'uncheck';
      } else if (step.desiredEffect === 'choose') {
        if (!candidate.nativeSelect || candidate.multiple) stop('UNSUPPORTED_CAPABILITY');
        const matches = candidate.options.filter((option) => option.label === step.value && !option.disabled);
        if (matches.length !== 1 || candidate.options.filter((option) => option.value === matches[0]?.value).length !== 1)
          stop('UNRESOLVED_TARGET');
        mechanic = 'select_option'; argument = matches[0]!.value;
        optionProof = { label: step.value!, value: argument, ownerIdentity: candidate.identity, matchCount: 1 };
      } else {
        if (!candidate.editable || candidate.value === null) stop('UNSUPPORTED_CAPABILITY');
        mechanic = 'fill'; argument = step.value;
      }
      if (step.authoredMechanic && step.authoredMechanic !== mechanic) stop('EXPLICIT_MECHANIC_MISMATCH');
      const fresh = await this.#capture(step.target);
      if (!sameDomain(capture.candidates, fresh.candidates) || fresh.url !== capture.url ||
          fresh.revision !== capture.revision) stop('STALE_EVIDENCE');
      const value = freeze(sealSemanticGroundingWitnessV1({ witnessVersion: 'semantic_action_grounding_v1',
        step, evidence: this.#evidence(step, step.target, fresh, index), mechanic, argument,
        currentChecked: candidate.checked, requestedChecked: step.checkedState, optionProof }));
      this.#issued.add(value);
      return value as SemanticActionGroundingWitnessV1;
    }); } catch (error) {
      if (error instanceof SemanticGroundingStopV1) throw error;
      if (this.#session.browserSession.isClosed ||
          this.#session.browserSession.context.pages().some((page) => page.isClosed()))
        throw new SemanticGroundingStopV1('ENVIRONMENT_UNAVAILABLE');
      throw new SemanticGroundingStopV1('BROWSER_FAILURE');
    }
  }
  /** Exploration-only execution: never a compiler or QA operation. */
  async executeGroundedAction(witness: SemanticActionGroundingWitnessV1): Promise<SemanticActionExecutionReceiptV1> {
    this.#activeStepId = witness.step.id;
    if (!this.#issued.has(witness)) stop('UNTRUSTED_ADMISSION');
    if (this.#consumed.has(witness)) stop('STALE_EVIDENCE');
    parseSemanticGroundingWitnessV1(witness);
    if (Date.now() > Date.parse(witness.evidence.expiresAt) ||
        this.#session.groundingRevision !== witness.evidence.mcpRevision) stop('STALE_EVIDENCE');
    try { return await this.#session.withExclusiveGrounding(async () => {
      const capture = await this.#capture(witness.step.type === 'action_intent' ? witness.step.target : null);
      if (!sameDomain(witness.evidence.candidates, capture.candidates) || capture.url !== witness.evidence.pageUrl)
        stop('STALE_EVIDENCE');
      const index = witness.evidence.selectedDomainIndex!;
      const handle = capture.handles[index]!;
      const allBefore = await this.#capture(null);
      const beforeStateDigest = semanticGroundingDigestV1({ url: allBefore.url, candidates: allBefore.candidates });
      const justBefore = await this.#capture(witness.step.type === 'action_intent' ? witness.step.target : null);
      if (!sameDomain(capture.candidates, justBefore.candidates) || justBefore.url !== capture.url ||
          justBefore.revision !== capture.revision) stop('STALE_EVIDENCE');
      this.#before.set(witness.step.id, new Set(allBefore.candidates.map((candidate) => candidate.identity)));
      const timeout = this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.actionMs;
      try {
        if (!await handle.evaluate((node) => node.isConnected)) stop('STALE_EVIDENCE');
        this.#emit('action_dispatch_started');
        this.#consumed.add(witness);
        if (witness.mechanic === 'click') await handle.click({ timeout });
        else if (witness.mechanic === 'check') await handle.check({ timeout });
        else if (witness.mechanic === 'uncheck') await handle.uncheck({ timeout });
        else if (witness.mechanic === 'select_option') await handle.selectOption(witness.argument!, { timeout });
        else await handle.fill(witness.argument!, { timeout });
        this.#emit('action_dispatch_completed');
      } catch (error) {
        if (error instanceof SemanticGroundingStopV1) throw error;
        // An action bound to a concrete node must never follow a replacement
        // into its former DOM position.
        const stillConnected = await handle.evaluate((node) => node.isConnected).catch(() => null);
        if (stillConnected === false) stop('STALE_EVIDENCE');
        stop('BROWSER_FAILURE');
      }
      this.#emit('action_effect_started');
      const allAfter = await this.#capture(null);
      let observedFinalState: boolean | string | null = null;
      let effectStatus: SemanticActionExecutionReceiptV1['effectStatus'] = 'delivery_only';
      if (witness.mechanic !== 'click') {
        if (witness.step.type !== 'action_intent') throw new SemanticGroundingStopV1('INVALID_STEP');
        const after = await this.#capture(witness.step.target);
        const selectedBefore = witness.evidence.candidates[index]!;
        const selectedAfter = after.candidates.find((candidate) => candidate.identity === selectedBefore.identity);
        if (!selectedAfter) throw new SemanticGroundingStopV1('EFFECT_UNPROVEN');
        if (witness.mechanic === 'check' || witness.mechanic === 'uncheck') {
          observedFinalState = selectedAfter.checked;
          if (observedFinalState !== witness.requestedChecked) stop('EFFECT_UNPROVEN');
        } else if (witness.mechanic === 'fill') {
          observedFinalState = selectedAfter.value;
          if (observedFinalState !== witness.argument) stop('EFFECT_UNPROVEN');
        } else {
          const options = selectedAfter.options.filter((option) =>
            option.label === witness.optionProof?.label && option.value === witness.optionProof?.value);
          observedFinalState = options.length === 1 ? options[0]!.selected : null;
          if (observedFinalState !== true) stop('EFFECT_UNPROVEN');
        }
        effectStatus = 'state_proven';
      }
      const receipt = freeze(sealSemanticActionExecutionReceiptV1({
        receiptVersion: 'semantic_action_execution_v1', stepId: witness.step.id,
        actionWitnessDigest: witness.witnessDigest, mechanic: witness.mechanic, commandReturned: true,
        beforePageUrl: allBefore.url, afterPageUrl: allAfter.url,
        effectStatus, observedFinalState, beforeStateDigest,
        afterStateDigest: semanticGroundingDigestV1({ url: allAfter.url, candidates: allAfter.candidates }),
        executedAt: new Date().toISOString(),
      }));
      this.#performed.set(witness.step.id, witness);
      this.#receipts.set(witness.step.id, receipt);
      this.#emit('action_effect_completed');
      return receipt;
    }); } catch (error) {
      if (error instanceof SemanticGroundingStopV1) throw error;
      if (this.#session.browserSession.isClosed ||
          this.#session.browserSession.context.pages().some((page) => page.isClosed()))
        throw new SemanticGroundingStopV1('ENVIRONMENT_UNAVAILABLE');
      throw new SemanticGroundingStopV1('BROWSER_FAILURE');
    }
  }
  async #observe(step: Verification): Promise<{ capture: Captured; index: number | null;
    observation: SemanticVerificationGroundingWitnessV1['observation']; observed: string | number | boolean;
    satisfied: boolean }> {
    this.#emit('verification_observation_started');
    const selectedOwner = step.observable === 'selected' && step.subject?.relation === 'same_as_step' ?
      this.#performed.get(step.subject.relatedStepId!) : undefined;
    const selectedTarget = step.observable === 'selected' ?
      selectedOwner?.step.type === 'action_intent' ? selectedOwner.step.target :
        { category: 'dropdown', exactName: null, context: null, ordinal: null,
          relation: 'unspecified', relatedStepId: null } as SemanticTargetIntentV3 : step.subject;
    const capture = await this.#capture(selectedTarget);
    let index: number | null = null;
    let observation: SemanticVerificationGroundingWitnessV1['observation'];
    let observed: string | number | boolean;
    if (step.observable === 'url') { observation = 'url'; observed = capture.url; }
    else if (step.observable === 'exists' || step.observable === 'cardinality') {
      observation = 'complete_count'; observed = step.observable === 'exists' ? capture.candidates.length > 0 :
        capture.candidates.length;
    } else if (step.observable === 'selected') {
      if (step.subject?.relation === 'same_as_step' && !selectedOwner?.optionProof)
        throw new SemanticGroundingStopV1('UNRESOLVED_TARGET');
      const matches = capture.candidates.filter((candidate) => candidate.nativeSelect &&
        (!selectedOwner?.optionProof || candidate.identity === selectedOwner.optionProof.ownerIdentity) &&
        candidate.options.some((option) => option.label === step.subject?.exactName));
      if (matches.length !== 1) stop(matches.length ? 'AMBIGUOUS_TARGET' : 'UNRESOLVED_TARGET');
      index = matches[0]!.domainIndex;
      const options = matches[0]!.options.filter((option) => option.label === step.subject?.exactName);
      if (options.length !== 1 || selectedOwner?.optionProof && options[0]!.value !== selectedOwner.optionProof.value)
        stop('UNRESOLVED_TARGET');
      observation = 'native_selected_option'; observed = options[0]!.selected;
    } else {
      index = this.#chooseIndex(step.subject!, capture);
      const selected = capture.candidates[index]!;
      if (step.observable === 'value') { observation = 'value_property';
        if (selected.value === null) throw new SemanticGroundingStopV1('UNSUPPORTED_CAPABILITY');
        observed = selected.value; }
      else { observation = 'boolean_property';
        const property = step.observable === 'visible' ? selected.visible :
          step.observable === 'enabled' ? selected.enabled : step.observable === 'checked' ? selected.checked : null;
        if (property === null) throw new SemanticGroundingStopV1('UNSUPPORTED_CAPABILITY');
        observed = property; }
    }
    const expected = step.expected;
    const satisfied = step.comparator === 'equals' ? observed === expected :
      typeof observed === 'number' && typeof expected === 'number' &&
      (step.comparator === 'at_least' ? observed >= expected : observed <= expected);
    this.#emit('verification_observation_completed');
    return { capture, index, observation, observed, satisfied };
  }
  async #awaitSameDocumentMutation(page: Page, timeout: number): Promise<boolean> {
    // Wait for an actual same-document change; the trusted deadline is a ceiling,
    // not a delay before claiming the authored resulting state.
    return page.evaluate((ms) => new Promise<boolean>((resolve) => {
      let finished = false;
      const observer = new MutationObserver(() => finish(true));
      const finish = (changed: boolean) => {
        if (finished) return;
        finished = true; observer.disconnect(); clearTimeout(timer); resolve(changed);
      };
      const timer = setTimeout(() => finish(false), ms);
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    }), timeout);
  }
  async groundVerification(stepId: string, settle = true): Promise<SemanticVerificationGroundingWitnessV1> {
    const step = this.#step(stepId);
    if (step.type !== 'verification_intent') throw new SemanticGroundingStopV1('INVALID_STEP');
    this.#activeStepId = stepId;
    try { return await this.#session.withExclusiveGrounding(async () => {
      const initial = await this.#observe(step);
      let result = initial, settled = initial.satisfied;
      if (!settled && settle && step.dependsOnStepId) {
        const timeout = this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.waits.default ??
          this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.actionMs;
        const deadline = Date.now() + timeout;
        while (!settled && Date.now() < deadline) {
          const changed = await this.#awaitSameDocumentMutation(result.capture.page, deadline - Date.now());
          result = await this.#observe(step);
          settled = result.satisfied;
          if (!changed) break;
        }
      }
      const fresh = await this.#observe(step);
      if (fresh.observed !== result.observed || fresh.capture.url !== result.capture.url ||
          fresh.capture.revision !== result.capture.revision ||
          !sameDomain(fresh.capture.candidates, result.capture.candidates)) stop('STALE_EVIDENCE');
      const witness = freeze(sealSemanticGroundingWitnessV1({ witnessVersion: 'semantic_verification_grounding_v1',
        step, evidence: this.#evidence(step, step.subject, fresh.capture, fresh.index),
        observation: fresh.observation, property: step.observable, observed: fresh.observed,
        expectedSatisfied: fresh.satisfied, settled: settled && fresh.satisfied }));
      this.#issued.add(witness);
      return witness as SemanticVerificationGroundingWitnessV1;
    }); } catch (error) {
      if (error instanceof SemanticGroundingStopV1) throw error;
      if (this.#session.browserSession.isClosed ||
          this.#session.browserSession.context.pages().some((page) => page.isClosed()))
        throw new SemanticGroundingStopV1('ENVIRONMENT_UNAVAILABLE');
      throw new SemanticGroundingStopV1('BROWSER_FAILURE');
    }
  }
}
