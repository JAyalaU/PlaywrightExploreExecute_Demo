import { repoRoot, importProduct, requiredStoreArtifact } from '../../paths.mjs';
/** Prepare one authenticated compiler-v5 result for a later replay-only experiment. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createSemanticGroundingTestFixtureSourceV1, expectedSemanticDigest,
  publicRoot } from '../grounding/semantic-grounding-v1-test-fixture-source.mjs';

const root = repoRoot;
const sourceInput = await requiredStoreArtifact('SEMANTIC_GROUNDED_TRACE_ARTIFACT',
  'semantic-grounded-trace-v1');
const sourceArtifact = sourceInput.file;
const sourceRoot = sourceInput.root;
const expected = {
  traceId: null,
  testSpecId: sourceInput.testSpecId,
  attemptId: sourceInput.attemptId,
  traceDigest: null,
  semanticDigest: '154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d',
  groundingDigest: '58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7',
  resolvedDigest: 'fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449',
};

const [traceStoreModule, compilerStoreModule, compilerDiagnosticsModule, compilerModule,
  domain, profiles] = await Promise.all([
  importProduct('evidence/semantic-grounded-trace-v1-store.js'),
  importProduct('evidence/semantic-compiler-store-v5.js'),
  importProduct('evidence/semantic-compiler-diagnostics-v1.js'),
  importProduct('exploration/semantic-trace-compiler-v5.js'),
  importProduct('domain/semantic-grounding-v1.js'),
  importProduct('profile/index.js'),
]);
const { SemanticGroundedTraceV1Store } = traceStoreModule;
const { SemanticCompilerV5Store, requireTrustedSemanticResolvedReadbackV10 } = compilerStoreModule;
const { SemanticCompilerDiagnosticsV1Store } = compilerDiagnosticsModule;
const { requireSemanticCompilerRejectionV1, requireSemanticCompilerSealedStepsV5,
  compileSemanticGroundedTraceV1 } = compilerModule;
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
function canonicalGroundingProjection(trace) {
  const documents = new Map();
  const document = url => { if (!documents.has(url)) documents.set(url, documents.size + 1); return documents.get(url); };
  return { version: 'semantic-grounding-v1-test-fixture-projection-1', steps: trace.records.map((record, i) => {
    if (record.type === 'navigate') return { order: i + 1, kind: 'navigation', operationFamily: 'navigate',
      url: record.step.url, candidateDomainCardinality: null, selectedCandidateIndex: null, mechanic: null,
      authoredOrdinal: null, relationship: 'none', verificationStrategy: null, observation: 'url',
      resultingValue: record.observedUrl, documentGroup: document(record.observedUrl) };
    const { witness } = record, { evidence, step } = witness;
    if (record.type === 'action') return { order: i + 1, stepId: step.id, kind: 'action',
      operationFamily: step.desiredEffect, targetCategory: step.target.category,
      targetNameDigest: step.target.exactName === null ? null : sha256(step.target.exactName),
      candidateDomainCardinality: evidence.candidates.length, selectedCandidateIndex: evidence.selectedDomainIndex,
      mechanic: witness.mechanic, authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? step.target.ordinal,
      ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
        selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
      relationship: evidence.relationProof?.kind ?? 'none',
      receiptClass: record.receipt.commandReturned ? record.receipt.effectStatus : 'invalid',
      pageUrlBefore: record.receipt.beforePageUrl, pageUrlAfter: record.receipt.afterPageUrl,
      documentGroupBefore: document(record.receipt.beforePageUrl), documentGroupAfter: document(record.receipt.afterPageUrl) };
    return { order: i + 1, stepId: step.id, kind: 'verification', operationFamily: step.observable,
      targetCategory: step.subject?.category ?? null,
      targetNameDigest: step.subject?.exactName ? sha256(step.subject.exactName) : null,
      candidateDomainCardinality: evidence.candidates.length, selectedCandidateIndex: evidence.selectedDomainIndex,
      authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? null,
      ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
        selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
      relationship: evidence.relationProof?.kind ?? 'none', verificationStrategy: witness.observation,
      assertionProperty: witness.property, resultingValue: witness.observed,
      expectedSatisfied: witness.expectedSatisfied, documentGroup: document(evidence.pageUrl) };
  }) };
}
function resolvedProjection(resolved, profile) {
  const domain = value => ({ completeRequired: value.completeRequired, roles: value.roles,
    exactName: value.exactName, context: value.context, groundedCount: value.groundedCount,
    requireGroundedCount: value.requireGroundedCount, selectedIndex: value.selectedIndex,
    ordinal: value.ordinal, relation: value.relation ? { kind: value.relation.kind,
      relatedStepId: value.relation.relatedStepId } : null });
  const target = value => value ? ({ role: value.role, name: value.name, exactName: value.exactName,
    context: value.context, contextProof: value.contextProof, frame: value.frame }) : null;
  const steps = resolved.executionSteps.map(step => {
    if (step.type === 'navigate') return { stepId: step.stepId, type: step.type, url: step.url };
    if (step.type === 'action') return { stepId: step.stepId, type: step.type, operation: step.operation,
      target: target(step.target), domain: domain(step.domain), argument: step.argument,
      expectedChecked: step.expectedChecked, option: step.option ? { label: step.option.label,
        value: step.option.value, uniqueOwnedMapping: step.option.uniqueOwnedMapping } : null };
    if (step.type === 'assert_count') return { stepId: step.stepId, type: step.type, domain: domain(step.domain),
      operator: step.operator, expected: step.expected, wait: step.wait };
    if (step.type === 'assert_url') return { stepId: step.stepId, type: step.type, expected: step.expected, wait: step.wait };
    if (step.type === 'assert_boolean') return { stepId: step.stepId, type: step.type, domain: domain(step.domain),
      target: target(step.target), property: step.property, expected: step.expected, wait: step.wait };
    if (step.type === 'assert_value') return { stepId: step.stepId, type: step.type, domain: domain(step.domain),
      target: target(step.target), expected: step.expected, wait: step.wait };
    return { stepId: step.stepId, type: step.type, domain: domain(step.domain), target: target(step.target),
      label: step.label, value: step.value, expected: step.expected, wait: step.wait };
  });
  return { version: 'semantic-resolved-v10-test-projection-1', profile: {
    browserBackend: 'local-windows', browserIsolation: profile.browserIsolation,
    browserRuntime: profile.browserRuntime, browser: profile.browser,
    presentationMode: profile.presentationMode, viewport: profile.viewport, locale: profile.locale,
    timeoutPolicy: profile.timeoutPolicy,
  }, steps };
}
async function writeSafe(directory, name, value) {
  const target = path.join(directory, name), pending = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(pending, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(pending, target); } finally { await unlink(pending).catch(() => {}); }
}

const { source, normalized, semanticDigest, admissionForAttempt } =
  createSemanticGroundingTestFixtureSourceV1(expected.testSpecId);
if (semanticDigest !== expected.semanticDigest || semanticDigest !== expectedSemanticDigest || normalized.steps.length !== 8)
  throw new Error('SEMANTIC_SOURCE_PREFLIGHT_FAILED');
const profile = profiles.LocalWindowsExecutionProfileSchema.parse({
  id: source.executionProfileRef.id, version: source.executionProfileRef.version,
  profileSchemaVersion: '5', presentationMode: 'headless', browserIsolation: 'local-windows',
  browserRuntime: 'playwright-chromium-windows', browser: 'chromium',
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 2000 } },
});
const catalog = new profiles.NativeProfileCatalog([profile]);
const factory = new profiles.ProtectedContextFactory(catalog);
const effective = catalog.resolve(source.executionProfileRef);
if (effective.profile.browserIsolation !== 'local-windows' || effective.profile.profileSchemaVersion !== '5' ||
    effective.profile.browserRuntime !== 'playwright-chromium-windows') throw new Error('LOCAL_WINDOWS_PROFILE_REQUIRED');

const traceStore = new SemanticGroundedTraceV1Store(sourceRoot);
let admission = admissionForAttempt();
let trace = await traceStore.readSuccessfulGroundingV1(expected.testSpecId, expected.attemptId, admission);
expected.traceDigest = trace.traceDigest;
expected.traceId = `semanticTrace${trace.traceDigest.slice(0, 32)}`;
if (trace.testSpecId !== expected.testSpecId || trace.profileFingerprint !== effective.fingerprint ||
    sha256(JSON.stringify(canonicalGroundingProjection(trace))) !== expected.groundingDigest)
  throw new Error('AUTHENTICATED_SOURCE_PREFLIGHT_FAILED');

const runId = `semantic-resolved-v10-replay-fixture-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const artifactRoot = path.join(root, 'artifacts', runId);
const diagnosticsRoot = path.join(artifactRoot, 'compiler-diagnostics');
await mkdir(diagnosticsRoot, { recursive: true });
const diagnostics = new SemanticCompilerDiagnosticsV1Store(diagnosticsRoot);
const originalOpen = factory.open.bind(factory), origin = new URL(publicRoot).origin;
const rootHtml = '<!doctype html><html><body><a href="https://the-internet.herokuapp.com/add_remove_elements/">Add/Remove Elements</a></body></html>';
const destinationHtml = `<!doctype html><html><body><button id="add">Add Element</button><script>
document.querySelector('#add').addEventListener('click',()=>{const b=document.createElement('button');b.textContent='Delete';
b.addEventListener('click',()=>b.remove());document.body.appendChild(b);});</script></body></html>`;
let fixtureStats = { fulfilled: 0, blocked: 0, opened: false };
factory.open = async (...args) => {
  const session = await originalOpen(...args); fixtureStats.opened = true;
  try {
    await session.context.route('**/*', async route => {
      let url; try { url = new URL(route.request().url()); } catch { fixtureStats.blocked++; await route.abort(); return; }
      if (url.origin === origin && url.pathname === '/') {
        fixtureStats.fulfilled++; await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: rootHtml }); return;
      }
      if (url.origin === origin && url.pathname === '/add_remove_elements/') {
        fixtureStats.fulfilled++; await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: destinationHtml }); return;
      }
      fixtureStats.blocked++; await route.abort('blockedbyclient');
    });
    return session;
  } catch (error) { await session.close(); throw error; }
};

let compilation = await compileSemanticGroundedTraceV1(factory, admission, trace);
const result = { compilerAttemptId: compilation.compiler.compilerAttemptId,
  compilerResult: compilation.kind, cleanup: compilation.compiler.cleanup,
  sourceTraceId: expected.traceId, semanticDigest, groundingDigest: expected.groundingDigest,
  backend: effective.profile.browserIsolation, profileFingerprint: effective.fingerprint,
  fixtureFulfillCount: fixtureStats.fulfilled, blockedRequests: fixtureStats.blocked,
  providerCalls: 0, publicSiteCalls: 0, replayStarted: false };
if (compilation.kind !== 'compiled' || !compilation.resolved) {
  await diagnostics.writeTrace(trace, admission);
  const rejection = requireSemanticCompilerRejectionV1(compilation);
  result.rejection = rejection;
  await diagnostics.writeRejection(compilation, trace);
  const reportDir = path.join(root, 'artifacts', runId); await mkdir(reportDir, { recursive: true });
  await writeSafe(reportDir, 'fixture-preparation-result.json', result);
  process.stdout.write(`${JSON.stringify({ ...result, diagnosticsRoot })}\n`);
  process.exitCode = 2;
} else {
  const resolvedId = compilation.resolved.resolvedSpecId;
  const projectionDigest = sha256(JSON.stringify(resolvedProjection(compilation.resolved, effective.profile)));
  result.resolvedSpecId = resolvedId;
  result.canonicalResolvedDigest = projectionDigest;
  const byId = new Map(compilation.resolved.executionSteps.map(step => [step.stepId, step]));
  const add1 = byId.get('s4'), add2 = byId.get('s5'), count2 = byId.get('s6'), firstDelete = byId.get('s7'), count1 = byId.get('s8');
  result.invariants = {
    add1ClickSingle: add1?.type === 'action' && add1.operation === 'click' && add1.domain.completeRequired &&
      add1.domain.groundedCount === 1 && add1.domain.requireGroundedCount,
    add2ClickSingleNoIdentity: add2?.type === 'action' && add2.operation === 'click' &&
      add2.domain.completeRequired && add2.domain.groundedCount === 1 && add2.domain.relation === null,
    deleteCount2: count2?.type === 'assert_count' && count2.domain.completeRequired &&
      count2.domain.groundedCount === 2 && count2.operator === 'equals' && count2.expected === 2,
    firstDeleteOrdinal: firstDelete?.type === 'action' && firstDelete.operation === 'click' &&
      firstDelete.domain.completeRequired && firstDelete.domain.groundedCount === 2 &&
      firstDelete.domain.ordinal === 1 && firstDelete.domain.selectedIndex === 0 && firstDelete.domain.relation === null,
    deleteCount1: count1?.type === 'assert_count' && count1.domain.completeRequired &&
      count1.domain.groundedCount === 1 && count1.operator === 'equals' && count1.expected === 1,
    correspondenceFreshness: requireSemanticCompilerSealedStepsV5(compilation)
      .filter(seal => seal.recordType !== 'navigate').every(seal => seal.sourceCurrentCorrespondence === true &&
        seal.currentEvidenceAgeAtUseMs >= 0 && seal.currentEvidenceAgeAtUseMs <= 10_000),
    localFixtureOnly: fixtureStats.opened && fixtureStats.fulfilled === 2 && fixtureStats.blocked === 0,
    cleanupVerified: compilation.compiler.cleanup === 'verified',
  };
  if (projectionDigest !== expected.resolvedDigest || !Object.values(result.invariants).every(Boolean)) {
    result.status = 'STOP_R1_OR_INVARIANT_MISMATCH';
    const reportDir = path.join(root, 'artifacts', runId); await mkdir(reportDir, { recursive: true });
    await writeSafe(reportDir, 'fixture-preparation-result.json', result);
    process.stdout.write(`${JSON.stringify({ ...result, artifactRoot })}\n`);
    process.exitCode = 3;
  } else {
    const compilerStore = new SemanticCompilerV5Store(artifactRoot);
    await compilerStore.writeCompilationV5(compilation, admission, trace);
    const compilerAttemptId = compilation.compiler.compilerAttemptId;
    // Drop original capabilities and result objects before the authenticated readback.
    compilation = undefined; admission = undefined; trace = undefined;
    const reloadedAdmission = admissionForAttempt();
    const reloadedTrace = await traceStore.readSuccessfulGroundingV1(expected.testSpecId, expected.attemptId, reloadedAdmission);
    const readback = await compilerStore.readResolvedV10(expected.testSpecId, compilerAttemptId, reloadedAdmission);
    const artifact = requireTrustedSemanticResolvedReadbackV10(readback);
    const readbackDigest = sha256(JSON.stringify(resolvedProjection(artifact.resolved, effective.profile)));
    const artifactPath = path.join(artifactRoot, 'semantic-compiler-v5-resolved-v10', expected.testSpecId,
      `${compilerAttemptId}.json`);
    const readbackChecks = {
      resolvedId: artifact.resolved.resolvedSpecId === resolvedId,
      projectionDigest: readbackDigest === expected.resolvedDigest,
      traceDigest: artifact.trace.traceDigest === expected.traceDigest,
      admissionSpecDigest: artifact.admission.record.specDigest === reloadedAdmission.record.specDigest,
      profileFingerprint: artifact.compiler.profileFingerprint === effective.fingerprint,
      sourceTraceDigest: reloadedTrace.traceDigest === expected.traceDigest,
    };
    if (!Object.values(readbackChecks).every(Boolean)) {
      throw new Error(`AUTHENTICATED_RESOLVED_READBACK_MISMATCH:${JSON.stringify(readbackChecks)}`);
    }
    const reloadedSteps = new Map(artifact.resolved.executionSteps.map(step => [step.stepId, step]));
    if (reloadedSteps.get('s4')?.type !== 'action' || reloadedSteps.get('s4').operation !== 'click' ||
        reloadedSteps.get('s5')?.type !== 'action' || reloadedSteps.get('s5').operation !== 'click' ||
        reloadedSteps.get('s5').domain.relation !== null || reloadedSteps.get('s6')?.type !== 'assert_count' ||
        reloadedSteps.get('s6').expected !== 2 || reloadedSteps.get('s7')?.type !== 'action' ||
        reloadedSteps.get('s7').domain.groundedCount !== 2 || reloadedSteps.get('s7').domain.ordinal !== 1 ||
        reloadedSteps.get('s7').domain.selectedIndex !== 0 || reloadedSteps.get('s7').operation !== 'click' ||
        reloadedSteps.get('s8')?.type !== 'assert_count' || reloadedSteps.get('s8').expected !== 1)
      throw new Error('RELOADED_REPEATED_CONTROL_INVARIANT_FAILED');
    result.status = 'prepared';
    result.resolvedSpecId = artifact.resolved.resolvedSpecId;
    result.artifactPath = artifactPath;
    result.artifactContractVersion = 'storageVersion:5 / semantic_resolved_test_spec_v10';
    result.sourceTraceDigest = artifact.trace.traceDigest;
    result.recomputedResolvedDigestAfterReadback = readbackDigest;
    result.trustedRunnerInputRecreated = readback.constructor.name === 'TrustedSemanticResolvedReadbackV10';
    result.authenticatedReadback = true;
    result.repeatedControlReadbackVerified = true;
    result.artifactRoot = artifactRoot;
    await writeSafe(artifactRoot, 'fixture-preparation-result.json', result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
