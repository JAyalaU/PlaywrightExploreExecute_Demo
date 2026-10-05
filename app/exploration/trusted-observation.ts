import { createHash, randomUUID } from 'node:crypto';
import type { Frame, Locator, Page } from '@playwright/test';
import { TrustedObservationRequestV1Schema, TrustedObservationResultV1Schema,
  type SemanticObservationQueryV1, type TrustedObservationRequestV1,
  type TrustedObservationResultV1 } from '../domain/index.js';
import { ExploratoryTargetResolutionError, type CurrentStateExploration } from './current-state.js';
import type { McpExplorationSession } from './mcp.js';
import { ActionCandidateGroundingSessionV1 } from './action-candidate-grounding.js';
import { probeVerificationObservation, type PrivateObservationProbe } from './verification-observation-diagnostics.js';

const MAX_FRAMES = 8;
const MAX_IFRAMES_PER_LEVEL = 80;
const MAX_SNAPSHOT = 131_072;
const MAX_DOCUMENT = 262_144;
const MAX_COUNT = 10_000;
const MAX_OBSERVATIONS = 80;

type Reason = Extract<TrustedObservationResultV1, { status: 'error' }>['reason'];
type FrameProof = TrustedObservationResultV1['frame'];
type ObservationOutcome = { status: 'complete'; result: Extract<TrustedObservationResultV1,
  { status: 'complete' }>['result'] } | { status: 'error'; reason: Reason; observedMatchCount?: number };
type State = { page: Page; pageId: string; stateEpoch: number; mutationEpoch: number;
  stateDigest: string; frameDigests: Map<Frame, string> };

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Rebuilds WP2's fixed runtime-construction preimage, including field order. */
export { parseTrustedObservationWitnessV1 as verifyTrustedObservationWitnessV1 } from '../domain/observation-contracts.js';
class ObservationFailure extends Error {
  constructor(readonly reason: Reason, readonly observedMatchCount?: number) { super(reason); }
}

/** Private, read-only facts from one protected exploratory session. Not a model tool by itself. */
export class TrustedObservationSessionV1 {
  readonly #session: McpExplorationSession;
  readonly #current: CurrentStateExploration | ActionCandidateGroundingSessionV1;
  readonly #owner: { testSpecId: string; explorationAttemptId: string; sessionId: string;
    executionProfileRef: { id: string; version: string }; profileFingerprint: string };
  readonly #pageIds = new WeakMap<Page, string>();
  readonly #records = new Map<string, TrustedObservationResultV1>();
  readonly #captureListeners = new Set<(record: TrustedObservationResultV1) => void>();
  readonly #privateAttemptListeners = new Set<(probe: PrivateObservationProbe) => void>();
  #stateKey: string | undefined;
  #stateEpoch = 0;
  #navigationEpoch = 0;
  #closed = false;
  #busy = false;
  #lastState: State | undefined;

  constructor(session: McpExplorationSession, current: CurrentStateExploration | ActionCandidateGroundingSessionV1) {
    this.#session = session;
    this.#current = current;
    const deferred = current instanceof ActionCandidateGroundingSessionV1
      ? ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(current, session) : undefined;
    const authority = deferred ?? (current as CurrentStateExploration).observationAuthority(session);
    const source = deferred?.admission.spec ?? (current as CurrentStateExploration).source;
    this.#owner = { testSpecId: source.testSpecId, explorationAttemptId: authority.attemptId,
      sessionId: authority.sessionId, executionProfileRef: source.executionProfileRef,
      profileFingerprint: session.browserSession.effectiveProfile.fingerprint };
    session.browserSession.context.on('page', (page) => { this.#navigationEpoch++; this.#watch(page); });
    for (const page of session.browserSession.context.pages()) this.#watch(page);
    session.browserSession.onClosing(() => { this.#closed = true; this.#navigationEpoch++; });
  }

  #watch(page: Page): void {
    page.on('framenavigated', () => { this.#navigationEpoch++; });
    page.on('frameattached', () => { this.#navigationEpoch++; });
    page.on('framedetached', () => { this.#navigationEpoch++; });
    page.on('close', () => { this.#navigationEpoch++; });
  }

  #pageId(page: Page): string {
    let value = this.#pageIds.get(page);
    if (!value) { value = `page-${randomUUID()}`; this.#pageIds.set(page, value); }
    return value;
  }

  async #state(): Promise<State> {
    if (this.#closed || this.#session.browserSession.isClosed) throw new ObservationFailure('STALE_STATE');
    if (this.#current instanceof ActionCandidateGroundingSessionV1) {
      ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this.#current, this.#session);
      const state = await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#current);
      const frameDigests = new Map<Frame, string>();
      for (const frame of state.frames) {
        const snapshot = await frame.locator('body').ariaSnapshot({ timeout: 3000 });
        if (snapshot.length > MAX_SNAPSHOT) throw new ObservationFailure('RESULT_LIMIT');
        frameDigests.set(frame, hash(snapshot));
      }
      const renewed = await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(this.#current);
      if (renewed.stateDigest !== state.stateDigest || renewed.stateEpoch !== state.stateEpoch ||
        renewed.mutationEpoch !== state.mutationEpoch || state.frames.some((f, i) => f !== renewed.frames[i]) ||
        state.frames.length !== renewed.frames.length) throw new ObservationFailure('STALE_STATE');
      const observationState = { ...state, frameDigests };
      this.#lastState = observationState;
      return observationState;
    }
    const authority = this.#current.observationAuthority(this.#session);
    const pages = this.#session.browserSession.context.pages();
    if (pages.length !== 1 || pages[0]!.isClosed()) throw new ObservationFailure('BROWSER_FAILURE');
    const page = pages[0]!;
    const frames = page.frames();
    if (frames.length > MAX_FRAMES) throw new ObservationFailure('RESULT_LIMIT');
    const frameDigests = new Map<Frame, string>();
    const materials: string[] = [];
    for (const frame of frames) {
      // These fixed runtime reads are never supplied as selectors or scripts by M7.
      const content = await frame.content();
      const snapshot = await frame.locator('body').ariaSnapshot({ timeout: 3000 });
      if (content.length > MAX_DOCUMENT || snapshot.length > MAX_SNAPSHOT)
        throw new ObservationFailure('RESULT_LIMIT');
      frameDigests.set(frame, hash(snapshot));
      materials.push(hash({ url: frame.url(), content, snapshot,
        parent: frame.parentFrame() ? frames.indexOf(frame.parentFrame()!) : -1 }));
    }
    const after = this.#current.observationAuthority(this.#session);
    if (!same(authority, after) || this.#closed || page.isClosed() ||
        this.#session.browserSession.context.pages()[0] !== page) throw new ObservationFailure('STALE_STATE');
    const key = hash({ pageId: this.#pageId(page), materials, authority,
      navigationEpoch: this.#navigationEpoch });
    if (key !== this.#stateKey) { this.#stateKey = key; this.#stateEpoch++; }
    const state = { page, pageId: this.#pageId(page), stateEpoch: this.#stateEpoch,
      mutationEpoch: authority.mutationEpoch, stateDigest: key, frameDigests };
    this.#lastState = state;
    return state;
  }

  async #frame(state: State, query: SemanticObservationQueryV1): Promise<{ frame: Frame; proof: FrameProof }> {
    if (query.frame.kind === 'main') return { frame: state.page.mainFrame(),
      proof: { kind: 'main', snapshotDigest: state.frameDigests.get(state.page.mainFrame())! } };
    let frame = state.page.mainFrame();
    const anchors: Extract<FrameProof, { kind: 'nested' }>['anchors'] = [];
    for (const anchor of query.frame.anchors) {
      const iframes = frame.locator('iframe');
      const count = await iframes.count();
      if (count > MAX_IFRAMES_PER_LEVEL) throw new ObservationFailure('RESULT_LIMIT');
      const matches: number[] = [];
      for (let index = 0; index < count; index++) {
        const actual = await iframes.nth(index).getAttribute(anchor.kind === 'title' ? 'title' : 'data-testid');
        if (actual === anchor.value) matches.push(index);
      }
      if (matches.length !== 1) throw new ObservationFailure('INVALID_SCOPE');
      const handle = await iframes.nth(matches[0]!).elementHandle();
      try {
        const child = await handle?.contentFrame();
        if (!child || child.parentFrame() !== frame || !state.frameDigests.has(child))
          throw new ObservationFailure('INVALID_SCOPE');
        anchors.push({ ...anchor, ownerSnapshotDigest: state.frameDigests.get(frame)!, observedMatchCount: 1 });
        frame = child;
      } finally { await handle?.dispose(); }
    }
    return { frame, proof: { kind: 'nested', anchors } };
  }

  async #locator(frame: Frame, query: SemanticObservationQueryV1): Promise<Locator> {
    let parent: Frame | Locator = frame;
    for (const scope of query.within ?? []) {
      const scoped: Locator = scope.kind === 'row'
        ? parent.getByRole('row', { includeHidden: true }).filter({ has: frame.getByRole('cell',
          { name: scope.cellName, exact: true, includeHidden: true }) })
        : parent.getByRole(scope.kind, { name: scope.name, exact: true, includeHidden: true });
      if (await scoped.count() !== 1) throw new ObservationFailure('INVALID_SCOPE');
      parent = scoped;
    }
    return parent.getByRole(query.role, { ...(query.name ? { name: query.name, exact: true } : {}),
      includeHidden: true });
  }

  async #property(locator: Locator, property: Extract<TrustedObservationRequestV1,
    { kind: 'target_property' }>['property']): Promise<string | boolean | { role: string; accessibleName: string }> {
    if (property === 'visible') return locator.isVisible();
    if (property === 'enabled') return locator.isEnabled();
    if (property === 'checked') return locator.isChecked();
    if (property === 'expanded' || property === 'selected') {
      const value = await locator.getAttribute(`aria-${property}`);
      if (value !== 'true' && value !== 'false') throw new ObservationFailure('UNSUPPORTED_PROPERTY');
      return value === 'true';
    }
    if (property === 'semantic') {
      const raw = await locator.ariaSnapshotJSON({ depth: 0, timeout: 3000 });
      const node = Array.isArray(raw) ? raw[0] : raw;
      if (!node || typeof node !== 'object' || typeof node.role !== 'string' ||
          typeof node.name !== 'string') throw new ObservationFailure('QUERY_UNEVALUABLE');
      if (node.role.length > 256 || node.name.length > 512) throw new ObservationFailure('RESULT_LIMIT');
      return { role: node.role, accessibleName: node.name };
    }
    try {
      const value = property === 'text' ? await locator.textContent({ timeout: 3000 }) :
        await locator.inputValue({ timeout: 3000 });
      if (value === null) throw new ObservationFailure('UNSUPPORTED_PROPERTY');
      if (value.length > 2048) throw new ObservationFailure('RESULT_LIMIT');
      return value;
    } catch (error) {
      if (error instanceof ObservationFailure) throw error;
      throw new ObservationFailure('UNSUPPORTED_PROPERTY');
    }
  }

  #record(state: State, request: TrustedObservationRequestV1, frame: FrameProof,
    outcome: ObservationOutcome): TrustedObservationResultV1 {
    const data = { observationVersion: '1', observationId: `observation-${randomUUID()}`,
      ...this.#owner, pageId: state.pageId,
      stateEpoch: state.stateEpoch, mutationEpoch: state.mutationEpoch,
      stateDigest: state.stateDigest, observedAt: new Date().toISOString(), request, frame,
      ...outcome };
    const record = TrustedObservationResultV1Schema.parse({ ...data, witnessDigest: hash(data) });
    this.#records.set(record.observationId, structuredClone(record));
    for (const listener of this.#captureListeners) listener(structuredClone(record));
    return structuredClone(record);
  }

  /** Protected assembly bridge: records are emitted at their actual capture point. */
  onProtectedRecord(listener: (record: TrustedObservationResultV1) => void): () => void {
    if (this.#closed) throw new ObservationFailure('STALE_STATE');
    this.#captureListeners.add(listener);
    return () => { this.#captureListeners.delete(listener); };
  }

  /** Opt-in private telemetry; never an observation witness. */
  onPrivateObservationAttempt(listener:(probe:PrivateObservationProbe)=>void):()=>void {
    this.#privateAttemptListeners.add(listener);
    return()=>{this.#privateAttemptListeners.delete(listener);};
  }

  /** Historical readback is limited to records created by this runtime instance. */
  protectedRecord(observationId: string): TrustedObservationResultV1 | undefined {
    const record = this.#records.get(observationId);
    return record ? structuredClone(record) : undefined;
  }

  /** Confirms the real observer's deferred owner, not a duck-typed readback source. */
  protectedDeferredOwner(runtime: ActionCandidateGroundingSessionV1): void {
    if (this.#closed || this.#current !== runtime) throw new ObservationFailure('STALE_STATE');
    ActionCandidateGroundingSessionV1.prototype.protectedTraceOwner.call(runtime, this.#session);
  }

  async observe(requestInput: unknown): Promise<TrustedObservationResultV1> {
    if(!this.#privateAttemptListeners.size)return this.#observe(requestInput);
    const request=TrustedObservationRequestV1Schema.parse(requestInput);
    return probeVerificationObservation(this.#session,request.kind,()=>this.#observe(request),
      probe=>{for(const listener of this.#privateAttemptListeners)listener(probe);},()=>this.#navigationEpoch);
  }

  async #observe(requestInput: unknown): Promise<TrustedObservationResultV1> {
    // Reject arbitrary model fields before touching the browser.
    const request = TrustedObservationRequestV1Schema.parse(requestInput);
    if (this.#busy) throw new ObservationFailure('STALE_STATE');
    if (this.#records.size >= MAX_OBSERVATIONS) throw new ObservationFailure('RESULT_LIMIT');
    this.#busy = true;
    try {
      if (request.kind === 'current_url' && this.#current instanceof ActionCandidateGroundingSessionV1 &&
          ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this.#current, this.#session)
            .admission.spec.semanticMode === 'poc_v1') {
        const read = () => ActionCandidateGroundingSessionV1.prototype.protectedCurrentUrlState.call(this.#current);
        const before = read(), after = read();
        const state: State = { page: after.page, pageId: after.pageId, stateDigest: after.stateDigest,
          stateEpoch: after.stateEpoch, mutationEpoch: after.mutationEpoch,
          frameDigests: new Map([[after.page.mainFrame(), hash({ kind: 'poc_current_url',
            pageId: after.pageId, url: after.url, stateDigest: after.stateDigest })]]) };
        if (before.stateDigest !== after.stateDigest || before.stateEpoch !== after.stateEpoch ||
            before.mutationEpoch !== after.mutationEpoch)
          return this.#record(state, request, { kind: 'unresolved' }, { status: 'error', reason: 'STALE_STATE' });
        return this.#record(state, request, { kind: 'main',
          snapshotDigest: state.frameDigests.get(after.page.mainFrame())! },
          { status: 'complete', result: { kind: 'url', value: after.url, complete: true } });
      }
      let before: State;
      try { before = await this.#state(); }
      catch (error) {
        if (!this.#lastState) throw error;
        return this.#record(this.#lastState, request, { kind: 'unresolved' },
          { status: 'error', reason: error instanceof ObservationFailure ? error.reason :
            error instanceof ExploratoryTargetResolutionError ? 'STALE_STATE' : 'BROWSER_FAILURE' });
      }
      let proof: FrameProof = { kind: 'unresolved' };
      let outcome: ObservationOutcome;
      try {
        if (request.kind === 'semantic_snapshot') {
          const full = await this.#session.snapshot();
          if (full.length > MAX_SNAPSHOT) throw new ObservationFailure('RESULT_LIMIT');
          proof = { kind: 'main', snapshotDigest: hash(full) };
          outcome = { status: 'complete', result: { kind: 'snapshot',
            text: full.slice(0, 16_384), truncated: full.length > 16_384,
            fullSnapshotDigest: hash(full), evidenceGrade: false } };
        } else if (request.kind === 'current_url') {
          const value = before.page.url();
          if (value.length > 2048) throw new ObservationFailure('RESULT_LIMIT');
          proof = { kind: 'main', snapshotDigest: before.frameDigests.get(before.page.mainFrame())! };
          outcome = { status: 'complete', result: { kind: 'url', value, complete: true } };
        } else {
          const resolved = await this.#frame(before, request.query);
          proof = resolved.proof;
          const locator = await this.#locator(resolved.frame, request.query);
          const count = await locator.count();
          if (count > MAX_COUNT) throw new ObservationFailure('RESULT_LIMIT');
          if (request.kind === 'semantic_query')
            outcome = { status: 'complete', result: { kind: 'matches', count, complete: true } };
          else {
            if (count === 0) throw new ObservationFailure('NO_MATCH', 0);
            if (count !== 1) throw new ObservationFailure('NON_UNIQUE', count);
            if (request.property === 'checked' && !['checkbox', 'radio', 'switch'].includes(request.query.role) ||
                request.property === 'value' && !['textbox', 'combobox'].includes(request.query.role) ||
                request.property === 'expanded' && !['button', 'combobox', 'menuitem', 'row'].includes(request.query.role) ||
                request.property === 'selected' && !['option', 'tab', 'row'].includes(request.query.role))
              throw new ObservationFailure('UNSUPPORTED_PROPERTY');
            const value = await this.#property(locator, request.property);
            outcome = { status: 'complete', result: { kind: 'property', matchCount: 1,
              property: request.property, value, complete: true } };
          }
        }
      } catch (error) {
        outcome = { status: 'error', reason: error instanceof ObservationFailure ? error.reason :
          before.page.isClosed() ? 'BROWSER_FAILURE' : 'QUERY_UNEVALUABLE',
          ...(error instanceof ObservationFailure && error.observedMatchCount !== undefined
            ? { observedMatchCount: error.observedMatchCount } : {}) };
      }
      let after: State;
      try { after = await this.#state(); }
      catch (error) { return this.#record(before, request, proof, { status: 'error',
        reason: error instanceof ObservationFailure ? error.reason :
          error instanceof ExploratoryTargetResolutionError ? 'STALE_STATE' : 'BROWSER_FAILURE' }); }
      if (before.stateDigest !== after.stateDigest || before.stateEpoch !== after.stateEpoch ||
          before.mutationEpoch !== after.mutationEpoch)
        return this.#record(before, request, proof, { status: 'error', reason: 'STALE_STATE' });
      return this.#record(after, request, proof, outcome);
    } finally { this.#busy = false; }
  }

  /** Only a runtime-owned, still-current complete fact can become evidence. */
  async currentEvidence(input: unknown): Promise<TrustedObservationResultV1 | undefined> {
    const parsed = TrustedObservationResultV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.status !== 'complete' || parsed.data.result.kind === 'snapshot') return undefined;
    const original = this.#records.get(parsed.data.observationId);
    if (!original || !same(original, parsed.data)) return undefined;
    try {
      if (parsed.data.request.kind === 'current_url' && this.#current instanceof ActionCandidateGroundingSessionV1 &&
          ActionCandidateGroundingSessionV1.prototype.protectedObservationOwner.call(this.#current, this.#session)
            .admission.spec.semanticMode === 'poc_v1') {
        const current = ActionCandidateGroundingSessionV1.prototype.protectedCurrentUrlState.call(this.#current);
        return parsed.data.result.kind === 'url' && parsed.data.result.value === current.url &&
          parsed.data.stateDigest === current.stateDigest && parsed.data.stateEpoch === current.stateEpoch &&
          parsed.data.mutationEpoch === current.mutationEpoch && parsed.data.pageId === current.pageId
          ? structuredClone(original) : undefined;
      }
      const current = await this.#state();
      if (parsed.data.stateDigest !== current.stateDigest || parsed.data.stateEpoch !== current.stateEpoch ||
          parsed.data.mutationEpoch !== current.mutationEpoch || parsed.data.pageId !== current.pageId)
        return undefined;
      return structuredClone(original);
    } catch { return undefined; }
  }
}

