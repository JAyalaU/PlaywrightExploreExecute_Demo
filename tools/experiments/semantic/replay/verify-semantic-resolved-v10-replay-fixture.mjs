import { importProduct, requiredStoreArtifact } from '../../paths.mjs';
/** Readback-only verification; this script never starts a browser or compiler. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createSemanticGroundingTestFixtureSourceV1, expectedSemanticDigest } from '../grounding/semantic-grounding-v1-test-fixture-source.mjs';

const sourceInput = await requiredStoreArtifact('SEMANTIC_GROUNDED_TRACE_ARTIFACT',
  'semantic-grounded-trace-v1');
const resolvedInput = await requiredStoreArtifact('SEMANTIC_RESOLVED_V10_ARTIFACT',
  'semantic-compiler-v5-resolved-v10');
if (sourceInput.testSpecId !== resolvedInput.testSpecId) throw new Error('FIXTURE_TEST_SPEC_ID_MISMATCH');
const attemptRoot = resolvedInput.root;
const specId = resolvedInput.testSpecId;
const attemptId = resolvedInput.attemptId;
const expected = {
  traceId: null,
  traceDigest: null,
  semanticDigest: '154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d',
  groundingDigest: '58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7',
  resolvedDigest: 'fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449',
};
const [{ SemanticGroundedTraceV1Store }, { SemanticCompilerV5Store,
  requireTrustedSemanticResolvedReadbackV10 }, profileApi, compilerApi] = await Promise.all([
  importProduct('evidence/semantic-grounded-trace-v1-store.js'),
  importProduct('evidence/semantic-compiler-store-v5.js'),
  importProduct('profile/index.js'),
  importProduct('exploration/semantic-trace-compiler-v5.js'),
]);
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function resolvedProjection(resolved, profile) {
  const domain = x => ({ completeRequired: x.completeRequired, roles: x.roles, exactName: x.exactName,
    context: x.context, groundedCount: x.groundedCount, requireGroundedCount: x.requireGroundedCount,
    selectedIndex: x.selectedIndex, ordinal: x.ordinal, relation: x.relation ? {
      kind: x.relation.kind, relatedStepId: x.relation.relatedStepId } : null });
  const target = x => x ? ({ role: x.role, name: x.name, exactName: x.exactName,
    context: x.context, contextProof: x.contextProof, frame: x.frame }) : null;
  return { version: 'semantic-resolved-v10-test-projection-1', profile: {
    browserBackend: 'local-windows', browserIsolation: profile.browserIsolation,
    browserRuntime: profile.browserRuntime, browser: profile.browser,
    presentationMode: profile.presentationMode, viewport: profile.viewport,
    locale: profile.locale, timeoutPolicy: profile.timeoutPolicy,
  }, steps: resolved.executionSteps.map(s => {
    if (s.type === 'navigate') return { stepId: s.stepId, type: s.type, url: s.url };
    if (s.type === 'action') return { stepId: s.stepId, type: s.type, operation: s.operation,
      target: target(s.target), domain: domain(s.domain), argument: s.argument,
      expectedChecked: s.expectedChecked, option: s.option ? { label: s.option.label,
        value: s.option.value, uniqueOwnedMapping: s.option.uniqueOwnedMapping } : null };
    if (s.type === 'assert_count') return { stepId: s.stepId, type: s.type, domain: domain(s.domain),
      operator: s.operator, expected: s.expected, wait: s.wait };
    if (s.type === 'assert_url') return { stepId: s.stepId, type: s.type, expected: s.expected, wait: s.wait };
    if (s.type === 'assert_boolean') return { stepId: s.stepId, type: s.type, domain: domain(s.domain),
      target: target(s.target), property: s.property, expected: s.expected, wait: s.wait };
    if (s.type === 'assert_value') return { stepId: s.stepId, type: s.type, domain: domain(s.domain),
      target: target(s.target), expected: s.expected, wait: s.wait };
    return { stepId: s.stepId, type: s.type, domain: domain(s.domain), target: target(s.target),
      label: s.label, value: s.value, expected: s.expected, wait: s.wait };
  }) };
}
const { source, normalized, semanticDigest, admissionForAttempt } = createSemanticGroundingTestFixtureSourceV1(specId);
if (semanticDigest !== expected.semanticDigest || semanticDigest !== expectedSemanticDigest || normalized.steps.length !== 8)
  throw new Error('FIXTURE_SEMANTIC_BINDING_FAILED');
const profile = profileApi.LocalWindowsExecutionProfileSchema.parse({
  id: source.executionProfileRef.id, version: source.executionProfileRef.version,
  profileSchemaVersion: '5', presentationMode: 'headless', browserIsolation: 'local-windows',
  browserRuntime: 'playwright-chromium-windows', browser: 'chromium',
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 2000 } },
});
const catalog = new profileApi.NativeProfileCatalog([profile]);
const effective = catalog.resolve(source.executionProfileRef);
const admission = admissionForAttempt();
const traceStore = new SemanticGroundedTraceV1Store(sourceInput.root);
const sourceTrace = await traceStore.readSuccessfulGroundingV1(specId,
  sourceInput.attemptId, admission);
expected.traceDigest = sourceTrace.traceDigest;
expected.traceId = `semanticTrace${sourceTrace.traceDigest.slice(0, 32)}`;
const store = new SemanticCompilerV5Store(attemptRoot);
const readback = await store.readResolvedV10(specId, attemptId, admission);
const trusted = requireTrustedSemanticResolvedReadbackV10(readback);
const digest = sha(JSON.stringify(resolvedProjection(trusted.resolved, effective.profile)));
const byId = new Map(trusted.resolved.executionSteps.map(step => [step.stepId, step]));
const invariants = {
  add1Click: byId.get('s4')?.type === 'action' && byId.get('s4').operation === 'click' &&
    byId.get('s4').domain.completeRequired && byId.get('s4').domain.groundedCount === 1,
  add2ClickNoIdentity: byId.get('s5')?.type === 'action' && byId.get('s5').operation === 'click' &&
    byId.get('s5').domain.completeRequired && byId.get('s5').domain.groundedCount === 1 &&
    byId.get('s5').domain.relation === null,
  deleteCount2: byId.get('s6')?.type === 'assert_count' && byId.get('s6').domain.completeRequired &&
    byId.get('s6').expected === 2 && byId.get('s6').domain.groundedCount === 2,
  firstDelete: byId.get('s7')?.type === 'action' && byId.get('s7').operation === 'click' &&
    byId.get('s7').domain.completeRequired && byId.get('s7').domain.groundedCount === 2 &&
    byId.get('s7').domain.ordinal === 1 && byId.get('s7').domain.selectedIndex === 0,
  deleteCount1: byId.get('s8')?.type === 'assert_count' && byId.get('s8').domain.completeRequired &&
    byId.get('s8').expected === 1 && byId.get('s8').domain.groundedCount === 1,
};
const artifactPath = path.join(attemptRoot, 'semantic-compiler-v5-resolved-v10', specId, `${attemptId}.json`);
const result = { authenticatedReadback: true, trustedRunnerInputRecreated: readback.constructor.name === 'TrustedSemanticResolvedReadbackV10',
  testSpecId: specId, traceId: expected.traceId, traceDigest: sourceTrace.traceDigest,
  semanticDigest, groundingDigest: expected.groundingDigest, resolvedSpecId: trusted.resolved.resolvedSpecId,
  compilerAttemptId: attemptId, compilerResult: trusted.compiler.result.status,
  cleanup: trusted.compiler.cleanup, compilerVersion: trusted.resolved.compilerVersion,
  artifactContract: 'SemanticCompilerV5Store storageVersion 5', artifactPath,
  profile: { id: source.executionProfileRef.id, version: source.executionProfileRef.version,
    fingerprint: effective.fingerprint, backend: 'local-windows', schema: '5' },
  expectedR1: expected.resolvedDigest, recomputedR1: digest,
  invariants, providerCalls: 0, publicSiteCalls: 0, replayStarted: false };
if (sourceTrace.traceDigest !== expected.traceDigest || digest !== expected.resolvedDigest ||
    trusted.resolved.traceDigest !== expected.traceDigest || trusted.compiler.cleanup !== 'verified' ||
    trusted.resolved.profileFingerprint !== effective.fingerprint || !Object.values(invariants).every(Boolean))
  throw new Error(`FIXTURE_READBACK_VALIDATION_FAILED:${JSON.stringify(result)}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
