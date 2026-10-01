import { createHash, randomUUID } from 'node:crypto';
import type { Frame, Locator, Page } from '@playwright/test';
import {
  actionIdentityWitnessDigest, parseActionIdentityWitnessV1,
  ACTION_IDENTITY_ELIGIBLE_ROLES_V1,
  parseCurrentTargetBinding, parseTestSpec,
  SuccessfulPathRecordV1Schema, SuccessfulPathRecordV2Schema, TraceBindingV2Schema,
  type FrameOwnershipV2, type SuccessfulPathRecordV2, type TraceBindingV2,
  type ActiveBindingContext, type AuthoredStep, type ExplorationTargetBindingV1,
  type SuccessfulPathRecordV1, type TestSpec, type ActionTargetIntentV1,
  type ActionIdentityWitnessV1,
} from '../domain/index.js';
import { parseAuthoredRoleNameIdentity } from '../locator/index.js';
import type { McpExplorationSession } from './mcp.js';

type Action = 'click' | 'fill' | 'select_option';
type Observation = 'assert_visible' | 'assert_text' | 'assert_value' | 'wait_for';
type TargetOperation = Action | Observation;
type Justification = 'authored_target' | 'discovered_prerequisite' | 'assertion_target' | 'wait_target';
type SelectedNode = ExplorationTargetBindingV1['selectedNode'];

const refPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const maxBindingAgeMs = 10_000;
const clickableRoles = new Set(['link', 'button', 'checkbox', 'radio', 'menuitem', 'tab', 'option',
  'switch', 'treeitem']);
/** Closed v5 eligibility is versioned in the shared action-intent contract. */
const identityRoles = ACTION_IDENTITY_ELIGIBLE_ROLES_V1;

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function phrase(text: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(text);
}

/** A failed binding is an exploratory target-resolution failure, never a QA result. */
export class ExploratoryTargetResolutionError extends Error {
  readonly code = 'TARGET_RESOLUTION_FAILED' as const;
  constructor(readonly reason: 'STALE_BINDING' | 'TARGET_NOT_FOUND' | 'TARGET_DRIFT' |
    'WRONG_TARGET' | 'UNSUPPORTED_OPERATION' | 'NOT_ACTIONABLE' | 'BUDGET_EXHAUSTED') {
    super(reason);
    this.name = 'ExploratoryTargetResolutionError';
  }
}

interface SnapshotNode {
  line: number;
  indentation: number;
  node: SelectedNode;
}

function selectedSnapshotNode(snapshot: string, ref: string): SnapshotNode {
  if (!refPattern.test(ref)) throw new ExploratoryTargetResolutionError('TARGET_NOT_FOUND');
  const lines = snapshot.split('\n');
  const found = lines.flatMap((line, index) => line.includes(`[ref=${ref}]`) ? [index] : []);
  if (found.length !== 1) throw new ExploratoryTargetResolutionError('TARGET_NOT_FOUND');
  const line = lines[found[0]!]!;
  const match = /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?(?:\s+\[[^\]]+\])*\s+\[ref=[A-Za-z][A-Za-z0-9_-]*\]/.exec(line);
  if (!match) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
  const node: SelectedNode = { role: match[2]!, accessibleName: match[3] ?? '' };
  const next = lines[found[0]! + 1];
  const href = next && /^\s+-\s+\/url:\s+(\S+)/.exec(next)?.[1];
  if (href) {
    try {
      const url = new URL(href);
      if (url.protocol === 'http:' || url.protocol === 'https:') node.destination = url.href;
    } catch { /* Relative hrefs are not a trusted absolute destination fact. */ }
  }
  return { line: found[0]!, indentation: match[1]!.length, node };
}

async function scopeMatches(snapshot: string, selected: SnapshotNode, step: AuthoredStep,
  frame: Frame): Promise<boolean> {
  const target = step.type === 'wait_for' && 'target' in step.condition
    ? step.condition.target : 'target' in step ? step.target : undefined;
  if (!target?.scope?.length) return true;
  const lines = snapshot.split('\n');
  let childIndent = selected.indentation;
  const ancestors: { role: string; name: string; line: number; indentation: number }[] = [];
  for (let index = selected.line - 1; index >= 0; index--) {
    const match = /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?/.exec(lines[index]!);
    if (!match || match[1]!.length >= childIndent) continue;
    ancestors.push({ role: match[2]!, name: match[3] ?? '', line: index, indentation: match[1]!.length });
    childIndent = match[1]!.length;
  }
  for (const scope of target.scope) {
    if (scope.kind === 'frame') {
      if (frame === frame.page().mainFrame()) return false;
      const title = await frame.frameElement().then((element) => element.getAttribute('title')).catch(() => null);
      if (!title || !phrase(scope.description, title)) return false;
      continue;
    }
    const possible = ancestors.filter((ancestor) => ancestor.role ===
      scope.kind);
    if (scope.kind === 'row') {
      const exactCell = possible.filter((ancestor) => {
        for (let index = ancestor.line + 1; index < lines.length; index++) {
          const line = lines[index]!;
          const indent = /^\s*/.exec(line)![0].length;
          if (indent <= ancestor.indentation) break;
          const cell = /^\s*-\s+cell "([^"]+)"/.exec(line)?.[1];
          if (cell && phrase(scope.description, cell)) return true;
        }
        return false;
      });
      if (exactCell.length !== 1) return false;
    } else if (possible.filter((ancestor) => !!ancestor.name &&
        phrase(scope.description, ancestor.name)).length !== 1) return false;
  }
  return true;
}

function compatible(role: string, operation: TargetOperation): boolean {
  if (operation === 'click') return clickableRoles.has(role);
  if (operation === 'fill') return role === 'textbox' || role === 'searchbox';
  if (operation === 'select_option') return role === 'combobox' || role === 'listbox';
  if (operation === 'assert_value') return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  return true;
}

interface SnapshotState { snapshot: string; digest: string; stateDigest: string; epoch: number;
  page: Page; pageId: string; url: string; mutationEpoch: number; observedAt: number; }

type PassiveCapture = { originStepId: string; recordId: string; preStateDigest: string;
  sequence: number; binding?: ExplorationTargetBindingV1 };

/** Frame paths are verified from protected Playwright frame elements, never MCP text. */
async function frameOwnership(frame: Frame, current: SnapshotState): Promise<FrameOwnershipV2> {
  if (frame === current.page.mainFrame())
    return { kind: 'main', observationDigest: current.digest };
  const anchors: Extract<FrameOwnershipV2, { kind: 'nested' }>['anchors'] = [];
  let child = frame;
  while (child !== current.page.mainFrame()) {
    if (anchors.length >= 8) return { kind: 'unproven', reasonCode: 'unsupported_anchor' };
    const parent = child.parentFrame();
    if (!parent) return { kind: 'unproven', reasonCode: 'missing_attestation' };
    try {
      const element = await child.frameElement();
      const title = await element.getAttribute('title');
      const testId = await element.getAttribute('data-testid');
      const siblings = parent.locator('iframe');
      const count = await siblings.count();
      if (count > 80) return { kind: 'unproven', reasonCode: 'ambiguous_anchor' };
      let identity: { kind: 'title' | 'testId'; value: string; exact: true } | undefined;
      for (const candidate of [{ kind: 'title' as const, value: title },
        { kind: 'testId' as const, value: testId }]) {
        if (!candidate.value || candidate.value.length > (candidate.kind === 'title' ? 512 : 256)) continue;
        let matches = 0;
        let ownerMatches = false;
        for (let index = 0; index < count; index++) {
          const sibling = siblings.nth(index);
          if (await sibling.getAttribute(candidate.kind === 'title' ? 'title' : 'data-testid') !== candidate.value)
            continue;
          matches++;
          const handle = await sibling.elementHandle();
          try { if (await handle?.contentFrame() === child) ownerMatches = true; }
          finally { await handle?.dispose(); }
        }
        if (matches === 1 && ownerMatches) {
          identity = { kind: candidate.kind, value: candidate.value, exact: true };
          break;
        }
      }
      if (!identity) return { kind: 'unproven', reasonCode: title || testId ?
        'ambiguous_anchor' : 'unsupported_anchor' };
      const parentSnapshot = await parent.locator('body').ariaSnapshot({ timeout: 3000 });
      if (!parentSnapshot || parentSnapshot.length > 131_072)
        return { kind: 'unproven', reasonCode: 'missing_attestation' };
      anchors.unshift({ identity, ownerSnapshotDigest: digest(parentSnapshot), observedMatchCount: 1 });
      child = parent;
    } catch { return { kind: 'unproven', reasonCode: 'missing_attestation' }; }
  }
  return { kind: 'nested', anchors };
}

/**
 * Separate WP2A path. The caller owns the protected MCP session. This class
 * cannot compile a locator, persist a resolved spec, or invoke replay.
 */
export class CurrentStateExploration {
  static #owners = new WeakMap<McpExplorationSession, CurrentStateExploration>();
  readonly sessionId = `session-${randomUUID()}`;
  #source: TestSpec;
  readonly attemptId: string;
  #actions: { binding: ExplorationTargetBindingV1; record: SuccessfulPathRecordV1 }[] = [];
  #abandoned: { binding: ExplorationTargetBindingV1; record: SuccessfulPathRecordV1;
    branchDiagnosticId: string }[] = [];
  #session: McpExplorationSession;
  #ids = new WeakMap<object, string>();
  #epoch = 0;
  #mutationEpoch = 0;
  #current: SnapshotState | undefined;
  #used = new Set<string>();
  #issued = new Map<string, ExplorationTargetBindingV1>();
  #traceBindings = new Map<string, TraceBindingV2>();
  #identityWitnesses = new Map<string, ActionIdentityWitnessV1>();
  #observations = new Map<string, SnapshotState>();
  #busy = false;
  #clock: () => number;
  #beforeFullSnapshot: (() => void) | undefined;

  constructor(session: McpExplorationSession, sourceInput: unknown, attemptId: string,
    clock: () => number = Date.now, beforeFullSnapshot?: () => void) {
    this.#session = session;
    this.#source = parseTestSpec(sourceInput);
    this.attemptId = attemptId;
    const effective = session.browserSession.effectiveProfile;
    if (!same(this.#source.executionProfileRef, { id: effective.profile.id, version: effective.profile.version }) ||
      !/^\w[\w-]*$/.test(attemptId)) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    this.#clock = clock;
    this.#beforeFullSnapshot = beforeFullSnapshot;
    CurrentStateExploration.#owners.get(session)?.invalidate();
    CurrentStateExploration.#owners.set(session, this);
    session.browserSession.context.on('page', (page) => this.#watchPage(page));
    for (const page of session.browserSession.context.pages()) this.#watchPage(page);
    session.browserSession.onClosing(() => this.invalidate());
  }

  #id(object: object, prefix: string): string {
    let id = this.#ids.get(object);
    if (!id) { id = `${prefix}-${randomUUID()}`; this.#ids.set(object, id); }
    return id;
  }

  #watchPage(page: Page): void {
    page.on('framenavigated', () => this.invalidate());
    page.on('close', () => this.invalidate());
  }

  invalidate(): void { this.#epoch++; this.#current = undefined; this.#issued.clear(); }

  get source(): TestSpec { return structuredClone(this.#source); }

  /** Protected v2 provenance; the v1 action binding remains the only action authority. */
  traceBinding(binding: ExplorationTargetBindingV1): TraceBindingV2 {
    this.#assertOwner();
    const captured = this.#traceBindings.get(binding.bindingId);
    if (!captured) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    const { frameOwnership: _ownership, ...original } = captured;
    if (!same(binding, original))
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    return structuredClone(captured);
  }

  /** Protected journal readback; model-produced witness objects have no authority. */
  traceActionIdentityWitness(binding: ExplorationTargetBindingV1): ActionIdentityWitnessV1 {
    this.#assertOwner();
    const witness = this.#identityWitnesses.get(binding.bindingId);
    if (!witness || witness.bindingId !== binding.bindingId ||
        witness.selectedRef !== binding.selectedRef ||
        witness.sessionId !== binding.sessionId || witness.pageId !== binding.pageId ||
        witness.snapshotEpoch !== binding.snapshotEpoch ||
        witness.snapshotDigest !== binding.snapshotDigest)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    return structuredClone(parseActionIdentityWitnessV1(witness));
  }

  #assertOwner(): void {
    if (CurrentStateExploration.#owners.get(this.#session) !== this)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
  }

  /** Read-only epoch authority for separately versioned observation records. */
  observationAuthority(session: McpExplorationSession): { sessionId: string; attemptId: string; stateEpoch: number;
    mutationEpoch: number } {
    this.#assertOwner();
    if (session !== this.#session) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    if (this.#session.browserSession.isClosed) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    return { sessionId: this.sessionId, attemptId: this.attemptId,
      stateEpoch: this.#epoch, mutationEpoch: this.#mutationEpoch };
  }

  /** Successful-path facts stay private until M7 assembles a validated full trace. */
  get successfulActions(): readonly { binding: ExplorationTargetBindingV1;
    record: SuccessfulPathRecordV1; identityWitness?: ActionIdentityWitnessV1 }[] {
    return structuredClone(this.#actions.map((fact) => ({ ...fact,
      ...(this.#identityWitnesses.has(fact.binding.bindingId) ?
        { identityWitness: this.#identityWitnesses.get(fact.binding.bindingId)! } : {}) })));
  }

  async #identityTarget(frame: Frame, intent: ActionTargetIntentV1): Promise<Locator> {
    let scope: Frame | Locator = frame;
    for (const part of intent.scope ?? []) {
      if (part.kind === 'frame') continue;
      const next: Locator = part.kind === 'row' ? scope.getByRole('row', { includeHidden: true }).filter({
        has: frame.getByRole('cell', { name: part.description, exact: true, includeHidden: true }),
      }) : scope.getByRole(part.kind, { name: part.description, exact: true, includeHidden: true });
      if (await next.count() !== 1) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
      scope = next;
    }
    const roles = intent.role.kind === 'explicit' ? [intent.role.value] : identityRoles[intent.operation];
    if (intent.role.kind === 'explicit' && !identityRoles[intent.operation].includes(intent.role.value))
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    // The caller counts every eligible role; this return is only for an explicit role.
    return scope.getByRole(roles[0]!, { name: intent.accessibleName, exact: true, includeHidden: true });
  }

  async #proveActionIntent(frame: Frame, ref: string, node: SelectedNode,
    intent: ActionTargetIntentV1, ownership: FrameOwnershipV2): Promise<void> {
    if (ownership.kind === 'unproven') throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    const frames = (intent.scope ?? []).filter((part) => part.kind === 'frame');
    if (ownership.kind === 'main' ? frames.length !== 0 :
        frames.length !== ownership.anchors.length ||
        frames.some((part, index) => ownership.anchors[index]?.identity.kind !== 'title' ||
          ownership.anchors[index]?.identity.value !== part.description))
      throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    const roles = intent.role.kind === 'explicit' ? [intent.role.value] : identityRoles[intent.operation];
    if (intent.role.kind === 'explicit' && !identityRoles[intent.operation].includes(intent.role.value))
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    if (!roles.includes(node.role as typeof roles[number]) || node.accessibleName !== intent.accessibleName)
      throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    let count = 0;
    let selected = 0;
    for (const role of roles) {
      const query = await this.#identityTarget(frame, { ...intent,
        role: { kind: 'explicit', value: role, sourceSpan: intent.nameSourceSpan } });
      count += await query.count();
      selected += await query.and(frame.locator(`aria-ref=${ref}`)).count();
      if (count > 1) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    }
    if (count !== 1 || selected !== 1)
      throw new ExploratoryTargetResolutionError(count === 0 ? 'TARGET_NOT_FOUND' : 'WRONG_TARGET');
  }

  currentObservedPathDigest(): string {
    this.#assertOwner();
    if (!this.#current || this.#current.mutationEpoch !== this.#mutationEpoch)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    return this.#current.stateDigest;
  }

  /** Protected readback for trace assembly; does not advance binding or mutation epochs. */
  async verifyObservedPathState(stateDigest: string): Promise<{ url: string; snapshotDigest: string }> {
    this.#assertOwner();
    const current = this.#current;
    const pages = this.#session.browserSession.context.pages();
    if (!current || pages.length !== 1 || pages[0] !== current.page || current.page.isClosed() ||
        current.stateDigest !== stateDigest || current.mutationEpoch !== this.#mutationEpoch)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    const snapshot = await this.#session.snapshot();
    if (digest(snapshot) !== current.digest ||
        digest(`${current.page.url()}\n${snapshot}`) !== stateDigest)
      throw new ExploratoryTargetResolutionError('TARGET_DRIFT');
    return { url: current.page.url(), snapshotDigest: current.digest };
  }

  /** A verified no-effect candidate can leave the successful journal only
   * through an explicit failed-branch transition. The fact remains available
   * for private diagnostics and cannot be silently lost. */
  abandonUnchangedAction(recordId: string, branchDiagnosticId: string): void {
    this.#assertOwner();
    if (!/^branch-[A-Za-z0-9_-]+$/.test(branchDiagnosticId))
      throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    const last = this.#actions.at(-1);
    if (!last || last.record.recordId !== recordId ||
        last.record.preStateDigest !== last.record.postStateDigest)
      throw new ExploratoryTargetResolutionError('TARGET_DRIFT');
    this.#abandoned.push({ ...structuredClone(last), branchDiagnosticId });
    this.#actions.pop();
  }

  get abandonedActions(): readonly { binding: ExplorationTargetBindingV1;
    record: SuccessfulPathRecordV1; branchDiagnosticId: string }[] {
    return structuredClone(this.#abandoned);
  }

  async observe(): Promise<{ snapshot: string; snapshotDigest: string; stateDigest: string;
    snapshotEpoch: number }> {
    this.#assertOwner();
    if (this.#session.browserSession.isClosed) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    const pages = this.#session.browserSession.context.pages();
    if (pages.length !== 1) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    const page = pages[0]!;
    this.#beforeFullSnapshot?.();
    const snapshot = await this.#session.snapshot();
    this.#epoch++;
    this.#issued.clear();
    const url = page.url();
    this.#current = { snapshot, digest: digest(snapshot), stateDigest: digest(`${url}\n${snapshot}`),
      epoch: this.#epoch, page, pageId: this.#id(page, 'page'), url,
      mutationEpoch: this.#mutationEpoch, observedAt: this.#clock() };
    this.#observations.set(this.#current.stateDigest, this.#current);
    if (this.#observations.size > 80) this.#observations.delete(this.#observations.keys().next().value!);
    return { snapshot, snapshotDigest: this.#current.digest,
      stateDigest: this.#current.stateDigest, snapshotEpoch: this.#current.epoch };
  }

  async #active(ref: string, current: SnapshotState): Promise<{ context: ActiveBindingContext;
    frame: Frame; editable: boolean; nativeSelect: boolean }> {
    const selected = selectedSnapshotNode(current.snapshot, ref);
    const hits: { frame: Frame; count: number }[] = [];
    for (const frame of current.page.frames()) {
      const locator = frame.locator(`aria-ref=${ref}`);
      const count = await locator.count();
      if (count > 1) throw new ExploratoryTargetResolutionError('TARGET_NOT_FOUND');
      if (count === 1) {
        const handle = await locator.elementHandle();
        try {
          const owner = await handle?.ownerFrame();
          if (owner === frame) hits.push({ frame, count });
        } finally { await handle?.dispose(); }
      }
    }
    if (hits.length !== 1 || hits[0]!.count !== 1)
      throw new ExploratoryTargetResolutionError('TARGET_NOT_FOUND');
    const frame = hits[0]!.frame;
    const locator = frame.locator(`aria-ref=${ref}`);
    return { frame, editable: await locator.isEditable().catch(() => false),
      nativeSelect: await locator.and(frame.locator('select')).count().then((count) => count === 1).catch(() => false),
      context: {
      testSpecId: this.#source.testSpecId, explorationAttemptId: this.attemptId,
      executionProfileRef: this.#source.executionProfileRef,
      profileFingerprint: this.#session.browserSession.effectiveProfile.fingerprint,
      sessionId: this.sessionId, pageId: current.pageId, frameId: this.#id(frame, 'frame'),
      snapshotEpoch: current.epoch, snapshotDigest: current.digest, selectedRef: ref,
      selectedRefCount: 1, selectedNode: selected.node,
      visible: await locator.isVisible(), enabled: await locator.isEnabled(),
    } };
  }

  async bind(originStepId: string, operation: TargetOperation, ref: string,
    justificationCode: Justification = 'authored_target'): Promise<ExplorationTargetBindingV1> {
    this.#assertOwner();
    const current = this.#current;
    if (!current || this.#session.browserSession.isClosed) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    if (this.#issued.size >= 80 || this.#actions.length >= 80)
      throw new ExploratoryTargetResolutionError('BUDGET_EXHAUSTED');
    const authored = this.#source.steps.find((step) => step.id === originStepId);
    if (!authored) throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    const { context, frame, editable, nativeSelect } = await this.#active(ref, current);
    const node = context.selectedNode;
    if (!compatible(node.role, operation)) throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    if ((operation === 'fill' && !editable) || (operation === 'select_option' && !nativeSelect))
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    if ((operation === 'click' || operation === 'fill' || operation === 'select_option') &&
        (!context.visible || !context.enabled)) throw new ExploratoryTargetResolutionError('NOT_ACTIONABLE');
    const intent = this.#source.schemaVersion === '5' && justificationCode === 'authored_target' &&
      (authored.type === 'click' || authored.type === 'fill' || authored.type === 'select_option') ?
      authored.actionTargetIntent : undefined;
    if (this.#source.schemaVersion === '5' && justificationCode === 'authored_target' && !intent)
      throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    if (justificationCode !== 'discovered_prerequisite') {
      const target = authored.type === 'wait_for' && 'target' in authored.condition
        ? authored.condition.target : 'target' in authored ? authored.target : undefined;
      if (authored.type !== operation || !target ||
          (justificationCode === 'authored_target' && !['click', 'fill', 'select_option'].includes(operation)) ||
          (justificationCode === 'assertion_target' && !operation.startsWith('assert_')) ||
          (justificationCode === 'wait_target' && operation !== 'wait_for'))
        throw new ExploratoryTargetResolutionError('WRONG_TARGET');
      const explicit = intent ? undefined : parseAuthoredRoleNameIdentity(target.description);
      if (explicit && (explicit.role !== node.role || explicit.name !== node.accessibleName))
        throw new ExploratoryTargetResolutionError('WRONG_TARGET');
      if (!intent && !await scopeMatches(current.snapshot, selectedSnapshotNode(current.snapshot, ref), authored, frame))
        throw new ExploratoryTargetResolutionError('WRONG_TARGET');
    }
    const binding: ExplorationTargetBindingV1 = {
      bindingVersion: '1', bindingId: `binding-${randomUUID()}`,
      testSpecId: this.#source.testSpecId, explorationAttemptId: this.attemptId,
      executionProfileRef: this.#source.executionProfileRef,
      profileFingerprint: context.profileFingerprint,
      sessionId: this.sessionId, pageId: context.pageId, frameId: context.frameId,
      snapshotEpoch: context.snapshotEpoch, snapshotDigest: context.snapshotDigest,
      selectedRef: ref, originStepId, operation, selectedNode: node, justificationCode,
      issuedAt: new Date(this.#clock()).toISOString(),
    };
    try {
      const accepted = parseCurrentTargetBinding(binding, context, this.#source);
      const ownership = await frameOwnership(frame, current);
      if (intent) await this.#proveActionIntent(frame, ref, node, intent, ownership);
      if (ownership.kind === 'nested') {
        this.#beforeFullSnapshot?.();
        if (digest(await this.#session.snapshot()) !== current.digest)
          throw new ExploratoryTargetResolutionError('STALE_BINDING');
      }
      if (this.#current !== current || this.#session.browserSession.isClosed)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      const traceBinding = TraceBindingV2Schema.parse({
        ...accepted, frameOwnership: ownership,
      });
      let identityWitness: ActionIdentityWitnessV1 | undefined;
      if (intent) {
        const data = { witnessVersion: '1' as const, witnessId: `action-witness-${randomUUID()}`,
          bindingId: accepted.bindingId, testSpecId: accepted.testSpecId,
          explorationAttemptId: accepted.explorationAttemptId, sessionId: accepted.sessionId,
          pageId: accepted.pageId, frameId: accepted.frameId,
          executionProfileRef: accepted.executionProfileRef,
          profileFingerprint: accepted.profileFingerprint,
          sourceStepId: accepted.originStepId, operation: intent.operation,
          requestedIntent: intent, selectedRef: ref, selectedRole: node.role,
          selectedAccessibleName: node.accessibleName, eligibleMatchCount: 1 as const,
          selectedReferenceMatches: true as const, scope: intent.scope,
          frameOwnership: ownership, snapshotEpoch: current.epoch,
          mutationEpoch: current.mutationEpoch, snapshotDigest: current.digest,
          stateDigest: current.stateDigest, observedAt: new Date(this.#clock()).toISOString() };
        identityWitness = parseActionIdentityWitnessV1({
          ...data, witnessDigest: actionIdentityWitnessDigest(data),
        });
      }
      this.#issued.set(accepted.bindingId, structuredClone(accepted));
      this.#traceBindings.set(accepted.bindingId, traceBinding);
      if (identityWitness) this.#identityWitnesses.set(accepted.bindingId, identityWitness);
      return accepted;
    }
    catch { throw new ExploratoryTargetResolutionError('WRONG_TARGET'); }
  }

  /** Capture a passive transition only from a condition already present in the
   * validated authored source, at the protected observation that sees it. */
  async capturePassiveTransition(input: PassiveCapture): Promise<SuccessfulPathRecordV2> {
    this.#assertOwner();
    const current = this.#current;
    const before = this.#observations.get(input.preStateDigest);
    if (!current || !before || before === current ||
        before.page !== current.page || before.stateDigest === current.stateDigest ||
        before.mutationEpoch !== current.mutationEpoch ||
        current.mutationEpoch !== this.#mutationEpoch ||
        this.#clock() - current.observedAt > maxBindingAgeMs ||
        this.#session.browserSession.isClosed)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    const step = this.#source.steps.find((item) => item.id === input.originStepId);
    if (!step || (step.type !== 'assert_url' && step.type !== 'wait_for' &&
        step.type !== 'click' && step.type !== 'assert_visible'))
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    const condition = step.type === 'wait_for' ? step.condition :
      step.type === 'assert_url' ? (step.match === 'exact' ?
        { type: 'url_exact' as const, url: step.expectedUrl } :
        { type: 'url_pattern' as const, pattern: step.expectedUrl }) :
        { type: 'target_visible' as const, target: step.target };
    const timeoutPolicyRef = step.type === 'wait_for' ? step.timeoutPolicyRef : 'default';
    const waitMs = this.#session.browserSession.effectiveProfile.profile.timeoutPolicy.waits[timeoutPolicyRef];
    if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0)
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    this.#beforeFullSnapshot?.();
    const refreshed = await this.#session.snapshot();
    if (digest(refreshed) !== current.digest || current !== this.#current)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    let satisfied = false;
    if (condition.type === 'url_exact') satisfied = current.page.url() === condition.url;
    else if (condition.type === 'url_pattern') satisfied = current.page.url().startsWith(condition.pattern.slice(0, -1));
    else {
      const binding = input.binding;
      if (!binding || binding.originStepId !== input.originStepId || binding.operation !== 'wait_for' ||
          !same(binding, this.#issued.get(binding.bindingId)) ||
          this.#clock() - Date.parse(binding.issuedAt) > maxBindingAgeMs)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      if (step.type !== 'wait_for') {
        // A newly visible authored target can explain a passive transition;
        // an already visible same-role/name node cannot.
        const oldNodes = before.snapshot.split('\n').filter((line) =>
          /^\s*-\s+[A-Za-z][\w-]*(?:\s+"[^"]*")?/.test(line));
        const selected = binding.selectedNode;
        if (oldNodes.some((line) => {
          const match = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?/.exec(line);
          return match?.[1] === selected.role && (match[2] ?? '') === selected.accessibleName;
        })) throw new ExploratoryTargetResolutionError('TARGET_DRIFT');
      }
      const { context, frame } = await this.#active(binding.selectedRef, current);
      try { parseCurrentTargetBinding(binding, context, this.#source); }
      catch { throw new ExploratoryTargetResolutionError('TARGET_DRIFT'); }
      const authoredTarget = condition.target;
      const explicit = parseAuthoredRoleNameIdentity(authoredTarget.description);
      if (!explicit || explicit.role !== context.selectedNode.role ||
          explicit.name !== context.selectedNode.accessibleName ||
          !await scopeMatches(current.snapshot,
            selectedSnapshotNode(current.snapshot, binding.selectedRef), step, frame))
        throw new ExploratoryTargetResolutionError('WRONG_TARGET');
      const target = frame.locator(`aria-ref=${binding.selectedRef}`);
      satisfied = condition.type === 'target_visible' ? await target.isVisible() :
        typeof condition.expectedValue === 'string' &&
          await target.inputValue().then((value) => value === condition.expectedValue).catch(() => false);
    }
    if (!satisfied || current !== this.#current || current.page.url() !== current.url)
      throw new ExploratoryTargetResolutionError('TARGET_DRIFT');
    const record = SuccessfulPathRecordV2Schema.parse({
      recordId: input.recordId, sequence: input.sequence, originStepId: input.originStepId,
      source: 'discoveredPrerequisite', prerequisiteReasonCode: 'reach_state',
      preStateDigest: before.stateDigest, postStateDigest: current.stateDigest,
      observationDigest: current.digest, type: 'state_observed', result: 'observed',
      condition, timeoutPolicyRef,
      ...('target' in condition ? { bindingId: input.binding!.bindingId } : {}),
      witness: { kind: 'protected_condition_check', traceRecordId: input.recordId,
        timeoutPolicyRef, conditionDigest: digest(JSON.stringify(condition)),
        observationDigest: current.digest, observedStateDigest: current.stateDigest,
        observedAt: new Date(this.#clock()).toISOString(), satisfied: true },
    });
    return record;
  }

  /** A targeted predicate is evaluated from the bound protected page, never
   * from model-authored text or an unverified locator. */
  async observeTarget(binding: ExplorationTargetBindingV1): Promise<'passed' | 'failed'> {
    this.#assertOwner();
    const current = this.#current;
    if (!current || this.#session.browserSession.isClosed || this.#used.has(binding.bindingId) ||
        !same(binding, this.#issued.get(binding.bindingId)) ||
        this.#clock() - Date.parse(binding.issuedAt) > maxBindingAgeMs)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    if (!['assert_visible', 'assert_text', 'assert_value', 'wait_for'].includes(binding.operation))
      throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
    this.#beforeFullSnapshot?.();
    const refreshed = await this.#session.snapshot();
    if (digest(refreshed) !== current.digest || this.#current !== current)
      throw new ExploratoryTargetResolutionError('STALE_BINDING');
    const { context, frame } = await this.#active(binding.selectedRef, current);
    try { parseCurrentTargetBinding(binding, context, this.#source); }
    catch { throw new ExploratoryTargetResolutionError('TARGET_DRIFT'); }
    const step = this.#source.steps.find((item) => item.id === binding.originStepId)!;
    const locator = frame.locator(`aria-ref=${binding.selectedRef}`);
    this.#used.add(binding.bindingId);
    if (step.type === 'assert_visible') return await locator.isVisible() ? 'passed' : 'failed';
    if (step.type === 'assert_text') {
      const actual = await locator.innerText();
      return (step.match === 'exact' ? actual === step.expectedText : actual.includes(step.expectedText))
        ? 'passed' : 'failed';
    }
    if (step.type === 'assert_value') {
      if (typeof step.expectedValue !== 'string') throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
      return await locator.inputValue() === step.expectedValue ? 'passed' : 'failed';
    }
    if (step.type === 'wait_for' && 'target' in step.condition) {
      if (step.condition.type === 'target_visible') return await locator.isVisible() ? 'passed' : 'failed';
      if (typeof step.condition.expectedValue !== 'string')
        throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
      return await locator.inputValue() === step.condition.expectedValue ? 'passed' : 'failed';
    }
    throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
  }

  async act(binding: ExplorationTargetBindingV1, value?: string): Promise<SuccessfulPathRecordV1> {
    this.#assertOwner();
    if (this.#busy) throw new ExploratoryTargetResolutionError('STALE_BINDING');
    this.#busy = true;
    try {
      const current = this.#current;
      if (this.#actions.length >= 80) throw new ExploratoryTargetResolutionError('BUDGET_EXHAUSTED');
      if (!current || this.#used.has(binding.bindingId) ||
        !same(binding, this.#issued.get(binding.bindingId)) || this.#session.browserSession.isClosed ||
        this.#clock() - Date.parse(binding.issuedAt) > maxBindingAgeMs ||
        Date.parse(binding.issuedAt) > this.#clock() + 1000)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      if (binding.operation !== 'click' && binding.operation !== 'fill' && binding.operation !== 'select_option')
        throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
      const pages = this.#session.browserSession.context.pages();
      if (pages.length !== 1 || pages[0] !== current.page || current.page.url() !== current.url)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      this.#beforeFullSnapshot?.();
      const refreshed = await this.#session.snapshot();
      if (digest(refreshed) !== current.digest || this.#current !== current)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      const { context, frame, editable, nativeSelect } = await this.#active(binding.selectedRef, current);
      try { parseCurrentTargetBinding(binding, context, this.#source); }
      catch { throw new ExploratoryTargetResolutionError('TARGET_DRIFT'); }
      if (!compatible(context.selectedNode.role, binding.operation) || !context.visible || !context.enabled)
        throw new ExploratoryTargetResolutionError('NOT_ACTIONABLE');
      if ((binding.operation === 'fill' && !editable) ||
        (binding.operation === 'select_option' && !nativeSelect))
        throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
      if (this.#source.schemaVersion === '5' && binding.justificationCode === 'authored_target') {
        const witness = this.traceActionIdentityWitness(binding);
        const ownership = await frameOwnership(frame, current);
        if (!same(witness.frameOwnership, ownership) || witness.mutationEpoch !== current.mutationEpoch ||
            witness.stateDigest !== current.stateDigest ||
            witness.requestedIntent.sourceStepId !== binding.originStepId)
          throw new ExploratoryTargetResolutionError('STALE_BINDING');
        await this.#proveActionIntent(frame, binding.selectedRef, context.selectedNode,
          witness.requestedIntent, ownership);
      }
      if (binding.operation !== 'click' && typeof value !== 'string')
        throw new ExploratoryTargetResolutionError('UNSUPPORTED_OPERATION');
      if (binding.justificationCode === 'authored_target' && binding.operation !== 'click') {
        const authored = this.#source.steps.find((step) => step.id === binding.originStepId);
        if (!authored || (authored.type !== 'fill' && authored.type !== 'select_option') ||
          typeof authored.value !== 'string' || authored.value !== value)
          throw new ExploratoryTargetResolutionError('WRONG_TARGET');
      }
      this.#assertOwner();
      if (this.#current !== current || this.#session.browserSession.isClosed ||
        this.#clock() - Date.parse(binding.issuedAt) > maxBindingAgeMs)
        throw new ExploratoryTargetResolutionError('STALE_BINDING');
      const element = context.selectedNode.accessibleName
        ? `${context.selectedNode.role} "${context.selectedNode.accessibleName}"`
        : context.selectedNode.role;
      this.#used.add(binding.bindingId);
      this.#mutationEpoch++;
      try {
        if (binding.operation === 'click') await this.#session.click(binding.selectedRef, element);
        else if (binding.operation === 'fill') await this.#session.fill(binding.selectedRef, element, value!);
        else await this.#session.select(binding.selectedRef, element, value!);
      } catch (error) {
        this.invalidate();
        throw error;
      }
      const post = await this.observe();
      const record = SuccessfulPathRecordV1Schema.parse({
        recordId: `record-${randomUUID()}`, sequence: this.#actions.length + 1,
        originStepId: binding.originStepId,
        source: binding.justificationCode === 'authored_target' ? 'authored' : 'discoveredPrerequisite',
        preStateDigest: current.stateDigest, postStateDigest: post.stateDigest,
        observationDigest: post.snapshotDigest,
        bindingId: binding.bindingId,
        type: binding.operation,
        ...(binding.operation === 'click' ? { result: 'completed' as const } :
          { value: value!, result: 'completed' as const }),
      });
      this.#actions.push({ binding: structuredClone(binding), record: structuredClone(record) });
      return record;
    } finally { this.#busy = false; }
  }
}
