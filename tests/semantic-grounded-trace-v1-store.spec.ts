import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { admitSemanticIntentV3, type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { sealSemanticGroundingEvidenceV1, sealSemanticGroundingWitnessV1,
  sealSemanticActionExecutionReceiptV1, semanticGroundingDigestV1 as hash } from
  '../app/domain/semantic-grounding-v1.js';
import { issueSemanticGroundedTraceV1, parseSemanticGroundedTraceV1,
  requireIssuedSemanticGroundedTraceV1 } from '../app/domain/semantic-resolved-v10.js';
import { SemanticGroundedTraceV1Store } from '../app/evidence/semantic-grounded-trace-v1-store.js';
import { semanticIntentCanonicalDigestV3 } from '../app/interpretation/semantic-intent-v3-relations.js';
import { compileSemanticGroundedTraceV1, requireSemanticCompilerRejectionV1 } from
  '../app/exploration/semantic-trace-compiler-v5.js';
import { McpExplorationSession } from '../app/exploration/mcp.js';
import type { ProtectedContextFactory } from '../app/profile/local-context.js';

const url = 'https://example.test/';
const selectedAt = '2020-01-01T00:00:00.000Z';
const expiredAt = '2020-01-01T00:00:10.000Z';
const profileFingerprint = 'a'.repeat(64);
const target = { category: 'button', exactName: 'Delete', context: null,
  ordinal: 1, relation: 'unspecified' as const, relatedStepId: null };
const steps: SemanticIntentStepV3[] = [
  { id: 'nav', type: 'navigate', authoredText: `Go to ${url}`, url, dependsOnStepId: null },
  { id: 'delete', type: 'action_intent', authoredText: 'Activate the first Delete button.',
    target, desiredEffect: 'activate', value: null, checkedState: null,
    authoredMechanic: null, dependsOnStepId: 'nav' },
  { id: 'count', type: 'verification_intent', authoredText: 'Verify one Delete button exists.',
    subject: { ...target, ordinal: null }, observable: 'cardinality', comparator: 'equals',
    expected: 1, dependsOnStepId: 'delete' },
];

function candidate(index: number) {
  const domPath = `html>body>button:nth-of-type(${index + 1})`;
  const data = { frameIndex: 0, frameUrl: url, path: domPath, role: 'button',
    name: 'Delete', tag: 'button', inputType: '' };
  return { frameIndex: 0, frameUrl: url, domainIndex: index, role: 'button',
    name: 'Delete', exactNameProven: true, domPath, contextProof: 'none' as const,
    tag: 'button', inputType: '', visible: true, enabled: true, editable: false,
    checked: null, value: null, nativeSelect: false, multiple: false, options: [],
    identity: hash(data) };
}

function fixture(testSpecId = 'semantic-grounded-trace-store-fixture') {
  const source = { testSpecId, sourceInstruction: steps.map((step) => step.authoredText).join('\n'),
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
  const admission = admitSemanticIntentV3(source, {
    ...source, schemaVersion: '7', sourceContractVersion: '3', semanticMode: 'intent_v2',
    normalizationVersion: 'semantic_intent_normalization_v2', steps,
  }, { verdict: 'faithful', issues: [] });
  const actionStep = admission.spec.steps[1]!;
  const countStep = admission.spec.steps[2]!;
  if (actionStep.type !== 'action_intent' || countStep.type !== 'verification_intent')
    throw new Error('Unexpected fixture steps');
  const actionEvidence = sealSemanticGroundingEvidenceV1({
    evidenceVersion: 'semantic_grounding_evidence_v1',
    groundingStrategyVersion: 'semantic_capability_discovery_v1',
    attemptId: 'source-attempt', sessionId: 'source-session', testSpecId,
    stepId: actionStep.id, profileFingerprint, pageUrl: url,
    observedAt: selectedAt, expiresAt: expiredAt, mcpRevision: 1,
    dependentActionReceiptDigest: null, domainComplete: true, target: actionStep.target,
    candidates: [candidate(0), candidate(1)], selectedDomainIndex: 0,
    ordinalProof: { authoredOrdinal: 1, completeDomainCount: 2, selectedDomainIndex: 0 },
    relationProof: null,
  });
  const actionWitness = sealSemanticGroundingWitnessV1({
    witnessVersion: 'semantic_action_grounding_v1', step: actionStep, evidence: actionEvidence,
    mechanic: 'click', argument: null, currentChecked: null, requestedChecked: null,
    optionProof: null,
  });
  const receipt = sealSemanticActionExecutionReceiptV1({
    receiptVersion: 'semantic_action_execution_v1', stepId: actionStep.id,
    actionWitnessDigest: actionWitness.witnessDigest, mechanic: 'click', commandReturned: true,
    beforePageUrl: url, afterPageUrl: url, effectStatus: 'delivery_only',
    observedFinalState: null, beforeStateDigest: hash('before'), afterStateDigest: hash('after'),
    executedAt: selectedAt,
  });
  const verificationEvidence = sealSemanticGroundingEvidenceV1({
    evidenceVersion: 'semantic_grounding_evidence_v1',
    groundingStrategyVersion: 'semantic_capability_discovery_v1',
    attemptId: 'source-attempt', sessionId: 'source-session', testSpecId,
    stepId: countStep.id, profileFingerprint, pageUrl: url,
    observedAt: selectedAt, expiresAt: expiredAt, mcpRevision: 2,
    dependentActionReceiptDigest: receipt.receiptDigest, domainComplete: true,
    target: countStep.subject, candidates: [candidate(0)], selectedDomainIndex: null,
    ordinalProof: null, relationProof: null,
  });
  const verificationWitness = sealSemanticGroundingWitnessV1({
    witnessVersion: 'semantic_verification_grounding_v1', step: countStep,
    evidence: verificationEvidence, observation: 'complete_count', property: 'cardinality',
    observed: 1, expectedSatisfied: true, settled: true,
  });
  const trace = issueSemanticGroundedTraceV1(admission, {
    attemptId: 'source-attempt', sessionId: 'source-session', profileFingerprint,
    records: [{ type: 'navigate', step: admission.spec.steps[0]!, observedUrl: url },
      { type: 'action', witness: actionWitness, receipt },
      { type: 'verification', witness: verificationWitness }],
  });
  return { admission, trace };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'semantic-grounded-trace-store-'));
  const store = new SemanticGroundedTraceV1Store(root);
  const { admission, trace } = fixture();
  const ref = await store.writeSuccessfulGroundingV1(admission, trace);
  return { root, store, admission, trace, ref, close: async () => {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error('Unexpected test cleanup root');
    await rm(root, { recursive: true, force: true });
  } };
}

type Stored = Record<string, unknown> & { trace: Record<string, unknown>;
  sourceBinding: Record<string, unknown>; profileBinding: Record<string, unknown> };
async function rewrite(file: string, mutate: (artifact: Stored) => void, root?: string) {
  const artifact = JSON.parse(await readFile(file, 'utf8')) as Stored;
  mutate(artifact);
  if (root) {
    const { authentication: _old, ...data } = artifact;
    const key = await readFile(path.join(root, '.semantic-grounded-trace-v1-authority'));
    artifact.authentication = createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
  }
  await writeFile(file, JSON.stringify(artifact));
}

test('authenticated round trip recreates historical compiler source without the original trace', async () => {
  const f = await setup();
  try {
    const expected = JSON.stringify(f.trace);
    const digest = semanticIntentCanonicalDigestV3(f.admission.spec);
    const reloaded = await new SemanticGroundedTraceV1Store(f.root)
      .readSuccessfulGroundingV1(f.ref.testSpecId, f.ref.attemptId, f.admission);
    expect(reloaded).not.toBe(f.trace);
    expect(JSON.stringify(reloaded)).toBe(expected);
    expect(() => requireIssuedSemanticGroundedTraceV1(reloaded)).not.toThrow();
    expect(Object.isFrozen(reloaded.records[1])).toBe(true);
    expect(Object.isFrozen(f.admission.spec.steps[1])).toBe(true);
    expect(parseSemanticGroundedTraceV1(reloaded, f.admission)).toEqual(reloaded);
    expect(semanticIntentCanonicalDigestV3(f.admission.spec)).toBe(digest);
    expect(reloaded.records[1]?.type === 'action' &&
      Date.parse(reloaded.records[1].witness.evidence.expiresAt) < Date.now()).toBe(true);
    expect(f.ref.traceDigest).toBe(reloaded.traceDigest);
    expect(f.ref.traceId).toBe(`semanticTrace${reloaded.traceDigest.slice(0, 32)}`);
    await expect(f.store.writeSuccessfulGroundingV1(f.admission, f.trace))
      .rejects.toMatchObject({ code: 'EEXIST' });
  } finally { await f.close(); }
});

test('writer refuses unissued or mutated historical traces', async () => {
  const f = await setup();
  try {
    await expect(f.store.writeSuccessfulGroundingV1(f.admission, structuredClone(f.trace)))
      .rejects.toThrow('UNTRUSTED_SEMANTIC_TRACE');
    const original = f.trace.records[1];
    if (original?.type !== 'action') throw new Error('Expected action');
    original.witness.evidence.candidates[0]!.name = 'Substituted';
    await expect(f.store.writeSuccessfulGroundingV1(f.admission, f.trace)).rejects.toThrow();
  } finally { await f.close(); }
});

test('writer refuses a mutated trusted admission source binding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'semantic-grounded-trace-admission-'));
  const { admission, trace } = fixture();
  try {
    const step = admission.spec.steps[1];
    if (step?.type !== 'action_intent') throw new Error('Expected action');
    step.target.exactName = 'Other';
    await expect(new SemanticGroundedTraceV1Store(root)
      .writeSuccessfulGroundingV1(admission, trace))
      .rejects.toThrow('SEMANTIC_GROUNDED_TRACE_ADMISSION_MISMATCH');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reloaded historical trace reaches compiler input boundary but still requires a fresh protected session', async () => {
  const f = await setup();
  const originalOpen = McpExplorationSession.open;
  let freshOpenAttempts = 0;
  try {
    const reloaded = await new SemanticGroundedTraceV1Store(f.root)
      .readSuccessfulGroundingV1(f.ref.testSpecId, f.ref.attemptId, f.admission);
    McpExplorationSession.open = async () => {
      freshOpenAttempts++;
      throw new Error('OFFLINE_FRESH_SESSION_UNAVAILABLE');
    };
    const factory = { catalog: { resolve: () => ({}) } } as unknown as ProtectedContextFactory;
    const result = await compileSemanticGroundedTraceV1(factory,
      f.admission, reloaded);
    expect(freshOpenAttempts).toBe(1);
    expect(result.kind).toBe('compilation_stop');
    expect(result.resolved).toBeUndefined();
    expect(requireSemanticCompilerRejectionV1(result)).toMatchObject({
      phase: 'protected_session', category: 'ENVIRONMENT_UNAVAILABLE',
    });
  } finally { McpExplorationSession.open = originalOpen; await f.close(); }
});

const corruptions: ReadonlyArray<readonly [string, (artifact: Stored) => void]> = [
  ['step order', (a) => { (a.trace.records as unknown[]).reverse(); }],
  ['grounded operation', (a) => { ((a.trace.records as Array<any>)[1].witness).mechanic = 'fill'; }],
  ['candidate cardinality', (a) => { ((a.trace.records as Array<any>)[1].witness.evidence.candidates).pop(); }],
  ['ordinal index', (a) => { ((a.trace.records as Array<any>)[1].witness.evidence).selectedDomainIndex = 1; }],
  ['mechanic', (a) => { ((a.trace.records as Array<any>)[1].receipt).mechanic = 'check'; }],
  ['verification expected value', (a) => { ((a.trace.records as Array<any>)[2].witness.step).expected = 2; }],
  ['source TestSpec ID', (a) => { a.trace.testSpecId = 'substituted'; }],
  ['source digest', (a) => { a.sourceBinding.specDigest = 'b'.repeat(64); }],
  ['profile fingerprint', (a) => { a.profileBinding.profileFingerprint = 'b'.repeat(64); }],
  ['grounding version', (a) => { ((a.trace.records as Array<any>)[1].witness.evidence).groundingStrategyVersion = '2'; }],
  ['trace version', (a) => { a.trace.traceVersion = '2'; }],
  ['evidence reference', (a) => { ((a.trace.records as Array<any>)[2].witness.evidence).dependentActionReceiptDigest = 'b'.repeat(64); }],
  ['storage version', (a) => { a.storageVersion = '2'; }],
];
for (const [name, mutate] of corruptions) test(`reader rejects changed ${name}`, async () => {
  const f = await setup();
  try {
    await rewrite(f.ref.path, mutate);
    await expect(f.store.readSuccessfulGroundingV1(f.ref.testSpecId, f.ref.attemptId,
      f.admission)).rejects.toThrow();
  } finally { await f.close(); }
});

test('signed but inconsistent evidence and source bindings still reject', async () => {
  for (const mutate of [
    (a: Stored) => { a.sourceBinding.sourceDigest = 'b'.repeat(64); },
    (a: Stored) => { a.profileBinding.profileFingerprint = 'b'.repeat(64); },
    (a: Stored) => { ((a.trace.records as Array<any>)[1].witness.evidence).dependentActionReceiptDigest = 'b'.repeat(64); },
  ]) {
    const f = await setup();
    try {
      await rewrite(f.ref.path, mutate, f.root);
      await expect(f.store.readSuccessfulGroundingV1(f.ref.testSpecId, f.ref.attemptId,
        f.admission)).rejects.toThrow();
    } finally { await f.close(); }
  }
});

test('malformed, truncated, unauthenticated and cross-root artifacts reject', async () => {
  for (const contents of ['{', '{"storageVersion":"1"}']) {
    const f = await setup();
    try {
      await writeFile(f.ref.path, contents);
      await expect(f.store.readSuccessfulGroundingV1(f.ref.testSpecId, f.ref.attemptId,
        f.admission)).rejects.toThrow();
    } finally { await f.close(); }
  }
  const first = await setup(), second = await setup();
  try {
    await writeFile(second.ref.path, await readFile(first.ref.path));
    await expect(second.store.readSuccessfulGroundingV1(second.ref.testSpecId, second.ref.attemptId,
      second.admission)).rejects.toThrow('UNAUTHENTICATED_SEMANTIC_GROUNDED_TRACE');
  } finally { await first.close(); await second.close(); }
});
