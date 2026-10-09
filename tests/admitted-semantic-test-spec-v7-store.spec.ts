import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { admitSemanticIntentV3, requireTrustedSemanticIntentAdmissionV3,
  type SemanticIntentStepV3 } from '../app/domain/semantic-intent-v3.js';
import { AdmittedSemanticTestSpecV7Store } from '../app/evidence/admitted-semantic-test-spec-v7-store.js';
import { SemanticGroundingSessionV1 } from '../app/exploration/semantic-grounding-v1.js';
import type { McpExplorationSession } from '../app/exploration/mcp.js';
import { semanticIntentCanonicalDigestV3 } from '../app/interpretation/semantic-intent-v3-relations.js';

const steps: SemanticIntentStepV3[] = [
  { id: 'step_1', type: 'navigate', authoredText: 'Go to https://example.test/',
    url: 'https://example.test/', dependsOnStepId: null },
  { id: 'step_2', type: 'action_intent', authoredText: 'Activate the Test link.',
    target: { category: 'link', exactName: 'Test', context: null, ordinal: null,
      relation: 'unspecified', relatedStepId: null }, desiredEffect: 'activate', value: null,
    checkedState: null, authoredMechanic: null, dependsOnStepId: 'step_1' },
];
const source = { testSpecId: 'admitted-v7-fixture',
  sourceInstruction: 'Go to https://example.test/\nActivate the Test link.',
  executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' } };
const spec = () => ({ ...source, schemaVersion: '7', sourceContractVersion: '3',
  semanticMode: 'intent_v2', normalizationVersion: 'semantic_intent_normalization_v2',
  steps: structuredClone(steps) });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'admitted-v7-store-'));
  const store = new AdmittedSemanticTestSpecV7Store(root);
  const admitted = admitSemanticIntentV3(source, spec(), { verdict: 'faithful', issues: [] });
  const ref = await store.writeAdmittedV7(admitted);
  return { root, ref, store, admitted, close: async () => {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error('Unexpected test cleanup root');
    await rm(root, { recursive: true, force: true });
  } };
}

async function rewrite(file: string, mutate: (record: Record<string, unknown>) => void,
  root?: string) {
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(record);
  if (root) {
    const { authentication: _old, ...data } = record;
    const key = await readFile(path.join(root, '.admitted-semantic-v7-authority'));
    record.authentication = createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
  }
  await writeFile(file, JSON.stringify(record));
}

test('admitted v7 round trip recreates in-process authority for grounding input', async () => {
  const f = await fixture();
  try {
    const originalDigest = semanticIntentCanonicalDigestV3(f.admitted.spec);
    const original = JSON.stringify(f.admitted.spec);
    // Recreate both store and admission from disk; the original admission is never passed to read.
    const restored = await new AdmittedSemanticTestSpecV7Store(f.root)
      .readAdmittedV7(f.ref.testSpecId);
    expect(restored).not.toBe(f.admitted);
    expect(() => requireTrustedSemanticIntentAdmissionV3(restored)).not.toThrow();
    expect(JSON.stringify(restored.spec)).toBe(original);
    expect(Object.isFrozen(restored.spec.steps[1])).toBe(true);
    expect(semanticIntentCanonicalDigestV3(restored.spec)).toBe(originalDigest);
    expect(f.ref.canonicalSemanticDigest).toBe(originalDigest);
    const fakeContext = { on: () => undefined, pages: () => [] };
    const fakeSession = { browserSession: { effectiveProfile: { profile: {
      id: 'desktop', version: '1' } }, context: fakeContext, onClosing: () => undefined } };
    expect(() => new SemanticGroundingSessionV1(fakeSession as unknown as McpExplorationSession,
      restored, 'grounding-attempt')).not.toThrow();
  } finally { await f.close(); }
});

test('writer rejects altered nested spec after trusted admission and refuses overwrite', async () => {
  const f = await fixture();
  try {
    const action = f.admitted.spec.steps[1];
    if (action?.type !== 'action_intent') throw new Error('Missing fixture action');
    action.target.exactName = 'Substituted';
    await expect(f.store.writeAdmittedV7(f.admitted)).rejects.toThrow('SEMANTIC_ADMISSION_PROVENANCE_MISMATCH');
    const independent = admitSemanticIntentV3(source, spec(), { verdict: 'faithful', issues: [] });
    await expect(f.store.writeAdmittedV7(independent)).rejects.toMatchObject({ code: 'EEXIST' });
  } finally { await f.close(); }
});

test('writer rejects an issued but noncanonical relation and ten fresh reads agree', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const read = await new AdmittedSemanticTestSpecV7Store(f.root)
        .readAdmittedV7(f.ref.testSpecId);
      expect(semanticIntentCanonicalDigestV3(read.spec)).toBe(f.ref.canonicalSemanticDigest);
      expect(() => requireTrustedSemanticIntentAdmissionV3(read)).not.toThrow();
    }
    const noncanonicalSource = { ...source, testSpecId: 'noncanonical-v7',
      sourceInstruction: 'Go to https://example.test/\nActivate one of the Test links.' };
    const noncanonical = admitSemanticIntentV3(noncanonicalSource,
      { ...spec(), ...noncanonicalSource },
      { verdict: 'faithful', issues: [] });
    await expect(f.store.writeAdmittedV7(noncanonical))
      .rejects.toThrow('NONCANONICAL_ADMITTED_SEMANTIC_SPEC');
  } finally { await f.close(); }
});

for (const [name, mutation] of [
  ['TestSpec field', (record: Record<string, unknown>) => {
    const spec = record.spec as { steps: Array<{ authoredText: string }> };
    spec.steps[1]!.authoredText = 'Different action';
  }],
  ['canonical digest', (record: Record<string, unknown>) => { record.canonicalSemanticDigest = 'a'.repeat(64); }],
  ['source binding', (record: Record<string, unknown>) => {
    (record.sourceBinding as { sourceDigest: string }).sourceDigest = 'a'.repeat(64);
  }],
  ['semantic schema version', (record: Record<string, unknown>) => { record.semanticSchemaVersion = '8'; }],
  ['source contract version', (record: Record<string, unknown>) => { record.sourceContractVersion = '4'; }],
  ['admission version', (record: Record<string, unknown>) => {
    (record.admission as { admissionVersion: string }).admissionVersion = '4';
  }],
  ['fidelity version', (record: Record<string, unknown>) => {
    (record.provenance as { fidelityContractVersion: string }).fidelityContractVersion = 'other';
  }],
] as const) test(`reader rejects tampered ${name}`, async () => {
  const f = await fixture();
  try {
    await rewrite(f.ref.path, mutation);
    await expect(f.store.readAdmittedV7(f.ref.testSpecId)).rejects.toThrow();
  } finally { await f.close(); }
});

test('reader rejects validly shaped unauthenticated and internally inconsistent signed records', async () => {
  const f = await fixture();
  try {
    await rewrite(f.ref.path, (record) => { record.authentication = 'a'.repeat(64); });
    await expect(f.store.readAdmittedV7(f.ref.testSpecId))
      .rejects.toThrow('UNAUTHENTICATED_ADMITTED_SEMANTIC_ARTIFACT');
  } finally { await f.close(); }
  const g = await fixture();
  try {
    await rewrite(g.ref.path, (record) => { record.canonicalSemanticDigest = 'a'.repeat(64); }, g.root);
    await expect(g.store.readAdmittedV7(g.ref.testSpecId))
      .rejects.toThrow('ADMITTED_SEMANTIC_DIGEST_MISMATCH');
  } finally { await g.close(); }
  for (const [name, mutation] of [
    ['source binding', (record: Record<string, unknown>) => {
      (record.sourceBinding as { sourceDigest: string }).sourceDigest = 'a'.repeat(64);
    }],
    ['TestSpec substitution', (record: Record<string, unknown>) => {
      const spec = record.spec as { steps: Array<{ authoredText: string }> };
      spec.steps[1]!.authoredText = 'Substituted';
    }],
    ['reviewer digest', (record: Record<string, unknown>) => {
      (record.admission as { reviewerDigest: string }).reviewerDigest = 'a'.repeat(64);
    }],
  ] as const) {
    const h = await fixture();
    try {
      await rewrite(h.ref.path, mutation, h.root);
      await expect(h.store.readAdmittedV7(h.ref.testSpecId), name).rejects.toThrow();
    } finally { await h.close(); }
  }
});

test('reader rejects malformed and truncated artifacts', async () => {
  for (const contents of ['{', '{"storageVersion":"1"}']) {
    const f = await fixture();
    try {
      await writeFile(f.ref.path, contents);
      await expect(f.store.readAdmittedV7(f.ref.testSpecId)).rejects.toThrow();
    } finally { await f.close(); }
  }
});

test('root-local authentication rejects an artifact copied to another job root', async () => {
  const first = await fixture(), second = await fixture();
  try {
    await writeFile(second.ref.path, await readFile(first.ref.path));
    await expect(second.store.readAdmittedV7(second.ref.testSpecId))
      .rejects.toThrow('UNAUTHENTICATED_ADMITTED_SEMANTIC_ARTIFACT');
  } finally { await first.close(); await second.close(); }
});
