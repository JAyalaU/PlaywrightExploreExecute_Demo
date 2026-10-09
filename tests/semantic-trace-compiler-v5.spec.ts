import http from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ProtectedContextFactory } from '../app/profile/local-context.js';
import { NativeProfileCatalog } from '../app/profile/native-profile.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import { admitSemanticIntentV3, type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { sealSemanticGroundingEvidenceV1, sealSemanticGroundingWitnessV1,
  sealSemanticActionExecutionReceiptV1, semanticGroundingDigestV1 as hash,
  type SemanticActionGroundingWitnessV1 } from '../app/domain/semantic-grounding-v1.js';
import { SemanticGroundingSessionV1 } from '../app/exploration/semantic-grounding-v1.js';
import { issueSemanticGroundedTraceV1, parseSemanticResolvedTestSpecV10, parseSemanticCompilerAttemptV5,
  type SemanticGroundedTraceRecordV1 } from '../app/domain/semantic-resolved-v10.js';
import { compileSemanticGroundedTraceV1, requireSemanticCompilerRejectionV1,
  requireSemanticCompilerSealedStepsV5, validateSemanticCompilerSealedSequenceV5 } from
  '../app/exploration/semantic-trace-compiler-v5.js';
import { SemanticCompilerDiagnosticsV1Store } from '../app/evidence/semantic-compiler-diagnostics-v1.js';
import { SemanticCompilerV5Store } from '../app/evidence/semantic-compiler-store-v5.js';
import { runSemanticGeneralizedOptInV1 } from '../app/interpretation/semantic-general-production-v1.js';

type Target = Extract<SemanticIntentStepV3, { type: 'action_intent' }>['target'];
const target = (category: string, exactName: string | null = null, ordinal: number | null = null,
  relation: Target['relation'] = 'unspecified', relatedStepId: string | null = null,
  context: string | null = null): Target => ({ category, exactName, ordinal, relation, relatedStepId, context });
const action = (id: string, t: Target, desiredEffect: 'activate' | 'choose' | 'set_value' | 'set_checked',
  value: string | null = null, checkedState: boolean | null = null,
  authoredMechanic: 'click' | 'type' | 'press' | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'action_intent', authoredText: id, target: t, desiredEffect, value, checkedState,
    authoredMechanic, dependsOnStepId: null });
const verify = (id: string, subject: Target | null, observable: 'exists' | 'visible' | 'enabled' |
  'checked' | 'selected' | 'value' | 'url' | 'cardinality', expected: boolean | number | string,
  dependsOnStepId: string | null = null): SemanticIntentStepV3 =>
  ({ id, type: 'verification_intent', authoredText: id, subject, observable,
    comparator: 'equals', expected, dependsOnStepId });
const nav = (url: string): SemanticIntentStepV3 => ({ id: 'nav', type: 'navigate',
  authoredText: 'Navigate', url, dependsOnStepId: null });

async function fixture(html: string, makeSteps: (root: string) => SemanticIntentStepV3[]) {
  let responseHtml = html;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/' ? `<a href="/case">Dropdown</a><a href="/case">Add/Remove Elements</a>
      <a href="/case">Checkboxes</a><a href="/case">Dynamic Controls</a>${responseHtml}` : responseHtml);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const root = `http://127.0.0.1:${address.port}/`;
  const steps = makeSteps(root);
  const source = { testSpecId: 'semantic-compiler-fixture', sourceInstruction: 'Offline authored fixture',
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
  const admission = admitSemanticIntentV3(source, { ...source, schemaVersion: '7', sourceContractVersion: '3',
    semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2', steps },
  { verdict: 'faithful', issues: [] });
  const factory = new ProtectedContextFactory(new NativeProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 1500, navigationMs: 3000, waits: { default: 1500 } },
    profileSchemaVersion: '5', browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows', presentationMode: 'headless',
  }]));
  const attemptId = 'semantic-source-attempt';
  let session: McpExplorationSession | undefined;
  try {
    session = await McpExplorationSession.open(factory, source.executionProfileRef,
      factory.catalog.resolve(source.executionProfileRef), attemptId);
    const grounding = new SemanticGroundingSessionV1(session, admission, attemptId);
    const records: SemanticGroundedTraceRecordV1[] = [];
    let groundingSessionId = '';
    for (const step of steps) {
      if (step.type === 'navigate') {
        await session.navigate(step.url);
        records.push({ type: 'navigate', step, observedUrl: session.browserSession.context.pages()[0]!.url() });
      } else if (step.type === 'action_intent') {
        const witness = await grounding.groundAction(step.id);
        groundingSessionId ||= witness.evidence.sessionId;
        const receipt = await grounding.executeGroundedAction(witness);
        records.push({ type: 'action', witness, receipt });
      } else {
        const witness = await grounding.groundVerification(step.id);
        groundingSessionId ||= witness.evidence.sessionId;
        records.push({ type: 'verification', witness });
      }
    }
    const trace = issueSemanticGroundedTraceV1(admission, { attemptId,
      sessionId: groundingSessionId, profileFingerprint: session.browserSession.effectiveProfile.fingerprint,
      records });
    return { root, steps, admission, factory, trace, setHtml: (next: string) => { responseHtml = next; },
      close: async () => {
      await session!.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    } };
  } catch (error) {
    await session?.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}

function changedAction(f: Awaited<ReturnType<typeof fixture>>, index: number,
  change: (witness: SemanticActionGroundingWitnessV1) => SemanticActionGroundingWitnessV1) {
  const records = structuredClone(f.trace.records), record = records[index];
  if (!record || record.type !== 'action' || record.witness.witnessVersion !== 'semantic_action_grounding_v1')
    throw new Error('Expected action record');
  const witness = change(record.witness);
  const { receiptDigest: _digest, ...receiptData } = record.receipt;
  records[index] = { type: 'action', witness, receipt: sealSemanticActionExecutionReceiptV1({
    ...receiptData, actionWitnessDigest: witness.witnessDigest, mechanic: witness.mechanic,
    effectStatus: witness.mechanic === 'click' ? 'delivery_only' : 'state_proven',
    observedFinalState: witness.mechanic === 'click' ? null :
      witness.mechanic === 'select_option' ? true : witness.mechanic === 'fill' ?
        witness.argument : witness.requestedChecked }) };
  return issueSemanticGroundedTraceV1(f.admission, { attemptId: f.trace.attemptId,
    sessionId: f.trace.sessionId, profileFingerprint: f.trace.profileFingerprint, records });
}
function resealAction(witness: SemanticActionGroundingWitnessV1,
  change: Partial<Omit<SemanticActionGroundingWitnessV1, 'witnessVersion' | 'step' | 'evidence' | 'witnessDigest'>>,
  evidenceChanges: Partial<Omit<SemanticActionGroundingWitnessV1['evidence'], 'evidenceDigest'>> = {}) {
  const { evidenceDigest: _e, ...evidenceData } = witness.evidence;
  const evidence = sealSemanticGroundingEvidenceV1({ ...evidenceData, ...evidenceChanges });
  const { witnessDigest: _w, ...witnessData } = witness;
  const changed = sealSemanticGroundingWitnessV1({ ...witnessData, ...change, evidence });
  if (changed.witnessVersion !== 'semantic_action_grounding_v1') throw new Error('Unexpected witness');
  return changed;
}
function agedEvidence(witness: SemanticActionGroundingWitnessV1) {
  const now = Date.now();
  return { observedAt: new Date(now - 20_000).toISOString(),
    expiresAt: new Date(now - 10_000).toISOString() };
}
function driftedCandidate(witness: SemanticActionGroundingWitnessV1) {
  const candidates = structuredClone(witness.evidence.candidates);
  const selected = candidates[witness.evidence.selectedDomainIndex!];
  if (!selected) throw new Error('Expected selected candidate');
  selected.domPath = `${selected.domPath}:drift`;
  selected.identity = hash({ frameIndex: selected.frameIndex, frameUrl: selected.frameUrl,
    path: selected.domPath, role: selected.role, name: selected.name,
    tag: selected.tag, inputType: selected.inputType });
  return candidates;
}

test('compiler rejects forged checked mechanics, capability and ordinal/domain proof', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', (root) => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)]);
  try {
    const index = 1;
    const variants: Array<{ label: string; change: (witness: SemanticActionGroundingWitnessV1) =>
      SemanticActionGroundingWitnessV1; reason: string }> = [
      { label: 'check as click', change: (w) => resealAction(w, { mechanic: 'click' }),
        reason: 'MECHANIC_MISMATCH' },
      { label: 'checkbox without checked capability', change: (w) => {
        const candidates = structuredClone(w.evidence.candidates);
        candidates[0]!.checked = null;
        return resealAction(w, {}, { candidates });
      }, reason: 'CAPABILITY_MISMATCH' },
      { label: 'missing ordinal proof', change: (w) => resealAction(w, {}, { ordinalProof: null }),
        reason: 'DOMAIN_MISMATCH' },
      { label: 'changed complete domain count', change: (w) => resealAction(w, {}, {
        candidates: w.evidence.candidates.slice(0, 1),
        ordinalProof: { authoredOrdinal: 1, completeDomainCount: 1, selectedDomainIndex: 0 },
      }), reason: 'DOMAIN_MISMATCH' },
    ];
    for (const variant of variants) {
      const trace = changedAction(f, index, variant.change);
      const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
      expect(result.kind, variant.label).toBe('compilation_stop');
      expect(result.compiler.result, variant.label).toMatchObject({ status: 'rejected', reason: variant.reason });
      expect(result.resolved).toBeUndefined();
      expect(parseSemanticCompilerAttemptV5(result.compiler, trace)).toEqual(result.compiler);
    }
  } finally { await f.close(); }
});

test('compiler rejects owned option/value mismatch and explicit authored mechanic mismatch', async () => {
  const f = await fixture('<select><option value="1">Option 1</option></select>', (root) => [nav(root),
    action('choose', target('dropdown'), 'choose', 'Option 1')]);
  try {
    const trace = changedAction(f, 1, (w) => resealAction(w, {
      optionProof: { ...w.optionProof!, value: 'forged' } }));
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'OPTION_MISMATCH' });
    expect(result.resolved).toBeUndefined();
  } finally { await f.close(); }
  const click = await fixture('<button>Go</button>', (root) => [nav(root),
    action('go', target('button', 'Go'), 'activate', null, null, 'click')]);
  try {
    const trace = changedAction(click, 1, (w) => resealAction(w, { mechanic: 'fill', argument: 'x' }));
    const result = await compileSemanticGroundedTraceV1(click.factory, click.admission, trace);
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'MECHANIC_MISMATCH' });
  } finally { await click.close(); }
});

test('compiler rejects unsupported relation proof', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add', target('button', 'Add Element'), 'activate'),
    action('created', target('button', 'Delete', null, 'created_by_step', 'add'), 'activate')]);
  try {
    const trace = changedAction(f, 2, (w) => resealAction(w, {}, { relationProof: {
      kind: 'same_as_step', relatedStepId: 'add', identity: w.evidence.candidates[0]!.identity } }));
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_RELATIONSHIP' });
  } finally { await f.close(); }
});

test('resolved readback rejects lost polarity and zero-count unique binding despite valid digest', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';b.onclick=()=>b.remove();document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add', target('button', 'Add Element'), 'activate'),
    action('delete', target('button', 'Delete', null, 'created_by_step', 'add'), 'activate'),
    verify('absent', target('button', 'Delete'), 'exists', false, 'delete')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    const altered = structuredClone(result.resolved!);
    const assertion = altered.executionSteps.at(-1)!;
    if (assertion.type !== 'assert_count') throw new Error('Expected count');
    assertion.expected = 1;
    const { resolvedDigest: _digest, ...data } = altered;
    expect(() => parseSemanticResolvedTestSpecV10({ ...data, resolvedDigest: hash(data) }, f.trace))
      .toThrow('INVALID_SEMANTIC_RESOLVED_V10');
    assertion.expected = 0;
    assertion.domain.selectedIndex = 0;
    const { resolvedDigest: _digest2, ...data2 } = altered;
    expect(() => parseSemanticResolvedTestSpecV10({ ...data2, resolvedDigest: hash(data2) }, f.trace))
      .toThrow('INVALID_SEMANTIC_RESOLVED_V10');
  } finally { await f.close(); }
});

test('ambiguous identical Delete action is not compiled from a forged selected index', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2')]);
  try {
    const deleteStep = action('delete', target('button', 'Delete', null, 'any_matching'), 'activate');
    const source = { testSpecId: f.admission.spec.testSpecId,
      sourceInstruction: f.admission.spec.sourceInstruction,
      executionProfileRef: f.admission.spec.executionProfileRef,
      startState: f.admission.spec.startState };
    const admission = admitSemanticIntentV3(source, { ...f.admission.spec,
      steps: [...f.admission.spec.steps, deleteStep] }, { verdict: 'faithful', issues: [] });
    const last = f.trace.records.at(-1);
    if (!last || last.type !== 'verification') throw new Error('Expected count record');
    const admittedDelete = admission.spec.steps.at(-1);
    if (!admittedDelete || admittedDelete.type !== 'action_intent') throw new Error('Expected action step');
    const { evidenceDigest: _old, ...oldEvidence } = last.witness.evidence;
    const evidence = sealSemanticGroundingEvidenceV1({ ...oldEvidence, stepId: 'delete',
      target: admittedDelete.target,
      selectedDomainIndex: 0, dependentActionReceiptDigest: null });
    const witness = sealSemanticGroundingWitnessV1({ witnessVersion: 'semantic_action_grounding_v1',
      step: admittedDelete, evidence, mechanic: 'click', argument: null,
      currentChecked: null, requestedChecked: null, optionProof: null });
    if (witness.witnessVersion !== 'semantic_action_grounding_v1') throw new Error('Expected action');
    const receipt = sealSemanticActionExecutionReceiptV1({ receiptVersion: 'semantic_action_execution_v1',
      stepId: 'delete', actionWitnessDigest: witness.witnessDigest, mechanic: 'click', commandReturned: true,
      beforePageUrl: evidence.pageUrl, afterPageUrl: evidence.pageUrl,
      effectStatus: 'delivery_only', observedFinalState: null,
      beforeStateDigest: hash(evidence.candidates), afterStateDigest: hash(evidence.candidates),
      executedAt: new Date().toISOString() });
    const trace = issueSemanticGroundedTraceV1(admission, { attemptId: f.trace.attemptId,
      sessionId: f.trace.sessionId, profileFingerprint: f.trace.profileFingerprint,
      records: [...f.trace.records, { type: 'action', witness, receipt }] });
    const result = await compileSemanticGroundedTraceV1(f.factory, admission, trace);
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'DOMAIN_MISMATCH' });
    expect(result.resolved).toBeUndefined();
  } finally { await f.close(); }
});

test('fill and value equality compile as closed value setting and assertion', async () => {
  const f = await fixture('<input type="text" value="old">', (root) => [nav(root),
    action('fill', target('text input'), 'set_value', 'new'),
    verify('value', target('text input'), 'value', 'new', 'fill')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps[1]).toMatchObject({ type: 'action',
      operation: 'fill', argument: 'new' });
    expect(result.resolved?.executionSteps[2]).toMatchObject({ type: 'assert_value', expected: 'new' });
  } finally { await f.close(); }
});

test('Dropdown compiles fresh link click, exact URL, native choice and selected assertion', async () => {
  const f = await fixture('<select><option>Please select</option><option value="1">Option 1</option></select>',
    (root) => [nav(root), action('link', target('link', 'Dropdown'), 'activate', null, null, 'click'),
      verify('url', null, 'url', `${root}case`, 'link'),
      action('choose', target('dropdown', null, null, 'unspecified', null, 'From the dropdown'),
        'choose', 'Option 1'),
      verify('selected', target('option', 'Option 1', null, 'same_as_step', 'choose'),
        'selected', true, 'choose')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps.map((step) => step.type)).toEqual([
      'navigate', 'action', 'assert_url', 'action', 'assert_native_selected_option']);
    expect(result.resolved?.executionSteps[3]).toMatchObject({ operation: 'select_option', argument: '1' });
    expect(parseSemanticResolvedTestSpecV10(result.resolved, f.trace)).toEqual(result.resolved);
  } finally { await f.close(); }
});

test('Add/Remove simple compiles complete-set presence and zero absence', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';b.onclick=()=>b.remove();document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('link', target('link', 'Add/Remove Elements'), 'activate'),
    action('add', target('button', 'Add Element'), 'activate'),
    verify('exists', target('button', 'Delete'), 'exists', true, 'add'),
    action('delete', target('button', 'Delete'), 'activate'),
    verify('absent', target('button', 'Delete'), 'exists', false, 'delete')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps[3]).toMatchObject({ type: 'assert_count',
      operator: 'at_least', expected: 1, domain: { completeRequired: true, requireGroundedCount: false } });
    expect(result.resolved?.executionSteps[5]).toMatchObject({ type: 'assert_count',
      operator: 'equals', expected: 0, domain: { groundedCount: 0, selectedIndex: null,
        completeRequired: true, requireGroundedCount: false } });
  } finally { await f.close(); }
});

test('two Delete controls compile count two without selecting either control', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root), action('link', target('link', 'Add/Remove Elements'), 'activate'),
    action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps.at(-1)).toMatchObject({ type: 'assert_count',
      expected: 2, domain: { groundedCount: 2, selectedIndex: null, requireGroundedCount: false } });
  } finally { await f.close(); }
});

test('authored created-by relation closes one of two identical Delete controls', async () => {
  const html = '<button onclick="let b=document.createElement(\'button\');b.textContent=\'Delete\';b.onclick=()=>b.remove();document.body.append(b)">Add Element</button>';
  const f = await fixture(html, (root) => [nav(root),
    action('add1', target('button', 'Add Element'), 'activate'),
    action('add2', target('button', 'Add Element'), 'activate'),
    verify('two', target('button', 'Delete'), 'cardinality', 2, 'add2'),
    action('delete', target('button', 'Delete', null, 'created_by_step', 'add2'), 'activate'),
    verify('one', target('button', 'Delete'), 'cardinality', 1, 'delete')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps[4]).toMatchObject({ type: 'action', operation: 'click',
      domain: { groundedCount: 2, selectedIndex: 1, relation: {
        kind: 'created_by_step', relatedStepId: 'add2' } } });
  } finally { await f.close(); }
});

test('Checkboxes compile idempotent checked actions with complete ordinal guards', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', (root) => [nav(root),
    action('link', target('link', 'Checkboxes'), 'activate'),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true),
    verify('checked1', target('checkbox', null, 1), 'checked', true, 'check1'),
    action('uncheck2', target('checkbox', null, 2), 'set_checked', null, false),
    verify('unchecked2', target('checkbox', null, 2), 'checked', false, 'uncheck2')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps[2]).toMatchObject({ operation: 'check', expectedChecked: true,
      domain: { groundedCount: 2, requireGroundedCount: true, ordinal: 1, selectedIndex: 0 } });
    expect(result.resolved?.executionSteps[4]).toMatchObject({ operation: 'uncheck', expectedChecked: false,
      domain: { groundedCount: 2, requireGroundedCount: true, ordinal: 2, selectedIndex: 1 } });
    expect(result.resolved?.executionSteps[5]).toMatchObject({ type: 'assert_boolean',
      property: 'checked', expected: false });
  } finally { await f.close(); }
});

test('old authenticated source compiles through fresh matching evidence without waiting ten seconds', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)]);
  try {
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, agedEvidence(witness)));
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved?.executionSteps[1]).toMatchObject({ type: 'action', operation: 'check',
      domain: { ordinal: 1, groundedCount: 2 } });
  } finally { await f.close(); }
});

test('old source rejects changed current ordinal domain and unavailable checked capability', async () => {
  const initial = '<input type="checkbox"><input type="checkbox" checked>';
  const f = await fixture(initial, root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)]);
  try {
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, agedEvidence(witness)));
    f.setHtml(`${initial}<input type="checkbox">`);
    const drift = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(drift.kind).toBe('compilation_stop');
    expect(requireSemanticCompilerRejectionV1(drift)).toMatchObject({
      code: 'CURRENT_RELATIONSHIP_ORDINAL_DRIFT', stepId: 'check1', expired: true,
      currentEvidenceExpired: false, sourceCurrentCorrespondence: false });
    f.setHtml('<input type="checkbox" disabled><input type="checkbox" checked>');
    const capability = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(capability.kind).toBe('compilation_stop');
    expect(requireSemanticCompilerRejectionV1(capability)).toMatchObject({
      code: 'MECHANIC_CAPABILITY_MISMATCH', stepId: 'check1', expired: true });
  } finally { await f.close(); }
});

test('old source rejects a changed current native option value mapping', async () => {
  const f = await fixture('<select><option value="1">Option 1</option></select>', root => [nav(root),
    action('choose', target('dropdown'), 'choose', 'Option 1')]);
  try {
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, agedEvidence(witness)));
    f.setHtml('<select><option value="2">Option 1</option></select>');
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(result.kind).toBe('compilation_stop');
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'OPTION_MISMATCH' });
    expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
      code: 'SOURCE_CURRENT_CORRESPONDENCE_MISMATCH', phase: 'source_current_correspondence',
      expired: true, currentEvidenceExpired: false, sourceCurrentCorrespondence: false });
  } finally { await f.close(); }
});

test('fresh compiler evidence expiry remains a non-QA rejection', async () => {
  const f = await fixture('<input type="checkbox">', root => [nav(root),
    action('check1', target('checkbox'), 'set_checked', null, true)]);
  const original = SemanticGroundingSessionV1.prototype.groundAction;
  try {
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, agedEvidence(witness)));
    SemanticGroundingSessionV1.prototype.groundAction = async function (stepId) {
      const fresh = await original.call(this, stepId);
      return resealAction(fresh, {}, agedEvidence(fresh));
    };
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(result.kind).toBe('compilation_stop');
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'STALE_EVIDENCE' });
    expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
      code: 'CURRENT_EVIDENCE_EXPIRED', phase: 'current_evidence_validation',
      expired: true, currentEvidenceExpired: true });
  } finally { SemanticGroundingSessionV1.prototype.groundAction = original; await f.close(); }
});

test('compiler seals current evidence at use and accepts its later wall-clock aging', async () => {
  const f = await fixture('<button>Go</button>', root => [nav(root),
    action('go', target('button', 'Go'), 'activate')]);
  const originalClose = McpExplorationSession.prototype.close;
  const originalNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => originalNow() + offset;
    McpExplorationSession.prototype.close = async function () {
      await originalClose.call(this);
      offset = 20_000;
    };
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    expect(result.resolved).toBeDefined();
    const seals = requireSemanticCompilerSealedStepsV5(result);
    expect(seals).toHaveLength(2);
    expect(seals[1]).toMatchObject({ stepId: 'go', recordType: 'action',
      sourceCurrentCorrespondence: true });
    expect(seals[1]!.currentEvidenceAgeAtUseMs).toBeLessThanOrEqual(10_000);
    expect(Date.now() - Date.parse(seals[1]!.validatedAt)).toBeGreaterThan(10_000);
    validateSemanticCompilerSealedSequenceV5(f.trace.records, result.resolved!.executionSteps,
      seals, result.compiler.compilerAttemptId, f.trace.testSpecId, f.trace.traceDigest);
  } finally {
    McpExplorationSession.prototype.close = originalClose;
    Date.now = originalNow;
    await f.close();
  }
});

test('final assembly refuses missing or altered sealed step proof', async () => {
  const f = await fixture('<button>Go</button>', root => [nav(root),
    action('go', target('button', 'Go'), 'activate')]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    const seals = requireSemanticCompilerSealedStepsV5(result);
    const check = (proofs: typeof seals) => validateSemanticCompilerSealedSequenceV5(
      f.trace.records, result.resolved!.executionSteps, proofs,
      result.compiler.compilerAttemptId, f.trace.testSpecId, f.trace.traceDigest);
    expect(() => check(seals.slice(0, 1))).toThrow('SOURCE_MISMATCH');
    const altered = seals.map((seal, index) => index === 1 ?
      { ...seal, currentWitnessDigest: '0'.repeat(64) } : seal);
    expect(() => check(altered)).toThrow('SOURCE_MISMATCH');
  } finally { await f.close(); }
});

test('fresh link guard survives thirty seconds of navigation and compiler continues', async () => {
  const f = await fixture('<button>Add Element</button>', root => [nav(root),
    action('link', target('link', 'Add/Remove Elements'), 'activate'),
    verify('url', null, 'url', `${root}case`, 'link'),
    action('add', target('button', 'Add Element'), 'activate')]);
  const originalExecute = SemanticGroundingSessionV1.prototype.executeGroundedAction;
  const originalNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => originalNow() + offset;
    SemanticGroundingSessionV1.prototype.executeGroundedAction = async function (witness) {
      const receipt = await originalExecute.call(this, witness);
      if (witness.step.id !== 'link') return receipt;
      offset = 30_000;
      return receipt;
    };
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind, result.kind === 'compilation_stop' ?
      JSON.stringify(requireSemanticCompilerRejectionV1(result)) : '').toBe('compiled');
    const seals = requireSemanticCompilerSealedStepsV5(result);
    expect(seals.map(step => step.stepId)).toEqual(['nav', 'link', 'url', 'add']);
    expect(seals[1]).toMatchObject({ preActionFreshnessPassed: true,
      postActionEffectFreshnessPassed: true });
    expect(seals[1]!.actionDurationMs).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - Date.parse(seals[1]!.validatedAt)).toBeGreaterThan(10_000);
    expect(seals[3]!.currentWitnessDigest).not.toBe(seals[1]!.currentWitnessDigest);
  } finally {
    SemanticGroundingSessionV1.prototype.executeGroundedAction = originalExecute;
    Date.now = originalNow;
    await f.close();
  }
});

test('a later long action keeps earlier sealed steps and seals its own fresh guard', async () => {
  const f = await fixture('<button>First</button><button>Second</button>', root => [nav(root),
    action('first', target('button', 'First'), 'activate'),
    action('second', target('button', 'Second'), 'activate')]);
  const originalExecute = SemanticGroundingSessionV1.prototype.executeGroundedAction;
  const originalNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => originalNow() + offset;
    SemanticGroundingSessionV1.prototype.executeGroundedAction = async function (witness) {
      const receipt = await originalExecute.call(this, witness);
      if (witness.step.id !== 'second') return receipt;
      offset = 20_000;
      return receipt;
    };
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.kind).toBe('compiled');
    const seals = requireSemanticCompilerSealedStepsV5(result);
    expect(seals.map(step => step.stepId)).toEqual(['nav', 'first', 'second']);
    expect(seals[2]).toMatchObject({ preActionFreshnessPassed: true,
      postActionEffectFreshnessPassed: true });
    expect(seals[2]!.actionDurationMs).toBeGreaterThanOrEqual(20_000);
  } finally {
    SemanticGroundingSessionV1.prototype.executeGroundedAction = originalExecute;
    Date.now = originalNow;
    await f.close();
  }
});

test('invalid and stale post-action receipts reject under their own evidence categories', async () => {
  const f = await fixture('<button>Go</button>', root => [nav(root),
    action('go', target('button', 'Go'), 'activate')]);
  const originalExecute = SemanticGroundingSessionV1.prototype.executeGroundedAction;
  const diagnosticsRoot = await mkdtemp(path.join(os.tmpdir(), 'semantic-action-receipt-diagnostics-'));
  try {
    const store = new SemanticCompilerDiagnosticsV1Store(diagnosticsRoot);
    await store.writeTrace(f.trace, f.admission);
    for (const [kind, expectedCode] of [
      ['invalid', 'ACTION_RECEIPT_INVALID'],
      ['stale', 'POST_ACTION_EVIDENCE_EXPIRED'],
    ] as const) {
      SemanticGroundingSessionV1.prototype.executeGroundedAction = async function (witness) {
        const receipt = await originalExecute.call(this, witness);
        const { receiptDigest: _digest, ...data } = receipt;
        return sealSemanticActionExecutionReceiptV1(kind === 'invalid' ?
          { ...data, actionWitnessDigest: '0'.repeat(64) } :
          { ...data, executedAt: new Date(new Date().getTime() - 20_000).toISOString() });
      };
      const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
      expect(result.kind).toBe('compilation_stop');
      expect(result.resolved).toBeUndefined();
      expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
        code: expectedCode, phase: 'action_receipt', stepId: 'go',
        preActionFreshnessPassed: true, actionStepSealed: false,
        allStepsSealed: false });
      await store.writeRejection(result, f.trace);
      expect((await store.readByCorrelation({ compilerAttemptId: result.compiler.compilerAttemptId }))[0])
        .toMatchObject({ recordVersion: 'semantic_compiler_rejection_diagnostic_v2',
          code: expectedCode, preActionFreshnessPassed: true, actionStepSealed: false });
    }
  } finally {
    SemanticGroundingSessionV1.prototype.executeGroundedAction = originalExecute;
    await f.close();
    await rm(diagnosticsRoot, { recursive: true, force: true });
  }
});

test('Dynamic Controls compile bounded resulting-state assertions', async () => {
  const html = `<div id="box"><input type="checkbox"></div><input id="text" type="text" disabled>
    <button onclick="setTimeout(()=>document.querySelector('#box input')?.remove(),80)">Remove</button>
    <button onclick="setTimeout(()=>document.querySelector('#box').innerHTML='<input type=checkbox>',80)">Add</button>
    <button onclick="setTimeout(()=>document.querySelector('#text').disabled=false,80)">Enable</button>
    <button onclick="setTimeout(()=>document.querySelector('#text').disabled=true,80)">Disable</button>`;
  const f = await fixture(html, (root) => [nav(root), action('link', target('link', 'Dynamic Controls'), 'activate'),
    action('remove', target('button', 'Remove'), 'activate'),
    verify('absent', target('checkbox'), 'exists', false, 'remove'),
    action('add', target('button', 'Add'), 'activate'),
    verify('present', target('checkbox'), 'exists', true, 'add'),
    action('enable', target('button', 'Enable'), 'activate'),
    verify('enabled', target('text input'), 'enabled', true, 'enable'),
    action('disable', target('button', 'Disable'), 'activate'),
    verify('disabled', target('text input'), 'enabled', false, 'disable')]);
  const originalGroundAction = SemanticGroundingSessionV1.prototype.groundAction;
  const originalNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => originalNow() + offset;
    SemanticGroundingSessionV1.prototype.groundAction = async function (stepId) {
      if (stepId === 'remove') offset = 20_000;
      return originalGroundAction.call(this, stepId);
    };
    // Logical source time advances past the unchanged ten-second lifetime during later exploration.
    const agedTrace = changedAction(f, 1, witness => resealAction(witness, {}, agedEvidence(witness)));
    const early = agedTrace.records[1], later = agedTrace.records.at(-1);
    if (!early || early.type !== 'action' || !later || later.type === 'navigate')
      throw new Error('Expected early action and later grounded step');
    expect(Date.parse(later.witness.evidence.observedAt) -
      Date.parse(early.witness.evidence.observedAt)).toBeGreaterThan(10_000);
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, agedTrace);
    expect(result.kind, result.kind === 'compilation_stop' ?
      JSON.stringify(requireSemanticCompilerRejectionV1(result)) : '').toBe('compiled');
    const seals = requireSemanticCompilerSealedStepsV5(result);
    expect(seals).toHaveLength(agedTrace.records.length);
    expect(seals[1]).toMatchObject({ stepId: 'link', sourceCurrentCorrespondence: true });
    expect(seals[1]!.currentEvidenceAgeAtUseMs).toBeLessThanOrEqual(10_000);
    expect(Date.now() - Date.parse(seals[1]!.validatedAt)).toBeGreaterThan(10_000);
    expect(result.resolved?.executionSteps.filter((step) => step.type === 'assert_count').length).toBe(2);
    expect(result.resolved?.executionSteps[7]).toMatchObject({ type: 'assert_boolean',
      property: 'enabled', expected: true, wait: { mode: 'bounded_resulting_state' } });
    expect(result.resolved?.executionSteps[9]).toMatchObject({ type: 'assert_boolean',
      property: 'enabled', expected: false, wait: { mode: 'bounded_resulting_state' } });
  } finally {
    SemanticGroundingSessionV1.prototype.groundAction = originalGroundAction;
    Date.now = originalNow;
    await f.close();
  }
});

test('restricted diagnostics separate old source age from fresh correspondence rejection', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-compiler-diagnostics-'));
  try {
    const store = new SemanticCompilerDiagnosticsV1Store(root);
    await store.writeTrace(f.trace, f.admission);
    const accepted = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(accepted.kind).toBe('compiled');
    await new SemanticCompilerV5Store(root).writeCompilationV5(accepted, f.admission, f.trace);
    await store.writeAcceptedSeal(accepted, f.trace);
    const acceptedReadback = await store.readByCorrelation({
      compilerAttemptId: accepted.compiler.compilerAttemptId });
    expect(acceptedReadback).toMatchObject([{ recordVersion: 'semantic_compiler_seal_diagnostic_v1',
      allStepsSealed: true, consumedEvidenceRefreshedAtFinalSeal: false }]);
    expect(acceptedReadback[0]).toHaveProperty('sealedSteps');
    if (acceptedReadback[0]?.recordVersion !== 'semantic_compiler_seal_diagnostic_v1')
      throw new Error('Missing accepted seal diagnostic');
    expect(acceptedReadback[0].sealedSteps[1]).toMatchObject({
      preActionFreshnessPassed: true, postActionEffectFreshnessPassed: true });
    expect(acceptedReadback[0].sealedSteps[1]?.actionDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(acceptedReadback)).not.toContain('Offline authored fixture');
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, {
      ...agedEvidence(witness), candidates: driftedCandidate(witness) }));
    await store.writeTrace(trace, f.admission);
    const rejected = await compileSemanticGroundedTraceV1(f.factory, f.admission, trace);
    expect(rejected.kind).toBe('compilation_stop');
    expect(rejected.compiler.result).toMatchObject({ status: 'rejected', reason: 'DOMAIN_MISMATCH' });
    await store.writeRejection(rejected, trace);
    const records = await store.readByCorrelation({ compilerAttemptId: rejected.compiler.compilerAttemptId });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ recordVersion: 'semantic_compiler_rejection_diagnostic_v2',
      failingStepId: 'check1', phase: 'source_current_correspondence', code: 'CURRENT_CANDIDATE_DOMAIN_DRIFT',
      category: 'DOMAIN_MISMATCH', expired: true, candidateCount: 2, ordinalProof: true,
      mechanic: 'check', currentEvidenceExpired: false, sourceCurrentCorrespondence: false,
      allStepsSealed: false, consumedEvidenceRefreshedAtFinalSeal: false });
    const record = records[0];
    if (record?.recordVersion !== 'semantic_compiler_rejection_diagnostic_v2')
      throw new Error('Missing rejected diagnostic');
    expect(record.ageMs).toBeGreaterThan(record.lifetimeMs!);
    expect(record.witnessIssuedAt).toBeTruthy();
    expect(record.witnessExpiresAt).toBeTruthy();
    const traceRecords = await store.readByCorrelation({ traceId: record.traceId });
    expect(traceRecords.map(item => item.recordVersion)).toContain('semantic_compiler_trace_diagnostic_v1');
    const serialized = JSON.stringify(traceRecords);
    expect(serialized).not.toContain('<input');
    expect(serialized).not.toContain('Offline authored fixture');
    await expect(new SemanticCompilerV5Store(root).readResolvedV10(trace.testSpecId,
      rejected.compiler.compilerAttemptId, f.admission)).rejects.toThrow();
    const directory = path.join(root, 'semantic-compiler-diagnostics-v1');
    const file = path.join(directory, `rejection-${rejected.compiler.compilerAttemptId}.json`);
    const historical = JSON.parse(await readFile(file, 'utf8')) as {
      data: Record<string, unknown>; authentication: string };
    delete historical.data.sealedSteps;
    delete historical.data.allStepsSealed;
    delete historical.data.consumedEvidenceRefreshedAtFinalSeal;
    const key = await readFile(path.join(root, '.semantic-compiler-v5-authority'));
    historical.authentication = createHmac('sha256', key)
      .update(JSON.stringify(historical.data)).digest('hex');
    await writeFile(file, JSON.stringify(historical));
    expect((await store.readByCorrelation({ compilerAttemptId: rejected.compiler.compilerAttemptId }))[0])
      .toMatchObject({ recordVersion: 'semantic_compiler_rejection_diagnostic_v2',
        code: 'CURRENT_CANDIDATE_DOMAIN_DRIFT' });
    const tampered = JSON.parse(await readFile(file, 'utf8')) as { data: { code: string } };
    tampered.data.code = 'INTEGRITY_FAILURE';
    await writeFile(file, JSON.stringify(tampered));
    await expect(store.readByCorrelation({ compilerAttemptId: rejected.compiler.compilerAttemptId })).rejects.toThrow(
      'INVALID_SEMANTIC_DIAGNOSTIC_AUTHENTICATION');
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test('restricted rejection taxonomy distinguishes mechanic, ordinal, projection and lineage boundaries', async () => {
  const f = await fixture('<input type="checkbox"><input type="checkbox" checked>', root => [nav(root),
    action('check1', target('checkbox', null, 1), 'set_checked', null, true)]);
  try {
    const variants = [
      { trace: changedAction(f, 1, w => resealAction(w, { mechanic: 'click' })),
        code: 'MECHANIC_CAPABILITY_MISMATCH', step: 'check1' },
      { trace: changedAction(f, 1, w => resealAction(w, {}, { ordinalProof: null })),
        code: 'ORDINAL_PROOF_INVALID', step: 'check1' },
    ];
    for (const item of variants) {
      const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, item.trace);
      expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({ code: item.code, stepId: item.step });
    }
    const malformed = structuredClone(f.trace);
    malformed.admissionDigest = '0'.repeat(64);
    Object.assign(f.trace, { admissionDigest: malformed.admissionDigest });
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
      code: 'TRACE_LINEAGE_MISMATCH', phase: 'trace_lineage', stepId: null });
  } finally { await f.close(); }
});

test('opt-in semantic handoff persists current-domain rejection without a v10 artifact', async () => {
  const f = await fixture('<input type="checkbox">', root => [nav(root),
    action('check1', target('checkbox'), 'set_checked', null, true)]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-rejected-handoff-'));
  try {
    const trace = changedAction(f, 1, witness => resealAction(witness, {}, {
      ...agedEvidence(witness), candidates: driftedCandidate(witness) }));
    const outcome = await runSemanticGeneralizedOptInV1(f.factory, root, f.admission, trace);
    expect(outcome.kind).toBe('compilation_stop');
    if (outcome.kind !== 'compilation_stop') throw new Error('Expected rejected semantic compilation');
    const records = await new SemanticCompilerDiagnosticsV1Store(root)
      .readByCorrelation({ compilerAttemptId: outcome.compiler.compilerAttemptId });
    expect(records).toMatchObject([{ code: 'CURRENT_CANDIDATE_DOMAIN_DRIFT', failingStepId: 'check1',
      expired: true, currentEvidenceExpired: false }]);
    await expect(new SemanticCompilerV5Store(root).readResolvedV10(trace.testSpecId,
      outcome.compiler.compilerAttemptId, f.admission)).rejects.toThrow();
  } finally {
    await f.close(); await rm(root, { recursive: true, force: true });
  }
});

test('restricted rejection names an unsupported assertion projection without relaxing acceptance', async () => {
  const f = await fixture('<select><option>Go</option></select>', root => [nav(root),
    verify('present', target('option', 'Go'), 'exists', true)]);
  try {
    const result = await compileSemanticGroundedTraceV1(f.factory, f.admission, f.trace);
    expect(result.compiler.result).toMatchObject({ status: 'rejected', reason: 'CAPABILITY_MISMATCH' });
    expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
      code: 'ASSERTION_PROJECTION_UNSUPPORTED', stepId: 'present', phase: 'assertion_projection' });
  } finally { await f.close(); }
});

test('diagnostic trace retention is bounded independently of accepted v10 artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-compiler-retention-'));
  try {
    const source = { testSpecId: 'semantic-retention', sourceInstruction: 'Navigate',
      executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
    const step = nav('https://example.com/');
    const admission = admitSemanticIntentV3(source, { ...source, schemaVersion: '7',
      sourceContractVersion: '3', semanticMode: 'intent_v2',
      normalizationVersion: 'semantic_intent_normalization_v2', steps: [step] },
    { verdict: 'faithful', issues: [] });
    const store = new SemanticCompilerDiagnosticsV1Store(root);
    for (let index = 0; index < 66; index++) {
      const trace = issueSemanticGroundedTraceV1(admission, { attemptId: `attempt-${index}`,
        sessionId: `session-${index}`, profileFingerprint: 'a'.repeat(64),
        records: [{ type: 'navigate', step: admission.spec.steps[0]!, observedUrl: 'https://example.com/' }] });
      await store.writeTrace(trace, admission);
    }
    const names = await readdir(path.join(root, 'semantic-compiler-diagnostics-v1'));
    expect(names.filter(name => name.startsWith('trace-'))).toHaveLength(64);
    expect((await store.readByCorrelation({ testSpecId: source.testSpecId })).length).toBe(64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
