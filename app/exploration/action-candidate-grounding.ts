import { randomUUID } from 'node:crypto';
import { requireTrustedSuccessfulTraceReadbackV5, type TrustedSuccessfulTraceReadbackV5 } from '../evidence/trace-store-v5.js';
import type { ElementHandle, Frame, Locator, Page } from '@playwright/test';
import { selectors } from '@playwright/test';
import { z } from 'zod';
import {
  ActionCandidateRequestV1Schema, ActionCandidateBindingV1Schema, candidateGroundingDigest as hash,
  parseActionCandidateObservationV1, type ActionCandidateBindingV1,
  type ActionCandidateObservationV1, type ActionCandidateRoleV1,
  parseActionCandidateActionCheckV1, type ActionCandidateActionCheckV1,
  type ActionCandidateRequestV1,
} from '../domain/action-candidate-grounding.js';
import { requireTrustedSemanticAdmissionV2, validateActionObligationHandoffV2,
  type TrustedSemanticAdmissionV2 } from '../domain/action-semantic-admission.js';
import { McpToolError, type McpExplorationSession } from './mcp.js';
import { parseActionOptionObservationV1, parseActionChoiceActionCheckV1, ActionOptionObservationV1Schema, ActionChoiceActionCheckV1Schema,
  type ActionOptionObservationV1, type ActionChoiceActionCheckV1 } from '../domain/action-option-grounding.js';
import { ActionLabelAssociationRequestV1Schema, ActionLabelAssociationBindingV1Schema,
  parseActionLabelAssociationObservationV1, parseActionLabelAssociationCheckV1,
  type ActionLabelAssociationObservationV1, type ActionLabelAssociationBindingV1,
  type ActionLabelAssociationCheckV1 } from '../domain/action-label-grounding.js';
import { readOwnedLabelSources } from './action-label-semantics.js';
import { nativeActivationReceipt } from './action-activation-execution.js';
import { requireTrustedGroundingMappingV1, parsePreparedActionGroundingV1, PreparedActionGroundingV1Schema,
  type TrustedGroundingMappingV1, type PreparedActionGroundingV1 } from '../domain/action-grounding-strategy.js';
import { ActionExecutionAttemptV1Schema, ActionPostEffectV1Schema, ActionGroundingWitnessV1Schema,
  parseActionExecutionAttemptV1, parseActionPostEffectV1, parseActionGroundingWitnessV1, type ActionExecutionAttemptV1,
  type ActionPostEffectV1, type ActionGroundingWitnessV1, type ActionGroundingExecutionOutcomeV1 } from '../domain/action-grounding-execution.js';
import { ActionGroundingRetirementV1Schema, parseActionGroundingRetirementV1,
  type ActionGroundingRetirementV1 } from '../domain/action-grounding-execution.js';

const roles: Record<'activate' | 'enter_text' | 'choose', ActionCandidateRoleV1[]> = {
  activate: ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch', 'treeitem'],
  enter_text: ['textbox', 'searchbox'], choose: ['combobox', 'listbox'],
};
const MAX_CANDIDATES = 80;
const MAX_RECORDS = 80;
const MAX_AGE_MS = 10_000;
type Complete = Extract<ActionCandidateObservationV1, { status: 'complete' }>;
type Candidate = Complete['candidates'][number];
type FailureReason = Extract<ActionCandidateObservationV1, { status: 'error' }>['reason'];
type State = { page: Page; pageId: string; frames: Frame[]; stateDigest: string; materialDigest: string; stateEpoch: number;
  mutationEpoch: number; frameDigests: Map<Frame, string> };
type Held = { candidate: Candidate; frame: Frame; handle: ElementHandle };
type Capture = { record: ActionCandidateObservationV1; held: Held[] };
type OptionCapture = { record: ActionOptionObservationV1; handles: ElementHandle[] };
type LabelCapture = { record: ActionLabelAssociationObservationV1; handles: ElementHandle[] };
type GroundingMapping = { request: ActionCandidateRequestV1; goal: Extract<TrustedSemanticAdmissionV2['spec']['steps'][number], { type: 'action_goal' }>;
  effect: 'activate' | 'enter_text' | 'choose'; predicate: Complete['predicate']; pending: string[]; discharged: string[] };
type NativeOptions = Pick<Extract<ActionOptionObservationV1, { status: 'complete' }>, 'options' | 'count' | 'multiple'> & { handles: ElementHandle[] };
type PreparedCapture = { record: PreparedActionGroundingV1; held: Held[]; labelHandles: ElementHandle[];
  optionHandles: ElementHandle[] };
import {nativeOptionEngine,nativeOptionFactsEngine,nativeFactsSchema} from '../browser-action/native-option-facts.js';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const optionRecord = (input: unknown) => {
  const { witnessDigest: _digest, ...data } = ActionOptionObservationV1Schema.parse(input);
  return parseActionOptionObservationV1({ ...data, witnessDigest: hash(data) });
};
const choiceCheck = (input: unknown) => {
  const { witnessDigest: _digest, ...data } = ActionChoiceActionCheckV1Schema.parse(input);
  return parseActionChoiceActionCheckV1({ ...data, witnessDigest: hash(data) });
};

export class ActionCandidateGroundingError extends Error {
  readonly code = 'ACTION_GROUNDING_STOP';
  constructor(readonly reason: FailureReason | 'INVALID_REQUEST' | 'OBLIGATION_MAPPING_MISMATCH' |
    'UNSUPPORTED_MAPPING' | 'UNTRUSTED_EVIDENCE' | 'SELECTED_REF_NOT_MEMBER' |
    'NO_CANDIDATES' | 'NON_UNIQUE' | 'PENDING_OBLIGATIONS' | 'NOT_ACTIONABLE' |
    'UNSUPPORTED_OPERATION' | 'BUSY' | 'UNSUPPORTED_CONTROL' | 'OPTION_ABSENT' |
    'OPTION_NON_UNIQUE' | 'VALUE_NON_UNIQUE' | 'OPTION_DISABLED') { super(reason); this.name = 'ActionCandidateGroundingError'; }
}
function stop(reason: ActionCandidateGroundingError['reason']): never { throw new ActionCandidateGroundingError(reason); }

/** Private additive foundation. No old binding, observation, trace or workflow acquires new authority. */
export class ActionCandidateGroundingSessionV1 {
  static #owners = new WeakMap<McpExplorationSession, ActionCandidateGroundingSessionV1>();
  readonly sessionId = `grounding-session-${randomUUID()}`;
  readonly #session: McpExplorationSession;
  readonly #admission: TrustedSemanticAdmissionV2;
  readonly #compilerMappings = new WeakSet<object>();
  #compilerHandoff: ActionCandidateRequestV1['handoff'] | undefined;
  readonly #attempt: string;
  readonly #clock: () => number;
  readonly #ids = new WeakMap<object, string>();
  readonly #captures = new Map<string, Capture>();
  readonly #bindings = new Map<string, ActionCandidateBindingV1>();
  readonly #listeners = new Set<(record: ActionCandidateObservationV1) => void>();
  readonly #checks = new Map<string, ActionCandidateActionCheckV1>();
  readonly #optionCaptures = new Map<string, OptionCapture>();
  readonly #choiceChecks = new Map<string, ActionChoiceActionCheckV1>();
  readonly #labelCaptures = new Map<string, LabelCapture>();
  readonly #labelBindings = new Map<string, ActionLabelAssociationBindingV1>();
  readonly #labelChecks = new Map<string, ActionLabelAssociationCheckV1>();
  readonly #prepared = new Map<string, PreparedActionGroundingV1>();
  readonly #preparedMappings = new Map<string, TrustedGroundingMappingV1>();
  readonly #preparedCaptures = new Map<string, PreparedCapture>();
  readonly #executions = new Map<string, ActionExecutionAttemptV1>();
  readonly #groundingWitnesses = new Map<string, ActionGroundingWitnessV1>();
  readonly #postEffects = new Map<string, ActionPostEffectV1>();
  readonly #genericClickDeliveries = new Map<string, { stepId: string; role: string; accessibleName: string;
    dispatched: true; returned: true; elapsedMs: number }>();
  readonly #executionChecks = new Map<string, PreparedActionGroundingV1>();
  readonly #consumedPreparations = new Set<string>();
  readonly #groundingRetirements = new Map<string, ActionGroundingRetirementV1>();
  #lastCapturedState: State | undefined;
  #navigationEpoch = 0;
  #mutationEpoch = 0;
  #stateEpoch = 0;
  #stateKey = '';
  #closed = false;
  #busy = false;
  #deadline = Number.POSITIVE_INFINITY;

  constructor(session: McpExplorationSession, admission: TrustedSemanticAdmissionV2,
    attemptId: string, clock: () => number = Date.now, compilerReadback?: TrustedSuccessfulTraceReadbackV5) {
    const historical = compilerReadback && requireTrustedSuccessfulTraceReadbackV5(compilerReadback).trace;
    if (historical) {
      if (!same(admission.spec, historical.source) || !same(admission.record, historical.semanticAdmission) ||
        session.browserSession.effectiveProfile.fingerprint !== historical.profileFingerprint) stop('UNTRUSTED_EVIDENCE');
      this.#compilerHandoff = historical.obligationHandoff;
    } else requireTrustedSemanticAdmissionV2(admission);
    const effective = session.browserSession.effectiveProfile;
    if (!same(admission.spec.executionProfileRef, { id: effective.profile.id, version: effective.profile.version }) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(attemptId)) stop('INVALID_REQUEST');
    this.#session = session; this.#admission = admission; this.#attempt = attemptId; this.#clock = clock;
    ActionCandidateGroundingSessionV1.#owners.get(session)?.invalidate();
    ActionCandidateGroundingSessionV1.#owners.set(session, this);
    const watch = (page: Page) => {
      const changed = () => { this.#navigationEpoch++; this.invalidate(); };
      page.on('framenavigated', changed); page.on('frameattached', changed);
      page.on('framedetached', changed); page.on('close', changed);
    };
    session.browserSession.context.on('page', (page) => { this.#navigationEpoch++; this.invalidate(); watch(page); });
    session.browserSession.context.pages().forEach(watch);
    session.browserSession.onClosing(() => {
      this.#closed = true; this.invalidate();
      for (const capture of this.#preparedCaptures.values())
        void Promise.all([...capture.held.map((h) => h.handle), ...capture.labelHandles, ...capture.optionHandles].map((h) => h.dispose().catch(() => {})));
      this.#preparedCaptures.clear();
    });
  }
  /** Fresh compiler authority is authenticated historical provenance, never recreated WP1/M7 origin. */
  static forFreshCompiler(session: McpExplorationSession, readback: TrustedSuccessfulTraceReadbackV5, attemptId: string) {
    const { trace } = requireTrustedSuccessfulTraceReadbackV5(readback);
    const historicalSource = { spec: trace.source, record: trace.semanticAdmission } as unknown as TrustedSemanticAdmissionV2;
    const runtime = new ActionCandidateGroundingSessionV1(session, historicalSource, attemptId, Date.now, readback);
    const mappings = new Map<string, TrustedGroundingMappingV1>();
    for (const record of trace.successfulPath) {
      if (record.type !== 'action_goal') continue;
      const pre = record.witness.finalCheck;
      const mapping = { admission: historicalSource, goalId: pre.goalId, vocabularyVersion: pre.vocabularyVersion,
        primaryPromptVersion: pre.primaryPromptVersion, independentPromptVersion: pre.independentPromptVersion,
        correspondence: structuredClone(pre.correspondence), mappingDigest: pre.mappingDigest,
        ...(pre.independentExtractionDigest ? { independentExtractionDigest: pre.independentExtractionDigest } : {}) };
      // Private registration grants only this fresh compiler runtime access to the exact stored mapping.
      const immutable = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(immutable); Object.freeze(v); } };
      immutable(mapping); runtime.#compilerMappings.add(mapping); mappings.set(pre.goalId, mapping);
    }
    return { runtime, mappings };
  }
  #requireMapping(mapping: TrustedGroundingMappingV1): void {
    if (this.#compilerHandoff) {
      if (!this.#compilerMappings.has(mapping) || mapping.admission !== this.#admission) stop('UNTRUSTED_EVIDENCE');
    } else requireTrustedGroundingMappingV1(mapping, this.#admission);
  }
  #semanticContext() {
    return this.#compilerHandoff ? { source: this.#admission.spec, semanticAdmission: this.#admission.record } : this.#admission;
  }
  #id(object: object, prefix: string): string {
    let id = this.#ids.get(object);
    if (!id) { id = `${prefix}-${randomUUID()}`; this.#ids.set(object, id); }
    return id;
  }
  #owner(): void {
    if (this.#closed || this.#session.browserSession.isClosed ||
      ActionCandidateGroundingSessionV1.#owners.get(this.#session) !== this) stop('STALE_STATE');
    if (Date.now() > this.#deadline) stop('QUERY_UNEVALUABLE');
  }
  async #exclusive<T>(consume: () => Promise<T>, deadline = Number.POSITIVE_INFINITY): Promise<T> {
    this.#deadline = Math.min(Date.now() + 15_000, deadline);
    try { return await this.#session.withExclusiveGrounding(consume); }
    catch (error) {
      if (error instanceof McpToolError && error.tool === 'grounding') stop('BUSY');
      throw error;
    }
    finally { this.#deadline = Number.POSITIVE_INFINITY; }
  }
  /** Trusted integration must invalidate after every mutation, including failed/partial actions. */
  invalidate(): void { this.#mutationEpoch++; this.#bindings.clear(); this.#labelBindings.clear(); }

  /** Private-slot checked handoff for deferred trace/verification; never a model tool. */
  protectedTraceOwner(session?: McpExplorationSession) {
    this.#owner();
    if (this.#compilerHandoff) stop('UNTRUSTED_EVIDENCE');
    return ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this, session);
  }
  /** Observation ownership includes fresh compiler sessions without granting exploration assembly origin. */
  protectedObservationOwner(session?: McpExplorationSession) {
    this.#owner();
    if (session && session !== this.#session) stop('UNTRUSTED_EVIDENCE');
    return { admission: this.#admission, session: this.#session, attemptId: this.#attempt,
      sessionId: this.sessionId, profileFingerprint: this.#session.browserSession.effectiveProfile.fingerprint };
  }
  async protectedTraceState(aroundObservation?: (read: () => Promise<void>) => Promise<void>): Promise<State> {
    return this.#state(aroundObservation);
  }
  protectedSuccessfulGroundingWitnesses(): readonly ActionGroundingWitnessV1[] {
    this.#owner(); return structuredClone([...this.#groundingWitnesses.values()]);
  }
  protectedActionGroundingRetirement(witnessId: string): ActionGroundingRetirementV1 | undefined {
    this.#owner(); const record = this.#groundingRetirements.get(witnessId); return record && structuredClone(record);
  }

  #request(input: unknown) {
    const parsed = ActionCandidateRequestV1Schema.safeParse(input);
    if (!parsed.success) stop('INVALID_REQUEST');
    const request = parsed.data;
    try {
      if (this.#compilerHandoff) { if (!same(request.handoff, this.#compilerHandoff)) throw new Error('Compiler source mismatch'); }
      else validateActionObligationHandoffV2(this.#admission, request.handoff);
    }
    catch { stop('OBLIGATION_MAPPING_MISMATCH'); }
    const goal = this.#admission.spec.steps.find((g) => g.id === request.goalId);
    if (!goal || goal.type !== 'action_goal') stop('INVALID_REQUEST');
    if (request.mapping.length !== goal.obligations.length || new Set(request.mapping.map((m) => m.obligationId)).size !== request.mapping.length ||
      goal.obligations.some((o) => !request.mapping.some((m) => m.obligationId === o.id))) stop('OBLIGATION_MAPPING_MISMATCH');
    const effect = goal.obligations.find((o) => o.kind === 'effect')!;
    if (effect.kind !== 'effect') stop('INVALID_REQUEST');
    let eligible = [...roles[effect.effect]];
    const names: string[] = [], pending: string[] = [], discharged: string[] = [];
    for (const mapping of request.mapping) {
      const obligation = goal.obligations.find((o) => o.id === mapping.obligationId)!;
      if (mapping.kind === 'pending') { pending.push(obligation.id); continue; }
      let valid = false;
      if (mapping.kind === 'effect') valid = obligation.kind === 'effect';
      if (mapping.kind === 'operation') valid = obligation.kind === 'operation';
      if (mapping.kind === 'literal') {
        valid = obligation.kind === 'argument';
        // Literal copying does not prove choice-to-control/option membership.
        if (obligation.kind === 'argument' && obligation.purpose === 'choice') pending.push(obligation.id);
      }
      if (mapping.kind === 'role_exact') {
        valid = obligation.kind === 'constraint' && obligation.constraint === 'role' &&
          obligation.subject.kind === 'target' && obligation.polarity === 'positive' && obligation.authoredText === mapping.role;
        eligible = eligible.filter((r) => r === mapping.role);
      }
      if (mapping.kind === 'name_exact') {
        valid = obligation.kind === 'constraint' && obligation.constraint === 'name' &&
          obligation.subject.kind === 'target' && obligation.polarity === 'positive' && obligation.authoredText === mapping.name;
        names.push(mapping.name);
      }
      if (mapping.kind === 'unique') valid = obligation.kind === 'constraint' && obligation.constraint === 'uniqueness' &&
        obligation.subject.kind === 'target' && obligation.polarity === 'positive';
      if (mapping.kind === 'dependency') valid = goal.sourceMode === 'semantic_poc' && obligation.kind === 'prerequisite';
      if (!valid || !eligible.length) stop('UNSUPPORTED_MAPPING');
      if (!pending.includes(obligation.id)) discharged.push(obligation.id);
    }
    // Pending target constraints mean this is a complete broad candidate domain, not a full goal proof.
    return { request, goal, effect: effect.effect, predicate: { domain: 'all_current_page_frames' as const,
      roles: eligible, names }, pending, discharged };
  }

  async #state(aroundObservation?: (read: () => Promise<void>) => Promise<void>): Promise<State> {
    try { return await this.#captureState(aroundObservation); }
    catch (error) { if (error instanceof ActionCandidateGroundingError) throw error; stop('BROWSER_FAILURE'); }
  }
  async #captureState(aroundObservation?: (read: () => Promise<void>) => Promise<void>): Promise<State> {
    this.#owner();
    const navigation = this.#navigationEpoch, mutation = this.#mutationEpoch, revision = this.#session.groundingRevision;
    const pages = this.#session.browserSession.context.pages();
    if (pages.length !== 1 || pages[0]!.isClosed()) stop('BROWSER_FAILURE');
    const page = pages[0]!, frames = page.frames();
    if (frames.length > 8) stop('RESULT_LIMIT');
    const frameDigests = new Map<Frame, string>();
    const readFrames = async () => {
      for (const frame of frames) {
        this.#owner();
        const content = await frame.content();
        const aria = await frame.locator('body').ariaSnapshot({ mode: 'ai', timeout: 3000 });
        if (content.length > 262_144 || aria.length > 131_072) stop('RESULT_LIMIT');
        frameDigests.set(frame, hash({ content, aria, url: frame.url(),
          frameId: this.#id(frame, 'frame'), parent: frame.parentFrame() ? this.#id(frame.parentFrame()!, 'frame') : null }));
      }
    };
    if (aroundObservation) await aroundObservation(readFrames);
    else await readFrames();
    this.#owner();
    const afterFrames = page.frames();
    if (navigation !== this.#navigationEpoch || mutation !== this.#mutationEpoch || revision !== this.#session.groundingRevision || page.isClosed() ||
      frames.length !== afterFrames.length || frames.some((frame, i) => frame !== afterFrames[i]) ||
      this.#session.browserSession.context.pages()[0] !== page) stop('STALE_STATE');
    const stateDigest = hash({ pageId: this.#id(page, 'page'), frames: [...frameDigests.values()], navigation, mutation, revision });
    if (stateDigest !== this.#stateKey) { this.#stateKey = stateDigest; this.#stateEpoch++; }
    const state = { page, frames, pageId: this.#id(page, 'page'), stateDigest,
      materialDigest: hash({ pageId: this.#id(page, 'page'), frames: [...frameDigests.values()], navigation, revision }),
      stateEpoch: this.#stateEpoch, mutationEpoch: mutation, frameDigests };
    this.#lastCapturedState = state;
    return state;
  }

  async #frameProof(frame: Frame, state: State): Promise<Candidate['frame']> {
    if (frame === state.page.mainFrame()) return { kind: 'main' };
    const anchors: Extract<Candidate['frame'], { kind: 'nested' }>['anchors'] = [];
    let child = frame;
    while (child !== state.page.mainFrame()) {
      this.#owner();
      const parent = child.parentFrame();
      if (!parent || anchors.length >= 8) stop('UNPROVEN_FRAME');
      const element = await child.frameElement();
      try {
        let anchor: typeof anchors[number] | undefined;
        for (const kind of ['title', 'testId'] as const) {
          const attribute = kind === 'title' ? 'title' : 'data-testid';
          const value = await element.getAttribute(attribute);
          if (!value || value.length > 512) continue;
          const siblings = parent.locator('iframe');
          const count = await siblings.count();
          if (count > 80) stop('RESULT_LIMIT');
          let matches = 0, owned = false;
          for (let i = 0; i < count; i++) {
            this.#owner();
            if (await siblings.nth(i).getAttribute(attribute) !== value) continue;
            matches++;
            const handle = await siblings.nth(i).elementHandle();
            try { if (await handle?.contentFrame() === child) owned = true; } finally { await handle?.dispose(); }
          }
          if (matches === 1 && owned) { anchor = { kind, value, exact: true,
            ownerDigest: state.frameDigests.get(parent)!, matchCount: 1 }; break; }
        }
        if (!anchor) stop('UNPROVEN_FRAME');
        anchors.unshift(anchor); child = parent;
      } finally { await element.dispose(); }
    }
    return { kind: 'nested', anchors };
  }

  async #enumerate(state: State, predicate: Complete['predicate']): Promise<Held[]> {
    const held: Held[] = [];
    try {
      for (const frame of state.frames) {
        for (const role of predicate.roles) {
          let locator = frame.getByRole(role, { includeHidden: true,
            ...(predicate.names.length ? { name: predicate.names[0], exact: true } : {}) });
          for (const name of predicate.names.slice(1)) locator = locator.and(frame.getByRole(role, { name, exact: true, includeHidden: true }));
          const count = await locator.count();
          if (held.length + count > MAX_CANDIDATES) stop('RESULT_LIMIT');
          for (let i = 0; i < count; i++) {
            this.#owner();
            const target = locator.nth(i);
            const handle = await target.elementHandle();
            if (!handle || await handle.ownerFrame() !== frame) { await handle?.dispose(); stop('QUERY_UNEVALUABLE'); }
            try {
              const raw = await target.ariaSnapshotJSON({ mode: 'ai', depth: 0, timeout: 3000 });
              const node = Array.isArray(raw) ? raw[0] : raw;
              if (!node || typeof node !== 'object' || node.role !== role ||
                node.name !== undefined && typeof node.name !== 'string' ||
                typeof node.name === 'string' && node.name.length > 512 || typeof node.ref !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(node.ref)) stop('QUERY_UNEVALUABLE');
              const refLocator = frame.locator(`aria-ref=${node.ref}`);
              if (await refLocator.count() !== 1 || await target.and(refLocator).count() !== 1) stop('QUERY_UNEVALUABLE');
              held.push({ frame, handle, candidate: { selectedRef: node.ref, frameId: this.#id(frame, 'frame'),
                frame: await this.#frameProof(frame, state), role, accessibleName: typeof node.name === 'string' ? node.name : '',
                visible: await target.isVisible(), enabled: await target.isEnabled(),
                editable: await target.isEditable().catch(() => false),
                nativeSelect: await target.and(frame.locator('select')).count() === 1 } });
            } catch (error) { await handle.dispose(); throw error; }
          }
        }
      }
      return held;
    } catch (error) {
      await Promise.all(held.map((h) => h.handle.dispose()));
      if (error instanceof ActionCandidateGroundingError) throw error;
      stop('QUERY_UNEVALUABLE');
    }
  }

  onProtectedRecord(listener: (record: ActionCandidateObservationV1) => void): () => void {
    this.#owner(); this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  protectedRecord(observationId: string): ActionCandidateObservationV1 | undefined {
    this.#owner(); const capture = this.#captures.get(observationId); return capture && structuredClone(capture.record);
  }
  protectedActionCheck(checkId: string): ActionCandidateActionCheckV1 | undefined {
    this.#owner(); const check = this.#checks.get(checkId); return check && structuredClone(check);
  }

  async query(input: unknown, deadline = Number.POSITIVE_INFINITY): Promise<ActionCandidateObservationV1> {
    this.#owner(); if (this.#busy) stop('BUSY');
    const mapping = this.#request(input);
    if (this.#captures.size >= MAX_RECORDS) stop('RESULT_LIMIT');
    this.#busy = true;
    try { return await this.#exclusive(async () => {
      const before = await this.#state();
      let held: Held[] = [], reason: FailureReason | undefined;
      try {
        held = await this.#enumerate(before, mapping.predicate);
        const after = await this.#state();
        if (after.stateDigest !== before.stateDigest) stop('STALE_STATE');
      } catch (error) {
        reason = error instanceof ActionCandidateGroundingError && ['RESULT_LIMIT', 'STALE_STATE', 'UNPROVEN_FRAME', 'BROWSER_FAILURE'].includes(error.reason)
          ? error.reason as FailureReason : 'QUERY_UNEVALUABLE';
        await Promise.all(held.map((h) => h.handle.dispose())); held = [];
      }
      const now = this.#clock();
      const data = { groundingVersion: '1', observationId: `candidate-observation-${randomUUID()}`,
        testSpecId: this.#admission.spec.testSpecId, goalId: mapping.goal.id, explorationAttemptId: this.#attempt,
        sessionId: this.sessionId, pageId: before.pageId, executionProfileRef: this.#admission.spec.executionProfileRef,
        profileFingerprint: this.#session.browserSession.effectiveProfile.fingerprint,
        stateEpoch: before.stateEpoch, mutationEpoch: before.mutationEpoch, stateDigest: before.stateDigest,
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
        request: mapping.request, predicate: mapping.predicate, admissionDigest: mapping.request.handoff.admissionDigest,
        mappingDigest: hash(mapping.request.mapping), realizedObligationIds: mapping.discharged,
        pendingObligationIds: mapping.pending,
        ...(reason ? { status: 'error', complete: false, reason } :
          { status: 'complete', complete: true, count: held.length, candidates: held.map((h) => h.candidate) }) };
      const record = parseActionCandidateObservationV1({ ...data, witnessDigest: hash(data) });
      this.#captures.set(record.observationId, { record, held });
      for (const listener of this.#listeners) listener(structuredClone(record));
      return structuredClone(record);
    }, deadline);
    } finally { this.#busy = false; }
  }

  async #current(capture: Capture): Promise<State> {
    this.#owner();
    if (capture.record.status !== 'complete') stop('UNTRUSTED_EVIDENCE');
    const now = this.#clock();
    if (now < Date.parse(capture.record.observedAt) || now > Date.parse(capture.record.expiresAt)) stop('STALE_STATE');
    const state = await this.#state();
    if (capture.record.stateDigest !== state.stateDigest || capture.record.pageId !== state.pageId ||
      capture.record.stateEpoch !== state.stateEpoch || capture.record.mutationEpoch !== state.mutationEpoch) stop('STALE_STATE');
    return state;
  }
  async bind(observationInput: unknown, selectedRef: string, frameId: string): Promise<ActionCandidateBindingV1> {
    if (this.#busy) stop('BUSY'); this.#busy = true;
    try { return await this.#exclusive(async () => {
      let observation: ActionCandidateObservationV1;
      try { observation = parseActionCandidateObservationV1(observationInput); } catch { stop('UNTRUSTED_EVIDENCE'); }
      const capture = this.#captures.get(observation.observationId);
      if (!capture || !same(capture.record, observation)) stop('UNTRUSTED_EVIDENCE');
      await this.#current(capture);
      if (observation.status !== 'complete') stop('UNTRUSTED_EVIDENCE');
      if (observation.count === 0) stop('NO_CANDIDATES');
      if (!capture.held.some((h) => h.candidate.selectedRef === selectedRef && h.candidate.frameId === frameId)) stop('SELECTED_REF_NOT_MEMBER');
      if (observation.count !== 1) stop('NON_UNIQUE');
      if (this.#bindings.size >= MAX_RECORDS) stop('RESULT_LIMIT');
      const now = this.#clock();
      const data = { candidateBindingVersion: '1', bindingId: `candidate-binding-${randomUUID()}`,
        observationId: observation.observationId, selectedRef, frameId, goalId: observation.goalId,
        sessionId: this.sessionId, pageId: observation.pageId, stateDigest: observation.stateDigest,
        observationDigest: observation.witnessDigest, admissionDigest: observation.admissionDigest,
        mappingDigest: observation.mappingDigest, issuedAt: new Date(now).toISOString(), expiresAt: observation.expiresAt };
      const binding = ActionCandidateBindingV1Schema.parse({ ...data, witnessDigest: hash(data) });
      this.#bindings.set(binding.bindingId, binding); return structuredClone(binding);
    });
    } finally { this.#busy = false; }
  }

  protectedOptionRecord(observationId: string): ActionOptionObservationV1 | undefined {
    this.#owner(); const capture = this.#optionCaptures.get(observationId);
    return capture && structuredClone(capture.record);
  }
  protectedChoiceActionCheck(checkId: string): ActionChoiceActionCheckV1 | undefined {
    this.#owner(); const check = this.#choiceChecks.get(checkId); return check && structuredClone(check);
  }

  // This is a trusted code seam, never a model-supplied mapping or locator.
  async #withChoiceControl<T>(bindingInput: unknown, consume: (context: {
    binding: ActionCandidateBindingV1; capture: Capture; current: Held; state: State;
    mapping: GroundingMapping;
  }) => Promise<T>): Promise<T> {
    const parsed = ActionCandidateBindingV1Schema.safeParse(bindingInput);
    if (!parsed.success) stop('UNTRUSTED_EVIDENCE');
    const binding = parsed.data, issued = this.#bindings.get(binding.bindingId);
    if (!issued || !same(issued, binding)) stop('UNTRUSTED_EVIDENCE');
    const capture = this.#captures.get(binding.observationId)!;
    const state = await this.#current(capture), mapping = this.#request(capture.record.request);
    const argument = mapping.goal.obligations.find((o) => o.kind === 'argument');
    if (mapping.effect !== 'choose' || argument?.kind !== 'argument' || argument.purpose !== 'choice' ||
      capture.record.request.mapping.find((m) => m.obligationId === argument.id)?.kind !== 'literal') stop('UNSUPPORTED_MAPPING');
    const fresh = await this.#enumerate(state, mapping.predicate);
    try {
      if (fresh.length !== 1) stop(fresh.length ? 'NON_UNIQUE' : 'NO_CANDIDATES');
      const current = fresh[0]!, original = capture.held[0]!;
      if (current.candidate.selectedRef !== binding.selectedRef || current.candidate.frameId !== binding.frameId ||
        !await current.handle.evaluate((node, oldNode) => node === oldNode, original.handle)) stop('STALE_STATE');
      if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
      return await consume({ binding, capture, current, state, mapping });
    } finally { await Promise.all(fresh.map((h) => h.handle.dispose())); }
  }

  async #nativeOptions(control: Held, binding: Pick<ActionCandidateBindingV1, 'bindingId' | 'selectedRef' | 'frameId'>, old?: OptionCapture) {
    this.#owner();
    if (!control.candidate.nativeSelect) stop('UNSUPPORTED_CONTROL');
    await Promise.all([nativeOptionEngine, nativeOptionFactsEngine]);
    const target = control.frame.locator(`aria-ref=${binding.selectedRef}`);
    const optionLocator = target.locator('wp2b_native_options=');
    const payload = await target.locator('wp2b_native_option_facts=').textContent({ timeout: 3000 });
    if (!payload || payload.length > 262_144) stop('RESULT_LIMIT');
    const raw = nativeFactsSchema.parse(JSON.parse(payload));
    if (raw.status === 'limit') stop('RESULT_LIMIT');
    const { count, multiple } = raw;
    if (raw.options.length !== count || await optionLocator.count() !== count) stop('STALE_STATE');
    if (old && (old.record.status !== 'complete' || old.record.count !== count)) stop('STALE_STATE');
    const handles: ElementHandle[] = [];
    try {
      const options: NativeOptions['options'] = [];
      for (let index = 0; index < count; index++) {
        this.#owner();
        const option = optionLocator.nth(index), handle = await option.elementHandle();
        if (!handle) stop('QUERY_UNEVALUABLE');
        handles.push(handle);
        if (await handle.ownerFrame() !== control.frame || old &&
          !await handle.evaluate((node, prior) => node === prior, old.handles[index]!)) stop('STALE_STATE');
        const facts = raw.options[index]!;
        options.push({ optionId: old?.record.status === 'complete' ? old.record.options[index]!.optionId : `option-${randomUUID()}`,
          index, ownerBindingId: binding.bindingId, ownerRef: binding.selectedRef, ownerFrameId: binding.frameId,
          displayedLabel: facts.displayedLabel, text: facts.text, value: facts.value,
          disabled: facts.disabled, selected: facts.selected, nativeMembership: true });
      }
      if (await optionLocator.count() !== count) stop('STALE_STATE');
      if (old?.record.status === 'complete' && (!same(options, old.record.options) || multiple !== old.record.multiple)) stop('STALE_STATE');
      return { options, handles, count, multiple };
    } catch (error) { await Promise.all(handles.map((h) => h.dispose())); throw error; }
  }

  /** Bounded complete native options for an already unique WP2A-issued control binding. */
  async enumerateNativeOptions(bindingInput: unknown): Promise<ActionOptionObservationV1> {
    this.#owner(); if (this.#busy) stop('BUSY');
    if (this.#optionCaptures.size >= MAX_RECORDS) stop('RESULT_LIMIT');
    this.#busy = true;
    try { return await this.#exclusive(() => this.#withChoiceControl(bindingInput, async ({ binding, capture, current, state, mapping }) => {
      const argument = mapping.goal.obligations.find((o) => o.kind === 'argument')!;
      if (argument.kind !== 'argument') stop('INVALID_REQUEST');
      let result: NativeOptions | undefined;
      let reason: 'RESULT_LIMIT' | 'STALE_STATE' | 'QUERY_UNEVALUABLE' | 'UNSUPPORTED_CONTROL' | undefined;
      try {
        result = await this.#nativeOptions(current, binding);
        if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
      } catch (error) {
        reason = error instanceof ActionCandidateGroundingError && ['RESULT_LIMIT', 'STALE_STATE', 'UNSUPPORTED_CONTROL'].includes(error.reason)
          ? error.reason as typeof reason : 'QUERY_UNEVALUABLE';
        await Promise.all(result?.handles.map((h) => h.dispose()) ?? []); result = undefined;
      }
      const now = this.#clock();
      if (now < Date.parse(capture.record.observedAt) || now > Date.parse(binding.expiresAt)) {
        await Promise.all(result?.handles.map((h) => h.dispose()) ?? []); stop('STALE_STATE');
      }
      const data = { optionGroundingVersion: '1', observationId: `option-observation-${randomUUID()}`,
        candidateObservation: capture.record, binding, choiceObligationId: argument.id, authoredChoice: argument.authoredText,
        observedAt: new Date(now).toISOString(), expiresAt: binding.expiresAt,
        ...(reason ? { status: 'error', complete: false, reason } : { status: 'complete', complete: true,
          count: result!.count, multiple: result!.multiple, options: result!.options }) };
      const record = optionRecord({ ...data, witnessDigest: hash(data) });
      this.#optionCaptures.set(record.observationId, { record, handles: result?.handles ?? [] });
      return structuredClone(record);
    })); } catch (error) {
      if (error instanceof ActionCandidateGroundingError) throw error;
      stop('QUERY_UNEVALUABLE');
    } finally { this.#busy = false; }
  }

  /** WP2D must execute immediately inside this exclusive trusted callback and capture fresh effect afterwards. */
  async withNativeChoiceBinding<T>(bindingInput: unknown, optionInput: unknown,
    consume: (target: Locator, check: ActionChoiceActionCheckV1) => Promise<T>): Promise<T> {
    this.#owner(); if (this.#busy) stop('BUSY'); this.#busy = true;
    let consumerStarted = false;
    try { return await this.#exclusive(() => this.#withChoiceControl(bindingInput, async ({ binding, capture, current, state, mapping }) => {
      let observation: ActionOptionObservationV1;
      try { observation = parseActionOptionObservationV1(optionInput); } catch { stop('UNTRUSTED_EVIDENCE'); }
      const issued = this.#optionCaptures.get(observation.observationId);
      if (!issued || !same(issued.record, observation) || observation.status !== 'complete' ||
        !same(observation.binding, binding) || !same(observation.candidateObservation, capture.record)) stop('UNTRUSTED_EVIDENCE');
      const now = this.#clock();
      if (now < Date.parse(observation.observedAt) || now > Date.parse(observation.expiresAt)) stop('STALE_STATE');
      if (mapping.pending.some((id) => id !== observation.choiceObligationId)) stop('PENDING_OBLIGATIONS');
      const explicit = mapping.goal.obligations.find((o) => o.kind === 'operation');
      if (explicit?.kind === 'operation' && explicit.operation !== 'select_option') stop('UNSUPPORTED_OPERATION');
      if (!current.candidate.visible || !current.candidate.enabled) stop('NOT_ACTIONABLE');
      if (this.#choiceChecks.size >= MAX_RECORDS) stop('RESULT_LIMIT');
      const fresh = await this.#nativeOptions(current, binding, issued);
      try {
        const matches = fresh.options.filter((o) => o.displayedLabel === observation.authoredChoice);
        if (!matches.length) stop('OPTION_ABSENT');
        if (matches.length !== 1) stop('OPTION_NON_UNIQUE');
        const selected = matches[0]!;
        if (fresh.options.filter((o) => o.value === selected.value).length !== 1) stop('VALUE_NON_UNIQUE');
        if (selected.disabled) stop('OPTION_DISABLED');
        if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
        const { witnessDigest: _digest, ...priorData } = observation;
        const observedAt = new Date(this.#clock()).toISOString();
        if (Date.parse(observedAt) < Date.parse(observation.observedAt) || Date.parse(observedAt) > Date.parse(binding.expiresAt)) stop('STALE_STATE');
        const observedData = { ...priorData, observationId: `choice-check-observation-${randomUUID()}`, observedAt };
        const checkedObservation = optionRecord({ ...observedData, witnessDigest: hash(observedData) });
        const data = { choiceCheckVersion: '1', checkId: `choice-check-${randomUUID()}`,
          parentOptionObservationId: observation.observationId, completeOptionObservation: checkedObservation,
          selectedOptionId: selected.optionId, executableValue: selected.value, operation: 'select_option',
          realizedObligationIds: mapping.goal.obligations.map((o) => o.id), pendingObligationIds: [],
          eligibleControlCount: 1, exactLabelMatchCount: 1, executableValueMatchCount: 1 };
        const check = choiceCheck({ ...data, witnessDigest: hash(data) });
        this.#choiceChecks.set(check.checkId, structuredClone(check));
        this.#bindings.delete(binding.bindingId);
        consumerStarted = true;
        return await consume(current.frame.locator(`aria-ref=${binding.selectedRef}`), structuredClone(check));
      } finally { await Promise.all(fresh.handles.map((h) => h.dispose())); }
    })); } catch (error) {
      if (consumerStarted || error instanceof ActionCandidateGroundingError) throw error;
      stop('QUERY_UNEVALUABLE');
    } finally { this.invalidate(); this.#busy = false; }
  }

  protectedLabelAssociationRecord(observationId: string): ActionLabelAssociationObservationV1 | undefined {
    this.#owner(); const record = this.#labelCaptures.get(observationId)?.record;
    return record && structuredClone(record);
  }

  /** WP2D-A read-only conjunction. This record grants no old binding or action authority. */
  async prepareGrounding(candidateInput: unknown, mapping: TrustedGroundingMappingV1,
    operation: 'click' | 'fill' | 'select_option', deadline = Number.POSITIVE_INFINITY): Promise<PreparedActionGroundingV1> {
    return await this.#composeGrounding(candidateInput, mapping, operation, undefined, undefined, deadline) as PreparedActionGroundingV1;
  }
  async #composeGrounding(candidateInput: unknown, mapping: TrustedGroundingMappingV1,
    operation: 'click' | 'fill' | 'select_option', original?: PreparedCapture,
    execute?: (record: PreparedActionGroundingV1, current: Held, state: State, options?: NativeOptions) => Promise<ActionGroundingExecutionOutcomeV1>,
    deadline = Number.POSITIVE_INFINITY
  ): Promise<PreparedActionGroundingV1 | ActionGroundingExecutionOutcomeV1> {
    this.#owner(); if (this.#busy) stop('BUSY');
    this.#requireMapping(mapping);
    let parent: ActionCandidateObservationV1;
    try { parent = parseActionCandidateObservationV1(candidateInput); } catch { stop('UNTRUSTED_EVIDENCE'); }
    const capture = this.#captures.get(parent.observationId);
    if (!capture || !same(capture.record, parent) || parent.status !== 'complete' || parent.goalId !== mapping.goalId) stop('UNTRUSTED_EVIDENCE');
    // The caller cannot supply a smaller old predicate than the total correspondence requires.
    const expectedMapping = mapping.correspondence.map(({ obligation: o, realization: r }) => {
      if (['effect', 'operation', 'literal', 'unique', 'dependency'].includes(r.kind)) return { obligationId: o.id, kind: r.kind };
      if (r.kind === 'role_exact') return { obligationId: o.id, kind: r.kind, role: r.role };
      if (r.kind === 'name_exact') return { obligationId: o.id, kind: r.kind, name: r.name };
      return { obligationId: o.id, kind: 'pending' };
    });
    if (!same(parent.request.mapping, expectedMapping)) stop('OBLIGATION_MAPPING_MISMATCH');
    if (mapping.correspondence.some((e) => e.realization.kind === 'pending')) stop('PENDING_OBLIGATIONS');
    const base = this.#request(parent.request);
    const expectedOperation = base.effect === 'activate' ? 'click' : base.effect === 'enter_text' ? 'fill' : 'select_option';
    const explicit = base.goal.obligations.find((o) => o.kind === 'operation');
    if (operation !== expectedOperation || explicit?.kind === 'operation' && explicit.operation !== operation) stop('UNSUPPORTED_OPERATION');
    if (this.#prepared.size >= MAX_RECORDS) stop('RESULT_LIMIT');
    this.#busy = true;
    try { return await this.#exclusive(async () => {
      if (original) {
        const selected = original.held.find((h) => h.candidate.selectedRef === original.record.selectedRef && h.candidate.frameId === original.record.frameId)!;
        // Scroll/readiness is preparatory. Any mutation it causes invalidates the old parent below.
        await selected.handle.scrollIntoViewIfNeeded({ timeout: 3000 });
      }
      const state = await this.#current(capture);
      const fresh = await this.#enumerate(state, base.predicate);
      const labelHandles: ElementHandle[] = [];
      const optionHandles: ElementHandle[] = [];
      let retainHandles = false;
      try {
        if (fresh.length !== capture.held.length) stop('STALE_STATE');
        for (const current of fresh) {
          const prior = capture.held.find((h) => h.candidate.frameId === current.candidate.frameId && h.candidate.selectedRef === current.candidate.selectedRef);
          if (!prior || !await current.handle.evaluate((node, old) => node === old, prior.handle)) stop('STALE_STATE');
        }
        let eligible = fresh;
        const labelEvidence: PreparedActionGroundingV1['labelEvidence'] = [];
        const labelIdentities: { text: string; handles: ElementHandle[]; associations: PreparedActionGroundingV1['labelEvidence'][number]['associations'] }[] = [];
        for (const { obligation: o, realization: r } of mapping.correspondence) {
          if (r.kind === 'role_semantic') eligible = eligible.filter((h) => h.candidate.role === r.role);
          if (r.kind !== 'label') continue;
          const facts = await this.#labelFacts(capture, state, r.text);
          labelHandles.push(...facts.handles);
          labelIdentities.push({ text: r.text, ...facts });
          labelEvidence.push({ obligationId: o.id, text: r.text, complete: true,
            count: facts.associations.length, associations: facts.associations });
          eligible = eligible.filter((h) => facts.associations.some((a) => a.selectedRef === h.candidate.selectedRef && a.frameId === h.candidate.frameId));
        }
        if (eligible.length !== 1) stop(eligible.length ? 'NON_UNIQUE' : 'NO_CANDIDATES');
        const current = eligible[0]!, target = current.candidate;
        if (!target.visible || !target.enabled || operation === 'fill' && !target.editable) stop('NOT_ACTIONABLE');
        // Rebuild the page-wide registry after per-target enumeration before utility-world option reads.
        if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
        const strategyId = `prepared-grounding-${randomUUID()}`;
        let argument: PreparedActionGroundingV1['argument'];
        let nativeOptionEvidence: PreparedActionGroundingV1['nativeOptionEvidence'];
        let initialOptions: NativeOptions | undefined;
        const authored = base.goal.obligations.find((o) => o.kind === 'argument');
        if (authored?.kind === 'argument' && operation === 'fill') argument = { obligationId: authored.id,
          authoredText: authored.authoredText, executableValue: authored.authoredText, kind: 'entered_text' };
        if (operation === 'select_option') {
          if (authored?.kind !== 'argument' || authored.purpose !== 'choice') stop('UNSUPPORTED_MAPPING');
          // This internal owner is never issued into the old WP2A binding journal.
          const owner = { bindingId: strategyId, selectedRef: target.selectedRef, frameId: target.frameId };
          const options = await this.#nativeOptions(current, owner); optionHandles.push(...options.handles);
          initialOptions = options;
          if (options.multiple) stop('UNSUPPORTED_CONTROL');
          const matches = options.options.filter((o) => o.displayedLabel === authored.authoredText);
          if (!matches.length) stop('OPTION_ABSENT');
          if (matches.length !== 1) stop('OPTION_NON_UNIQUE');
          const selected = matches[0]!;
          if (selected.disabled) stop('OPTION_DISABLED');
          if (options.options.filter((o) => o.value === selected.value).length !== 1) stop('VALUE_NON_UNIQUE');
          nativeOptionEvidence = { complete: true, count: options.count, multiple: false,
            ownerRef: target.selectedRef, ownerFrameId: target.frameId, options: options.options };
          argument = { obligationId: authored.id, authoredText: authored.authoredText, executableValue: selected.value,
            kind: 'native_choice', optionCount: options.count, optionsDigest: hash(nativeOptionEvidence), selectedOptionId: selected.optionId };
        }
        // Renew node/source ownership after all option reads; same-markup replacement is not state equality.
        for (const prior of labelIdentities) {
          const renewed = await this.#labelFacts(capture, state, prior.text);
          try {
            if (renewed.associations.length !== prior.associations.length || renewed.handles.length !== prior.handles.length) stop('STALE_STATE');
            for (const [index, handle] of renewed.handles.entries())
              if (!await handle.evaluate((node, old) => node === old, prior.handles[index]!)) stop('STALE_STATE');
            for (const [index, association] of renewed.associations.entries()) {
              const old = prior.associations[index]!;
              if (association.selectedRef !== old.selectedRef || association.frameId !== old.frameId ||
                !same(association.sources.map((s) => s.kind), old.sources.map((s) => s.kind))) stop('STALE_STATE');
            }
          } finally { await Promise.all(renewed.handles.map((h) => h.dispose())); }
        }
        const renewed = await this.#enumerate(state, base.predicate);
        try {
          if (renewed.length !== fresh.length) stop('STALE_STATE');
          for (const h of renewed) {
            const old = fresh.find((prior) => prior.candidate.frameId === h.candidate.frameId && prior.candidate.selectedRef === h.candidate.selectedRef);
            if (!old || !await h.handle.evaluate((node, prior) => node === prior, old.handle)) stop('STALE_STATE');
          }
        } finally { await Promise.all(renewed.map((h) => h.handle.dispose())); }
        if (initialOptions) {
          if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
          const checkedOptions = await this.#nativeOptions(current, { bindingId: strategyId, selectedRef: target.selectedRef, frameId: target.frameId });
          try {
            const comparable = (options: NativeOptions) => options.options.map(({ optionId: _id, ...facts }) => facts);
            if (checkedOptions.count !== initialOptions.count || checkedOptions.multiple !== initialOptions.multiple ||
              !same(comparable(checkedOptions), comparable(initialOptions))) stop('STALE_STATE');
            for (const [index, handle] of checkedOptions.handles.entries())
              if (!await handle.evaluate((node, old) => node === old, initialOptions!.handles[index]!)) stop('STALE_STATE');
          } finally { await Promise.all(checkedOptions.handles.map((h) => h.dispose())); }
        }
        if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
        const now = this.#clock();
        if (now < Date.parse(parent.observedAt) || now > Date.parse(parent.expiresAt)) stop('STALE_STATE');
        const data = { strategyVersion: '1', status: 'prepared', executed: false, strategyId,
          goalId: parent.goalId, admissionDigest: parent.admissionDigest, mappingDigest: mapping.mappingDigest,
          sourceGoal: base.goal, sourceInstruction: this.#admission.spec.sourceInstruction,
          vocabularyVersion: mapping.vocabularyVersion, primaryPromptVersion: mapping.primaryPromptVersion, independentPromptVersion: mapping.independentPromptVersion,
          correspondence: mapping.correspondence, ...(mapping.independentExtractionDigest ? { independentExtractionDigest: mapping.independentExtractionDigest } : {}),
          candidateObservation: parent, selectedRef: target.selectedRef, frameId: target.frameId, operation,
          complete: true, eligibleCount: 1, pendingObligationIds: [], labelEvidence,
          ...(argument ? { argument } : {}), ...(nativeOptionEvidence ? { nativeOptionEvidence } : {}),
          observedAt: new Date(now).toISOString(), expiresAt: parent.expiresAt };
        const { witnessDigest: _digest, ...orderedData } = PreparedActionGroundingV1Schema.parse({ ...data, witnessDigest: hash(data) });
        const record = parsePreparedActionGroundingV1({ ...orderedData, witnessDigest: hash(orderedData) }, this.#semanticContext());
        if (original) {
          if (record.selectedRef !== original.record.selectedRef || record.frameId !== original.record.frameId ||
            hash(record.correspondence) !== hash(original.record.correspondence) || fresh.length !== original.held.length ||
            labelHandles.length !== original.labelHandles.length || optionHandles.length !== original.optionHandles.length) stop('STALE_STATE');
          for (const [index, held] of fresh.entries())
            if (!await held.handle.evaluate((node, old) => node === old, original.held[index]!.handle)) stop('STALE_STATE');
          for (const [index, handle] of labelHandles.entries())
            if (!await handle.evaluate((node, old) => node === old, original.labelHandles[index]!)) stop('STALE_STATE');
          for (const [index, handle] of optionHandles.entries())
            if (!await handle.evaluate((node, old) => node === old, original.optionHandles[index]!)) stop('STALE_STATE');
          const optionFacts = (v: PreparedActionGroundingV1) => v.nativeOptionEvidence?.options.map(({ optionId: _id, ownerBindingId: _owner, ...facts }) => facts);
          if (!same(optionFacts(record), optionFacts(original.record))) stop('STALE_STATE');
          if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
          return await execute!(record, current, state, initialOptions);
        }
        this.#prepared.set(strategyId, structuredClone(record)); this.#preparedMappings.set(strategyId, mapping);
        this.#preparedCaptures.set(strategyId, { record, held: fresh, labelHandles, optionHandles });
        retainHandles = true;
        return structuredClone(record);
      } finally {
        if (!retainHandles) await Promise.allSettled([...fresh.map((h) => h.handle), ...labelHandles, ...optionHandles].map((h) => h.dispose()));
      }
    }, deadline); } catch (error) {
      if (error instanceof ActionCandidateGroundingError) throw error;
      stop('QUERY_UNEVALUABLE');
    } finally { this.#busy = false; }
  }
  protectedPreparedGrounding(strategyId: string): PreparedActionGroundingV1 | undefined {
    this.#owner(); const record = this.#prepared.get(strategyId); return record && structuredClone(record);
  }
  /** In-process semantic authority, retained separately from serializable integrity readback. */
  protectedGroundingMapping(strategyId: string): TrustedGroundingMappingV1 | undefined {
    this.#owner(); return this.#preparedMappings.get(strategyId);
  }
  protectedActionExecution(executionId: string): ActionExecutionAttemptV1 | undefined {
    this.#owner(); const record = this.#executions.get(executionId); return record && structuredClone(record);
  }
  protectedActionPostEffect(observationId: string): ActionPostEffectV1 | undefined {
    this.#owner(); const record = this.#postEffects.get(observationId); return record && structuredClone(record);
  }
  /** Bounded private delivery diagnostics, independent of later trace-continuity capture. */
  protectedGenericClickDelivery(executionId: string) {
    this.#owner(); const receipt = this.#genericClickDeliveries.get(executionId);
    return receipt && structuredClone(receipt);
  }
  protectedActionGroundingFinalCheck(executionId: string): PreparedActionGroundingV1 | undefined {
    this.#owner(); const record = this.#executionChecks.get(executionId); return record && structuredClone(record);
  }
  protectedActionGroundingWitness(witnessId: string): ActionGroundingWitnessV1 | undefined {
    this.#owner(); const record = this.#groundingWitnesses.get(witnessId); return record && structuredClone(record);
  }

  /** Distinct action route. The runtime owns operation, argument, dispatch and effect truth. */
  async executePreparedGrounding(input: unknown, deadline = Number.POSITIVE_INFINITY): Promise<ActionGroundingExecutionOutcomeV1> {
    this.#owner(); if (this.#busy) stop('BUSY');
    let preparation: PreparedActionGroundingV1;
    try { preparation = parsePreparedActionGroundingV1(input, this.#semanticContext()); } catch { stop('UNTRUSTED_EVIDENCE'); }
    const original = this.#preparedCaptures.get(preparation.strategyId);
    const mapping = this.#preparedMappings.get(preparation.strategyId);
    if (!original || !mapping || !same(preparation, original.record) || this.#consumedPreparations.has(preparation.strategyId)) stop('UNTRUSTED_EVIDENCE');
    this.#requireMapping(mapping);
    if (this.#executions.size >= MAX_RECORDS || this.#groundingWitnesses.size >= MAX_RECORDS) stop('RESULT_LIMIT');
    this.#consumedPreparations.add(preparation.strategyId);
    const executionId = `grounding-execution-${randomUUID()}`, startedAt = new Date(this.#clock()).toISOString();
    const ledger = (status: ActionExecutionAttemptV1['status'], reason: string, invocationOutcome: ActionExecutionAttemptV1['invocationOutcome'],
      check?: PreparedActionGroundingV1, invokedAt?: string, returnedAt?: string, post?: ActionPostEffectV1, commit = true) => {
      const delivery = this.#genericClickDeliveries.get(executionId);
      const data = { executionVersion: '1', executionId, strategyId: preparation.strategyId, preparedDigest: preparation.witnessDigest,
        admissionDigest: preparation.admissionDigest, mappingDigest: preparation.mappingDigest, goalId: preparation.goalId,
        status, reason, attempted: invocationOutcome !== 'not_invoked', mutationMayHaveOccurred: invocationOutcome !== 'not_invoked',
        invocationOutcome, operation: preparation.operation, ...(preparation.argument ? { executableArgument: preparation.argument.executableValue } : {}),
        startedAt, finishedAt: new Date(this.#clock()).toISOString(), ...(invokedAt ? { invokedAt } : {}), ...(returnedAt ? { returnedAt } : {}),
        ...(delivery ? { genericClickDelivery: { stepId: delivery.stepId, role: delivery.role, accessibleName: delivery.accessibleName,
          dispatched: delivery.dispatched, returned: delivery.returned, elapsedMs: delivery.elapsedMs } } : {}),
        ...(check ? { finalCheckDigest: check.witnessDigest } : {}), ...(post ? { postEffectDigest: post.witnessDigest } : {}) };
      const { witnessDigest: _digest, ...ordered } = ActionExecutionAttemptV1Schema.parse({ ...data, witnessDigest: hash(data) });
      const record = parseActionExecutionAttemptV1({ ...ordered, witnessDigest: hash(ordered) });
      if (commit) this.#executions.set(executionId, structuredClone(record)); return record;
    };
    let invocation: { check: PreparedActionGroundingV1; invokedAt: string; returnedAt?: string } | undefined;
    try {
      return await this.#composeGrounding(preparation.candidateObservation, mapping, preparation.operation, original,
        async (check, current, before, options) => {
          let activation: { role: 'checkbox' | 'radio'; checked: boolean } | undefined;
          const genericClick = check.operation === 'click' && check.sourceGoal.sourceMode === 'semantic_poc' &&
            current.candidate.role !== 'checkbox' && current.candidate.role !== 'radio';
          let nativeTextControl: 'input' | 'textarea' | undefined;
          if (check.operation === 'fill') {
            const ref = current.frame.locator(`aria-ref=${check.selectedRef}`);
            for (const kind of ['input', 'textarea'] as const)
              if (await ref.and(current.frame.locator(kind)).count() === 1) nativeTextControl = kind;
            if (!nativeTextControl) stop('UNSUPPORTED_CONTROL');
          }
          if (check.operation === 'click' && !genericClick) {
            const role = current.candidate.role;
            if (role !== 'checkbox' && role !== 'radio' || await current.frame.locator(`input[type=${role}]`).and(current.frame.locator(`aria-ref=${check.selectedRef}`)).count() !== 1)
              stop('UNSUPPORTED_OPERATION');
            const checked = await current.handle.isChecked();
            if (role === 'radio' && checked) stop('UNSUPPORTED_OPERATION');
            activation = { role, checked };
            const armed = await nativeActivationReceipt(current.handle, executionId, 'arm');
            if (armed.nativeInputType !== role || armed.clicks !== 0) stop('UNSUPPORTED_CONTROL');
          }
          if ((await this.#state()).stateDigest !== before.stateDigest) stop('STALE_STATE');
          // Retained node actions cannot retarget a replacement. Force avoids actionability waits;
          // scroll/readiness already ran before the complete conjunction was renewed.
          const invokedAt = new Date(this.#clock()).toISOString();
          this.#owner();
          if (this.#clock() < Date.parse(check.observedAt) || this.#clock() > Date.parse(check.expiresAt)) stop('STALE_STATE');
          invocation = { check, invokedAt };
          this.#executionChecks.set(executionId, structuredClone(check));
          const dispatchStarted = this.#clock();
          try {
            if (check.operation === 'fill') await current.handle.fill(check.argument!.executableValue, { force: true, timeout: 3000 });
            else if (check.operation === 'select_option') await current.handle.selectOption({ value: check.argument!.executableValue }, { force: true, timeout: 3000 });
            else if (genericClick) await current.handle.click({ force: true,
              timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) });
            else await current.handle.click({ force: true, timeout: 3000, noWaitAfter: true });
          } catch {
            this.invalidate();
            return { status: 'stop', execution: ledger('failed', 'ACTION_FAILED_PARTIAL_OR_UNKNOWN', 'threw', check, invokedAt) };
          }
          const returnedAt = new Date(this.#clock()).toISOString();
          invocation.returnedAt = returnedAt;
          const genericDelivery = genericClick ? { executionId, stepId: check.goalId, clicks: 1 as const,
            targetOwned: true as const, dispatched: true as const, returned: true as const,
            elapsedMs: Math.min(120_000, Math.max(0, this.#clock() - dispatchStarted)) } : undefined;
          if (genericDelivery) this.#genericClickDeliveries.set(executionId, { stepId: check.goalId,
            role: current.candidate.role, accessibleName: current.candidate.accessibleName,
            dispatched: true, returned: true, elapsedMs: genericDelivery.elapsedMs });
          this.invalidate();
          let post: ActionPostEffectV1;
          try {
            // Generic PoC click delivery is complete when Playwright returns. A navigating
            // document may be unavailable here; the next authored step observes it afresh.
            const after = genericClick ? undefined : await this.#state();
            if (after && (after.page !== before.page || after.pageId !== before.pageId || !after.frames.includes(current.frame))) stop('STALE_STATE');
            let sameTargetNode = false;
            if (after?.frames.includes(current.frame)) {
              try {
                const target = current.frame.locator(`aria-ref=${check.selectedRef}`);
                if (await target.count() === 1) {
                  const handle = await target.elementHandle();
                  try { sameTargetNode = !!handle && await handle.ownerFrame() === current.frame &&
                    await handle.evaluate((node, old) => node === old, current.handle); }
                  finally { await handle?.dispose(); }
                }
              } catch { if (!genericClick) stop('STALE_STATE'); }
            }
            if (!genericClick && !sameTargetNode) stop('STALE_STATE');
            let effect: ActionPostEffectV1['effect'];
            if (check.operation === 'fill') {
              const value = await current.handle.inputValue({ timeout: 3000 });
              if (value !== check.argument!.authoredText) stop('UNSUPPORTED_OPERATION');
              effect = { kind: 'entered_text', nativeControl: nativeTextControl!, value };
            } else if (check.operation === 'select_option') {
              const renewed = await this.#nativeOptions(current, { bindingId: check.strategyId, selectedRef: check.selectedRef, frameId: check.frameId });
              try {
                if (!options || renewed.multiple || renewed.count !== options.count) stop('STALE_STATE');
                for (const [index, handle] of renewed.handles.entries())
                  if (!await handle.evaluate((node, old) => node === old, options!.handles[index]!)) stop('STALE_STATE');
                const mapped = renewed.options.map((o, index) => ({ ...o, optionId: options!.options[index]!.optionId }));
                const comparable = (v: NativeOptions['options']) => v.map(({ selected: _selected, ...facts }) => facts);
                if (!same(comparable(mapped), comparable(options.options))) stop('STALE_STATE');
                const selected = mapped.filter((o) => o.selected);
                if (selected.length !== 1 || selected[0]!.optionId !== check.argument!.selectedOptionId || selected[0]!.value !== check.argument!.executableValue || selected[0]!.disabled)
                  stop('UNSUPPORTED_OPERATION');
                effect = { kind: 'native_choice', value: selected[0]!.value, selectedOptionId: selected[0]!.optionId,
                  options: { complete: true, count: renewed.count, multiple: false, ownerRef: check.selectedRef, ownerFrameId: check.frameId, options: mapped } };
              } finally { await Promise.all(renewed.handles.map((h) => h.dispose())); }
            } else if (genericClick) {
              effect = { kind: 'generic_activation', role: current.candidate.role,
                accessibleName: current.candidate.accessibleName, delivery: genericDelivery! };
            } else {
              const checked = await current.handle.isChecked();
              const receipt = await nativeActivationReceipt(current.handle, executionId, 'read');
              if (!activation || receipt.clicks !== 1 || receipt.nativeInputType !== activation.role ||
                activation.role === 'checkbox' && checked === activation.checked || activation.role === 'radio' && !checked) stop('UNSUPPORTED_OPERATION');
              effect = { kind: 'native_activation', role: activation!.role, nativeInputType: activation!.role, beforeChecked: activation!.checked, checked,
                trustedClickReceipt: { executionId, clicks: 1, targetOwned: true, nativeInputType: receipt.nativeInputType } };
            }
            if (after && (await this.#state()).stateDigest !== after.stateDigest) stop('STALE_STATE');
            if (!genericClick) {
              const renewedTarget = await current.frame.locator(`aria-ref=${check.selectedRef}`).elementHandle({ timeout: 3000 });
              try { if (!renewedTarget || !await renewedTarget.evaluate((node, old) => node === old, current.handle)) stop('STALE_STATE'); }
              finally { await renewedTarget?.dispose(); }
            }
            const owner = (s: State) => ({ sessionId: this.sessionId, pageId: s.pageId, frameId: check.frameId,
              stateDigest: s.stateDigest, stateEpoch: s.stateEpoch, mutationEpoch: s.mutationEpoch });
            const data = { postEffectVersion: '1', observationId: `grounding-post-effect-${randomUUID()}`, executionId,
              preparedDigest: check.witnessDigest, selectedRef: check.selectedRef, sameTargetNode, complete: true,
              before: owner(before), ...(after ? { after: owner(after) } : {}),
              observedAt: new Date(this.#clock()).toISOString(), effect };
            const { witnessDigest: _digest, ...ordered } = ActionPostEffectV1Schema.parse({ ...data, witnessDigest: hash(data) });
            post = parseActionPostEffectV1({ ...ordered, witnessDigest: hash(ordered) });
          } catch {
            return { status: 'stop', execution: ledger('executed_unproven', genericClick ? 'BROWSER_FAILURE' : 'POST_EFFECT_UNPROVEN',
              'returned', check, invokedAt, returnedAt) };
          }
          const execution = ledger('succeeded', genericClick ? 'DELIVERY_PROVEN' : 'EFFECT_PROVEN',
            'returned', check, invokedAt, returnedAt, post, false);
          const data = { actionGroundingWitnessVersion: '1', witnessId: `action-grounding-witness-${randomUUID()}`, status: 'succeeded',
            preparation, finalCheck: check, execution, postEffect: post };
          const { witnessDigest: _digest, ...ordered } = ActionGroundingWitnessV1Schema.parse({ ...data, witnessDigest: hash(data) });
          const witness = parseActionGroundingWitnessV1({ ...ordered, witnessDigest: hash(ordered) }, this.#semanticContext());
          this.#postEffects.set(post.observationId, structuredClone(post)); this.#groundingWitnesses.set(witness.witnessId, structuredClone(witness));
          this.#executions.set(executionId, structuredClone(execution));
          return { status: 'succeeded', execution, witness };
        }, deadline) as ActionGroundingExecutionOutcomeV1;
    } catch (error) {
      const existing = this.#executions.get(executionId);
      if (existing?.attempted) {
        if (existing.status === 'succeeded') {
          for (const [id, witness] of this.#groundingWitnesses) if (witness.execution.executionId === executionId) {
            this.#postEffects.delete(witness.postEffect.observationId); this.#groundingWitnesses.delete(id);
          }
          return { status: 'stop', execution: ledger('executed_unproven', this.#genericClickDeliveries.has(executionId) ? 'BROWSER_FAILURE' : 'POST_EFFECT_UNPROVEN', 'returned',
            this.#executionChecks.get(executionId), existing.invokedAt, existing.returnedAt) };
        }
        return { status: 'stop', execution: existing };
      }
      if (invocation) return { status: 'stop', execution: ledger(invocation.returnedAt ? 'executed_unproven' : 'failed',
        invocation.returnedAt ? this.#genericClickDeliveries.has(executionId) ? 'BROWSER_FAILURE' : 'POST_EFFECT_UNPROVEN' : 'ACTION_FAILED_PARTIAL_OR_UNKNOWN', invocation.returnedAt ? 'returned' : 'threw',
        invocation.check, invocation.invokedAt, invocation.returnedAt) };
      return { status: 'stop', execution: ledger('rejected', error instanceof ActionCandidateGroundingError ? error.reason : 'QUERY_UNEVALUABLE', 'not_invoked') };
    } finally {
      const postState = this.#lastCapturedState;
      this.invalidate();
      if (preparation.operation === 'click' && original.held.some((h) =>
        h.candidate.selectedRef === preparation.selectedRef && h.candidate.frameId === preparation.frameId &&
        (h.candidate.role === 'checkbox' || h.candidate.role === 'radio'))) {
        const selected = original.held.find((h) => h.candidate.selectedRef === preparation.selectedRef && h.candidate.frameId === preparation.frameId);
        if (selected) await nativeActivationReceipt(selected.handle, executionId, 'clear').catch(() => {});
      }
      const successful = [...this.#groundingWitnesses.values()].find((w) => w.execution.executionId === executionId);
      if (successful && postState && successful.postEffect.effect.kind !== 'generic_activation') {
        try {
          await this.#exclusive(async () => {
          const after = await this.#state();
           const effect = successful.postEffect.effect;
           const selected = original.held.find((h) => h.candidate.selectedRef === successful.finalCheck.selectedRef && h.candidate.frameId === successful.finalCheck.frameId);
           const renewed = effect.kind === 'generic_activation' ? undefined :
             await selected?.frame.locator(`aria-ref=${successful.finalCheck.selectedRef}`).elementHandle({ timeout: 3000 });
           try {
             if ((effect.kind !== 'generic_activation' && (!selected || !renewed || !await renewed.evaluate((node, held) => node === held, selected.handle))) ||
               postState.stateDigest !== successful.postEffect.after!.stateDigest || postState.materialDigest !== after.materialDigest ||
               postState.page !== after.page || postState.frames.some((f, i) => after.frames[i] !== f) || postState.frames.length !== after.frames.length)
               stop('STALE_STATE');
             if (effect.kind === 'entered_text' && await selected!.handle.inputValue() !== effect.value ||
               effect.kind === 'native_activation' && await selected!.handle.isChecked() !== effect.checked) stop('STALE_STATE');
            if (effect.kind === 'native_choice') {
              const currentOptions = await this.#nativeOptions(selected!, { bindingId: successful.finalCheck.strategyId,
                selectedRef: successful.finalCheck.selectedRef, frameId: successful.finalCheck.frameId });
              try {
                if (currentOptions.multiple || currentOptions.count !== effect.options.count) stop('STALE_STATE');
                for (const [i, option] of currentOptions.options.entries()) {
                  const expected = effect.options.options[i]!;
                  if (!same({ ...option, optionId: expected.optionId }, expected) ||
                    !await currentOptions.handles[i]!.evaluate((node, held) => node === held, original.optionHandles[i]!)) stop('STALE_STATE');
                }
              } finally { await Promise.allSettled(currentOptions.handles.map((h) => h.dispose())); }
            }
             if ((await this.#state()).stateDigest !== after.stateDigest ||
               effect.kind !== 'generic_activation' && !await renewed!.evaluate((node, held) => node === held, selected!.handle)) stop('STALE_STATE');
          } finally { await renewed?.dispose(); }
          const data = { retirementVersion: '1', witnessId: successful.witnessId, postEffectDigest: successful.postEffect.witnessDigest,
            before: successful.postEffect.after, after: { sessionId: this.sessionId, pageId: after.pageId, frameId: successful.finalCheck.frameId,
              stateDigest: after.stateDigest, stateEpoch: after.stateEpoch, mutationEpoch: after.mutationEpoch },
            unchangedMaterial: true, retiredBinding: true, observedAt: new Date(this.#clock()).toISOString() };
          const { witnessDigest: _digest, ...ordered } = ActionGroundingRetirementV1Schema.parse({ ...data, witnessDigest: hash(data) });
          this.#groundingRetirements.set(successful.witnessId, parseActionGroundingRetirementV1({ ...ordered, witnessDigest: hash(ordered) }));
          }, deadline);
        } catch { /* Successful effect remains historical; no trace-currentness receipt is issued. */ }
      }
      await Promise.allSettled([...original.held.map((h) => h.handle), ...original.labelHandles, ...original.optionHandles].map((h) => h.dispose()));
      this.#preparedCaptures.delete(preparation.strategyId);
    }
  }
  protectedLabelAssociationCheck(checkId: string): ActionLabelAssociationCheckV1 | undefined {
    this.#owner(); const record = this.#labelChecks.get(checkId); return record && structuredClone(record);
  }
  async #labelFacts(capture: Capture, state: State, authoredLabel: string, old?: LabelCapture) {
    const fresh = await this.#enumerate(state, this.#request(capture.record.request).predicate);
    const handles: ElementHandle[] = [];
    const associations: Extract<ActionLabelAssociationObservationV1, { status: 'complete' }>['associations'] = [];
    try {
      // Per-target snapshots leave only the last subtree current in Playwright's aria-ref registry.
      // Refresh the full page/frame registry before reading every candidate; refs remain node-correlated.
      if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
      if (fresh.length !== capture.held.length) stop('STALE_STATE');
      for (const current of fresh) {
        this.#owner();
        const original = capture.held.find((h) => h.candidate.frameId === current.candidate.frameId && h.candidate.selectedRef === current.candidate.selectedRef);
        if (!original || !await current.handle.evaluate((node, prior) => node === prior, original.handle)) stop('STALE_STATE');
        const sources = await readOwnedLabelSources(current.frame, current.candidate.selectedRef, authoredLabel, current.candidate.role, () => {
          this.#owner(); if (this.#clock() > Date.parse(capture.record.expiresAt)) stop('STALE_STATE');
        });
        if (!sources.length) continue;
        handles.push(...sources.map((s) => s.handle));
        const previous = old?.record.status === 'complete' ? old.record.associations[associations.length] : undefined;
        const previousOffset = old?.record.status === 'complete' ? old.record.associations.slice(0, associations.length).reduce((sum, a) => sum + a.sources.length, 0) : 0;
        for (const [index, source] of sources.entries()) {
          if (old && (!previous || previous.sources.length !== sources.length ||
            !await source.handle.evaluate((node, prior) => node === prior, old.handles[previousOffset + index]!))) stop('STALE_STATE');
        }
        associations.push({ selectedRef: current.candidate.selectedRef, frameId: current.candidate.frameId,
          accessibleName: current.candidate.accessibleName,
          accessibleNameEqualsAuthoredLabel: current.candidate.accessibleName === authoredLabel,
          exactLabelCorrespondence: true, sources: sources.map((source, index) => ({ sourceId: previous?.sources[index]?.sourceId ?? `label-source-${randomUUID()}`,
            kind: source.kind, ownerRef: current.candidate.selectedRef, ownerFrameId: current.candidate.frameId, nativeOrIdrefOwnership: true as const })) });
      }
      if (old?.record.status === 'complete' && !same(associations, old.record.associations)) stop('STALE_STATE');
      if ((await this.#state()).stateDigest !== state.stateDigest) stop('STALE_STATE');
      return { associations, handles };
    } catch (error) {
      await Promise.all(handles.map((h) => h.dispose()));
      if (error instanceof ActionCandidateGroundingError) throw error;
      if (error instanceof Error && error.message === 'LABEL_RESULT_LIMIT') stop('RESULT_LIMIT');
      if (error instanceof Error && error.message === 'LABEL_UNSUPPORTED_CONTROL') stop('UNSUPPORTED_CONTROL');
      if (error instanceof Error && error.message === 'LABEL_STALE_STATE') stop('STALE_STATE');
      stop('QUERY_UNEVALUABLE');
    } finally { await Promise.all(fresh.map((h) => h.handle.dispose())); }
  }

  /** Complete association facts over an issued WP2A domain. Raw context remains pending semantic endorsement. */
  async queryLabelAssociations(candidateInput: unknown, requestInput: unknown): Promise<ActionLabelAssociationObservationV1> {
    this.#owner(); if (this.#busy) stop('BUSY');
    const request = ActionLabelAssociationRequestV1Schema.safeParse(requestInput);
    if (!request.success) stop('INVALID_REQUEST');
    let parent: ActionCandidateObservationV1;
    try { parent = parseActionCandidateObservationV1(candidateInput); } catch { stop('UNTRUSTED_EVIDENCE'); }
    const capture = this.#captures.get(parent.observationId);
    if (!capture || !same(capture.record, parent) || parent.status !== 'complete') stop('UNTRUSTED_EVIDENCE');
    const mapping = this.#request(parent.request), obligation = mapping.goal.obligations.find((o) => o.id === request.data.obligationId);
    if (!obligation || obligation.kind !== 'constraint' || !['name', 'context'].includes(obligation.constraint) ||
      obligation.subject.kind !== 'target' || obligation.polarity !== 'positive' || obligation.authoredText.length > 512) stop('UNSUPPORTED_MAPPING');
    if (this.#labelCaptures.size >= MAX_RECORDS) stop('RESULT_LIMIT');
    this.#busy = true;
    try { return await this.#exclusive(async () => {
      const state = await this.#current(capture);
      let result: { associations: Extract<ActionLabelAssociationObservationV1, { status: 'complete' }>['associations']; handles: ElementHandle[] } | undefined;
      let reason: Extract<ActionLabelAssociationObservationV1, { status: 'error' }>['reason'] | undefined;
      try { result = await this.#labelFacts(capture, state, obligation.authoredText); }
      catch (error) { reason = error instanceof ActionCandidateGroundingError &&
        ['RESULT_LIMIT', 'STALE_STATE', 'UNSUPPORTED_CONTROL'].includes(error.reason)
        ? error.reason as typeof reason : 'QUERY_UNEVALUABLE'; }
      const now = this.#clock();
      if (now < Date.parse(parent.observedAt) || now > Date.parse(parent.expiresAt)) {
        await Promise.all(result?.handles.map((h) => h.dispose()) ?? []); stop('STALE_STATE');
      }
      const realized = [...parent.realizedObligationIds];
      if (!reason && result!.associations.length === 1 && obligation.constraint === 'name' && !realized.includes(obligation.id)) realized.push(obligation.id);
      const pending = parent.request.mapping.map((m) => m.obligationId).filter((id) => !realized.includes(id));
      const data = { labelGroundingVersion: '1', observationId: `label-observation-${randomUUID()}`,
        candidateObservation: parent, request: request.data, sourceObligation: obligation, authoredLabel: obligation.authoredText,
        observedAt: new Date(now).toISOString(), expiresAt: parent.expiresAt, realizedObligationIds: realized, pendingObligationIds: pending,
        ...(reason ? { status: 'error', complete: false, reason } : { status: 'complete', complete: true,
          count: result!.associations.length, associations: result!.associations }) };
      const record = parseActionLabelAssociationObservationV1({ ...data, witnessDigest: hash(data) });
      this.#labelCaptures.set(record.observationId, { record, handles: result?.handles ?? [] }); return structuredClone(record);
    }); } finally { this.#busy = false; }
  }

  #issuedLabel(input: unknown) {
    let record: ActionLabelAssociationObservationV1;
    try { record = parseActionLabelAssociationObservationV1(input); } catch { stop('UNTRUSTED_EVIDENCE'); }
    const issued = this.#labelCaptures.get(record.observationId);
    if (!issued || !same(issued.record, record) || record.status !== 'complete') stop('UNTRUSTED_EVIDENCE');
    return { issued, record, capture: this.#captures.get(record.candidateObservation.observationId)! };
  }
  async bindLabelAssociation(input: unknown, selectedRef: string, frameId: string): Promise<ActionLabelAssociationBindingV1> {
    this.#owner(); if (this.#busy) stop('BUSY'); this.#busy = true;
    try { return await this.#exclusive(async () => {
      const { issued, record, capture } = this.#issuedLabel(input), state = await this.#current(capture);
      if (!record.associations.some((a) => a.selectedRef === selectedRef && a.frameId === frameId)) stop('SELECTED_REF_NOT_MEMBER');
      if (record.count !== 1) stop('NON_UNIQUE');
      if (this.#labelBindings.size >= MAX_RECORDS) stop('RESULT_LIMIT');
      const facts = await this.#labelFacts(capture, state, record.authoredLabel, issued);
      try {
        const current = capture.held.find((h) => h.candidate.selectedRef === selectedRef && h.candidate.frameId === frameId)!;
        const target = current.frame.locator(`aria-ref=${selectedRef}`);
        if (!await target.isVisible() || !await target.isEnabled()) stop('NOT_ACTIONABLE');
        const now = this.#clock(); if (now > Date.parse(record.expiresAt) || now < Date.parse(record.observedAt)) stop('STALE_STATE');
        const parent = record.candidateObservation;
        const data = { labelBindingVersion: '1', bindingId: `label-binding-${randomUUID()}`, observationId: record.observationId,
          observationDigest: record.witnessDigest, selectedRef, frameId, sessionId: parent.sessionId, pageId: parent.pageId,
          goalId: parent.goalId, stateDigest: parent.stateDigest, admissionDigest: parent.admissionDigest, mappingDigest: parent.mappingDigest,
          issuedAt: new Date(now).toISOString(), expiresAt: record.expiresAt };
        const binding = ActionLabelAssociationBindingV1Schema.parse({ ...data, witnessDigest: hash(data) });
        this.#labelBindings.set(binding.bindingId, binding); return structuredClone(binding);
      } finally { await Promise.all(facts.handles.map((h) => h.dispose())); }
    }); } finally { this.#busy = false; }
  }

  /** Protected fresh association/readiness only; WP2D still owes total endorsed predicate and action correspondence. */
  async withLabelAssociationBinding<T>(input: unknown, consume: (check: ActionLabelAssociationCheckV1) => Promise<T>): Promise<T> {
    this.#owner(); if (this.#busy) stop('BUSY'); this.#busy = true;
    let consumerStarted = false;
    try { return await this.#exclusive(async () => {
      const parsed = ActionLabelAssociationBindingV1Schema.safeParse(input);
      if (!parsed.success) stop('UNTRUSTED_EVIDENCE');
      const binding = parsed.data;
      if (!same(this.#labelBindings.get(binding.bindingId), binding)) stop('UNTRUSTED_EVIDENCE');
      const { issued, record, capture } = this.#issuedLabel(this.#labelCaptures.get(binding.observationId)?.record);
      const state = await this.#current(capture);
      const facts = await this.#labelFacts(capture, state, record.authoredLabel, issued);
      try {
        if (facts.associations.length !== 1 || facts.associations[0]!.selectedRef !== binding.selectedRef || facts.associations[0]!.frameId !== binding.frameId) stop('NON_UNIQUE');
        const current = capture.held.find((h) => h.candidate.selectedRef === binding.selectedRef && h.candidate.frameId === binding.frameId)!;
        const target = current.frame.locator(`aria-ref=${binding.selectedRef}`);
        if (!await target.isVisible() || !await target.isEnabled()) stop('NOT_ACTIONABLE');
        const now = this.#clock(); if (now < Date.parse(record.observedAt) || now > Date.parse(binding.expiresAt)) stop('STALE_STATE');
        if (this.#labelChecks.size >= MAX_RECORDS) stop('RESULT_LIMIT');
        const { witnessDigest: _digest, ...prior } = record;
        const observedData = { ...prior, observationId: `label-check-observation-${randomUUID()}`, observedAt: new Date(now).toISOString() };
        const observation = parseActionLabelAssociationObservationV1({ ...observedData, witnessDigest: hash(observedData) });
        const data = { labelCheckVersion: '1', checkId: `label-check-${randomUUID()}`, binding,
          parentAssociationObservationId: record.observationId, completeAssociationObservation: observation,
          eligibleAssociationCount: 1, selectedReferenceMatches: true };
        const check = parseActionLabelAssociationCheckV1({ ...data, witnessDigest: hash(data) });
        this.#labelChecks.set(check.checkId, structuredClone(check)); this.#labelBindings.delete(binding.bindingId);
        consumerStarted = true; return await consume(structuredClone(check));
      } finally { await Promise.all(facts.handles.map((h) => h.dispose())); }
    }); } catch (error) {
      if (consumerStarted || error instanceof ActionCandidateGroundingError) throw error; stop('QUERY_UNEVALUABLE');
    } finally { this.invalidate(); this.#busy = false; }
  }

  /** WP2D bridge: consume a fresh check inside the exclusive callback, never as cached action authority.
   * The callback is trusted runtime code, not model data. Choice/relationships remain blocked in WP2A. */
  async withActionTimeBinding<T>(bindingInput: unknown, operation: 'click' | 'fill' | 'select_option',
    consume: (target: Locator, evidence: ActionCandidateActionCheckV1) => Promise<T>): Promise<T> {
    this.#owner(); if (this.#busy) stop('BUSY'); this.#busy = true;
    try { return await this.#exclusive(async () => {
      const parsed = ActionCandidateBindingV1Schema.safeParse(bindingInput);
      if (!parsed.success) stop('UNTRUSTED_EVIDENCE');
      const binding = parsed.data, issued = this.#bindings.get(binding.bindingId);
      if (!issued || !same(issued, binding)) stop('UNTRUSTED_EVIDENCE');
      const capture = this.#captures.get(binding.observationId)!;
      const state = await this.#current(capture);
      const mapping = this.#request(capture.record.request);
      if (mapping.pending.length) stop('PENDING_OBLIGATIONS');
      if (this.#checks.size >= MAX_RECORDS) stop('RESULT_LIMIT');
      const expected = mapping.effect === 'activate' ? 'click' : mapping.effect === 'enter_text' ? 'fill' : 'select_option';
      const explicit = mapping.goal.obligations.find((o) => o.kind === 'operation');
      if (operation !== expected || explicit?.kind === 'operation' && operation !== explicit.operation) stop('UNSUPPORTED_OPERATION');
      const fresh = await this.#enumerate(state, mapping.predicate);
      try {
        if (fresh.length !== 1) stop(fresh.length ? 'NON_UNIQUE' : 'NO_CANDIDATES');
        const current = fresh[0]!, original = capture.held[0]!;
        if (current.candidate.selectedRef !== binding.selectedRef || current.candidate.frameId !== binding.frameId ||
          !await current.handle.evaluate((node, oldNode) => node === oldNode, original.handle)) stop('STALE_STATE');
        if (!current.candidate.visible || !current.candidate.enabled || operation === 'fill' && !current.candidate.editable) stop('NOT_ACTIONABLE');
        if (operation === 'select_option') stop('PENDING_OBLIGATIONS');
        const after = await this.#state();
        if (after.stateDigest !== state.stateDigest) stop('STALE_STATE');
        this.#bindings.delete(binding.bindingId);
        const target = current.frame.locator(`aria-ref=${binding.selectedRef}`);
        const now = this.#clock();
        const { witnessDigest: _oldDigest, ...originalData } = capture.record as Complete;
        const observationData = { ...originalData, observationId: `action-check-observation-${randomUUID()}`,
          observedAt: new Date(now).toISOString(), expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
          candidates: fresh.map((h) => h.candidate), count: 1 };
        const observation = parseActionCandidateObservationV1({ ...observationData, witnessDigest: hash(observationData) });
        const argument = mapping.goal.obligations.find((o) => o.kind === 'argument');
        const data = { actionCheckVersion: '1', checkId: `action-check-${randomUUID()}`, bindingId: binding.bindingId,
          parentObservationId: capture.record.observationId, operation,
          ...(argument?.kind === 'argument' ? { authoredArgument: { purpose: argument.purpose, text: argument.authoredText } } : {}),
          completeCandidateObservation: observation, selectedReferenceMatches: true, eligibleMatchCount: 1 };
        const check = parseActionCandidateActionCheckV1({ ...data, witnessDigest: hash(data) });
        this.#checks.set(check.checkId, structuredClone(check));
        return await consume(target, structuredClone(check));
      } finally { await Promise.all(fresh.map((h) => h.handle.dispose())); }
    });
    } finally { this.invalidate(); this.#busy = false; }
  }
}
