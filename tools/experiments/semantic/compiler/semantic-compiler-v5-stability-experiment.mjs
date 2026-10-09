import { repoRoot, importProduct, requiredStoreArtifact } from '../../paths.mjs';
/** Compiler-v5 stability cohort over one authenticated historical trace and a local fixture. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createSemanticGroundingTestFixtureSourceV1, expectedSemanticDigest,
  publicRoot, destination } from '../grounding/semantic-grounding-v1-test-fixture-source.mjs';

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
};
const [{ SemanticGroundedTraceV1Store }, { SemanticCompilerDiagnosticsV1Store },
  { requireSemanticCompilerRejectionV1, requireSemanticCompilerSealedStepsV5 },
  grounding, profiles, { compileSemanticGroundedTraceV1 }] = await Promise.all([
  importProduct('evidence/semantic-grounded-trace-v1-store.js'),
  importProduct('evidence/semantic-compiler-diagnostics-v1.js'),
  importProduct('exploration/semantic-trace-compiler-v5.js'),
  importProduct('domain/semantic-grounding-v1.js'),
  importProduct('profile/index.js'),
  importProduct('exploration/semantic-trace-compiler-v5.js'),
]);

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
async function writeSafe(directory, name, value) {
  const target = path.join(directory, name), pending = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(pending, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(pending, target); } finally { await unlink(pending).catch(() => {}); }
}

function canonicalGroundingProjection(trace) {
  const documentGroups = new Map();
  const documentGroup = url => {
    if (!documentGroups.has(url)) documentGroups.set(url, documentGroups.size + 1);
    return documentGroups.get(url);
  };
  const steps = trace.records.map((record, stepIndex) => {
    if (record.type === 'navigate') return {
      order: stepIndex + 1, kind: 'navigation', operationFamily: 'navigate',
      url: record.step.url, candidateDomainCardinality: null, selectedCandidateIndex: null,
      mechanic: null, authoredOrdinal: null, relationship: 'none', verificationStrategy: null,
      observation: 'url', resultingValue: record.observedUrl,
      documentGroup: documentGroup(record.observedUrl),
    };
    const { witness } = record;
    const { evidence, step } = witness;
    if (record.type === 'action') return {
      order: stepIndex + 1, stepId: step.id, kind: 'action',
      operationFamily: step.desiredEffect, targetCategory: step.target.category,
      targetNameDigest: step.target.exactName === null ? null : sha256(step.target.exactName),
      candidateDomainCardinality: evidence.candidates.length,
      selectedCandidateIndex: evidence.selectedDomainIndex, mechanic: witness.mechanic,
      authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? step.target.ordinal,
      ordinalProof: evidence.ordinalProof ? {
        completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
        selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex,
      } : null,
      relationship: evidence.relationProof?.kind ?? 'none',
      receiptClass: record.receipt.commandReturned ? record.receipt.effectStatus : 'invalid',
      pageUrlBefore: record.receipt.beforePageUrl, pageUrlAfter: record.receipt.afterPageUrl,
      documentGroupBefore: documentGroup(record.receipt.beforePageUrl),
      documentGroupAfter: documentGroup(record.receipt.afterPageUrl),
    };
    return {
      order: stepIndex + 1, stepId: step.id, kind: 'verification',
      operationFamily: step.observable, targetCategory: step.subject?.category ?? null,
      targetNameDigest: step.subject?.exactName ? sha256(step.subject.exactName) : null,
      candidateDomainCardinality: evidence.candidates.length,
      selectedCandidateIndex: evidence.selectedDomainIndex,
      authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? null,
      ordinalProof: evidence.ordinalProof ? {
        completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
        selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex,
      } : null,
      relationship: evidence.relationProof?.kind ?? 'none',
      verificationStrategy: witness.observation, assertionProperty: witness.property,
      resultingValue: witness.observed, expectedSatisfied: witness.expectedSatisfied,
      documentGroup: documentGroup(evidence.pageUrl),
    };
  });
  return { version: 'semantic-grounding-v1-test-fixture-projection-1', steps };
}
const canonicalGroundingDigest = trace => sha256(JSON.stringify(canonicalGroundingProjection(trace)));

function resolvedProjection(resolved, profile) {
  const domain = value => ({ completeRequired: value.completeRequired, roles: value.roles,
    exactName: value.exactName, context: value.context, groundedCount: value.groundedCount,
    requireGroundedCount: value.requireGroundedCount, selectedIndex: value.selectedIndex,
    ordinal: value.ordinal, relation: value.relation ? {
      kind: value.relation.kind, relatedStepId: value.relation.relatedStepId,
    } : null });
  const target = value => value ? ({ role: value.role, name: value.name, exactName: value.exactName,
    context: value.context, contextProof: value.contextProof, frame: value.frame }) : null;
  const steps = resolved.executionSteps.map(step => {
    if (step.type === 'navigate') return { stepId: step.stepId, type: step.type, url: step.url };
    if (step.type === 'action') return { stepId: step.stepId, type: step.type,
      operation: step.operation, target: target(step.target), domain: domain(step.domain),
      argument: step.argument, expectedChecked: step.expectedChecked,
      option: step.option ? { label: step.option.label, value: step.option.value,
        uniqueOwnedMapping: step.option.uniqueOwnedMapping } : null };
    if (step.type === 'assert_count') return { stepId: step.stepId, type: step.type,
      domain: domain(step.domain), operator: step.operator, expected: step.expected, wait: step.wait };
    if (step.type === 'assert_url') return { stepId: step.stepId, type: step.type,
      expected: step.expected, wait: step.wait };
    if (step.type === 'assert_boolean') return { stepId: step.stepId, type: step.type,
      domain: domain(step.domain), target: target(step.target), property: step.property,
      expected: step.expected, wait: step.wait };
    if (step.type === 'assert_value') return { stepId: step.stepId, type: step.type,
      domain: domain(step.domain), target: target(step.target), expected: step.expected, wait: step.wait };
    return { stepId: step.stepId, type: step.type, domain: domain(step.domain),
      target: target(step.target), label: step.label, value: step.value, expected: step.expected, wait: step.wait };
  });
  return { version: 'semantic-resolved-v10-test-projection-1', profile: {
    browserBackend: 'local-windows', browserIsolation: profile.browserIsolation,
    browserRuntime: profile.browserRuntime, browser: profile.browser,
    presentationMode: profile.presentationMode, viewport: profile.viewport,
    locale: profile.locale, timeoutPolicy: profile.timeoutPolicy,
  }, steps };
}

const { source, normalized, semanticDigest, admissionForAttempt } =
  createSemanticGroundingTestFixtureSourceV1(expected.testSpecId);
if (semanticDigest !== expected.semanticDigest || semanticDigest !== expectedSemanticDigest ||
    normalized.steps.length !== 8) throw new Error('SOURCE_SEMANTIC_PREFLIGHT_FAILED');
const browserProfile = profiles.LocalWindowsExecutionProfileSchema.parse({
  id: source.executionProfileRef.id, version: source.executionProfileRef.version,
  profileSchemaVersion: '5', presentationMode: 'headless', browserIsolation: 'local-windows',
  browserRuntime: 'playwright-chromium-windows', browser: 'chromium',
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 2000 } },
});
const catalog = new profiles.NativeProfileCatalog([browserProfile]);
const factory = new profiles.ProtectedContextFactory(catalog);
const effective = catalog.resolve(source.executionProfileRef);
if (effective.profile.profileSchemaVersion !== '5' ||
    effective.profile.browserIsolation !== 'local-windows' ||
    effective.profile.browserRuntime !== 'playwright-chromium-windows')
  throw new Error('LOCAL_WINDOWS_SCHEMA5_PROFILE_REQUIRED');

// Preflight the exact persisted source before creating any compiler attempt/browser.
const store = new SemanticGroundedTraceV1Store(sourceRoot);
const preflightAdmission = admissionForAttempt();
const preflightTrace = await store.readSuccessfulGroundingV1(expected.testSpecId, expected.attemptId,
  preflightAdmission);
expected.traceDigest = preflightTrace.traceDigest;
expected.traceId = `semanticTrace${preflightTrace.traceDigest.slice(0, 32)}`;
if (preflightTrace.testSpecId !== expected.testSpecId ||
    preflightTrace.profileFingerprint !== effective.fingerprint ||
    canonicalGroundingDigest(preflightTrace) !== expected.groundingDigest)
  throw new Error('AUTHENTICATED_SOURCE_TRACE_PREFLIGHT_FAILED');

const mode = process.env.SEMANTIC_COMPILER_V5_STABILITY_MODE ?? 'preflight';
if (mode === 'preflight') {
  process.stdout.write(`${JSON.stringify({ mode, authenticated: true, traceId: expected.traceId,
    semanticDigest, groundingDigest: canonicalGroundingDigest(preflightTrace),
    profileFingerprintMatches: preflightTrace.profileFingerprint === effective.fingerprint,
    browserBackend: effective.profile.browserIsolation, profileSchemaVersion: effective.profile.profileSchemaVersion })}\n`);
  process.exit(0);
}
if (mode !== 'cohort') throw new Error('Unsupported compiler experiment mode');

const runId = `semantic-compiler-v5-stability-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const artifactRoot = path.join(root, 'artifacts', runId);
const diagnosticsRoot = path.join(artifactRoot, 'compiler-diagnostics');
await mkdir(diagnosticsRoot, { recursive: true });
const diagnosticsStore = new SemanticCompilerDiagnosticsV1Store(diagnosticsRoot);
const canonicalOrigin = new URL(publicRoot).origin;
const localRootHtml = '<!doctype html><html><body><a href="https://the-internet.herokuapp.com/add_remove_elements/">Add/Remove Elements</a></body></html>';
const localDestinationHtml = `<!doctype html><html><body><button id="add">Add Element</button><script>
document.querySelector('#add').addEventListener('click',()=>{const b=document.createElement('button');b.textContent='Delete';
b.addEventListener('click',()=>b.remove());document.body.appendChild(b);});</script></body></html>`;
const originalOpen = factory.open.bind(factory);
let activeFixtureStats;
factory.open = async (reference, expectedProfile, options) => {
  const session = await originalOpen(reference, expectedProfile, options);
  const stats = activeFixtureStats;
  if (stats) stats.opened = true;
  try {
    await session.context.route('**/*', async route => {
      let url;
      try { url = new URL(route.request().url()); }
      catch { if (stats) stats.blocked++; await route.abort(); return; }
      if (url.origin === canonicalOrigin && url.pathname === '/') {
        if (stats) stats.fulfilled++;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: localRootHtml });
        return;
      }
      if (url.origin === canonicalOrigin && url.pathname === '/add_remove_elements/') {
        if (stats) stats.fulfilled++;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: localDestinationHtml });
        return;
      }
      if (stats) stats.blocked++;
      await route.abort('blockedbyclient');
    });
    return session;
  } catch (error) { await session.close(); throw error; }
};

const attempts = [];
for (let number = 1; number <= 10; number++) {
  const admission = admissionForAttempt();
  const trace = await store.readSuccessfulGroundingV1(expected.testSpecId, expected.attemptId, admission);
  const outcome = { attempt: number, compilerAttemptId: null, sourceTraceId: expected.traceId,
    sourceTraceDigest: trace.traceDigest, sourceAuthenticated: true,
    semanticDigest: semanticDigest, groundingDigest: canonicalGroundingDigest(trace),
    browserContext: 'not_started', compilerResult: 'not_started', resolvedSpecId: null,
    canonicalResolvedDigest: null, failure: null, cleanup: 'not_started',
    fixtureFulfillCount: 0, blockedRequests: 0, invariants: null, freshness: [] };
  if (trace.traceDigest !== expected.traceDigest || outcome.semanticDigest !== expected.semanticDigest ||
      outcome.groundingDigest !== expected.groundingDigest)
    throw new Error(`SOURCE_TRACE_CHANGED_ATTEMPT_${number}`);
  await diagnosticsStore.writeTrace(trace, admission);
  activeFixtureStats = { opened: false, fulfilled: 0, blocked: 0 };
  const compilation = await compileSemanticGroundedTraceV1(factory, admission, trace);
  outcome.browserContext = activeFixtureStats.opened ? 'fresh_context_initialized' : 'not_initialized';
  outcome.fixtureFulfillCount = activeFixtureStats.fulfilled;
  outcome.blockedRequests = activeFixtureStats.blocked;
  outcome.compilerAttemptId = compilation.compiler.compilerAttemptId;
  outcome.compilerResult = compilation.kind;
  outcome.cleanup = compilation.compiler.cleanup;
  if (compilation.kind === 'compiled' && compilation.resolved) {
    outcome.resolvedSpecId = compilation.resolved.resolvedSpecId;
    const projection = resolvedProjection(compilation.resolved, effective.profile);
    outcome.canonicalResolvedDigest = sha256(JSON.stringify(projection));
    const byId = new Map(compilation.resolved.executionSteps.map(step => [step.stepId, step]));
    const add1 = byId.get('s4'), add2 = byId.get('s5'), count2 = byId.get('s6'),
      firstDelete = byId.get('s7'), count1 = byId.get('s8');
    const seals = requireSemanticCompilerSealedStepsV5(compilation);
    outcome.freshness = seals.map(seal => ({ stepId: seal.stepId,
      sourceCurrentCorrespondence: seal.sourceCurrentCorrespondence,
      currentEvidenceAgeAtUseMs: seal.currentEvidenceAgeAtUseMs,
      preActionEvidenceAgeAtValidation: seal.preActionEvidenceAgeAtValidation ?? null,
      preActionFreshnessPassed: seal.preActionFreshnessPassed ?? null,
      actionDurationMs: seal.actionDurationMs ?? null,
      postActionEffectFreshnessPassed: seal.postActionEffectFreshnessPassed ?? null,
      actionStepSealed: seal.recordType === 'action' ? !!seal.actionStepSealedAt : null }));
    outcome.invariants = {
      add1ClickSingleCandidate: add1?.type === 'action' && add1.operation === 'click' &&
        add1.domain.completeRequired && add1.domain.groundedCount === 1 && add1.domain.requireGroundedCount,
      add2ClickSingleCandidateNoPersistentIdentity: add2?.type === 'action' && add2.operation === 'click' &&
        add2.domain.completeRequired && add2.domain.groundedCount === 1 && add2.domain.relation === null,
      deleteCount2CompleteSet: count2?.type === 'assert_count' && count2.domain.completeRequired &&
        count2.domain.requireGroundedCount === false && count2.domain.groundedCount === 2 &&
        count2.operator === 'equals' && count2.expected === 2,
      firstDeleteOrdinalFirst: firstDelete?.type === 'action' && firstDelete.operation === 'click' &&
        firstDelete.domain.completeRequired && firstDelete.domain.groundedCount === 2 &&
        firstDelete.domain.ordinal === 1 && firstDelete.domain.selectedIndex === 0 &&
        firstDelete.domain.relation === null,
      deleteCount1FreshCompleteSet: count1?.type === 'assert_count' && count1.domain.completeRequired &&
        count1.domain.requireGroundedCount === false && count1.domain.groundedCount === 1 &&
        count1.operator === 'equals' && count1.expected === 1,
      correspondenceAndFreshnessPassed: seals.filter(seal => seal.recordType !== 'navigate')
        .every(seal => seal.sourceCurrentCorrespondence === true &&
          seal.currentEvidenceAgeAtUseMs >= 0 && seal.currentEvidenceAgeAtUseMs <= 10_000) &&
        seals.filter(seal => seal.recordType === 'action').every(seal =>
          seal.preActionFreshnessPassed === true && seal.postActionEffectFreshnessPassed === true &&
          seal.actionStepSealedAt !== null),
      localFixtureOnly: outcome.fixtureFulfillCount === 2 && outcome.blockedRequests === 0,
    };
    if (!Object.values(outcome.invariants).every(Boolean)) outcome.compilerResult = 'compiled_invariant_failure';
  } else {
    const rejection = requireSemanticCompilerRejectionV1(compilation);
    outcome.failure = rejection;
    await diagnosticsStore.writeRejection(compilation, trace);
    outcome.diagnosticsPersisted = true;
  }
  // The compiler owns and closes the protected session; route fulfillment is installed inside
  // factory.open before MCP can navigate, and all non-fixture requests are aborted.
  activeFixtureStats = undefined;
  attempts.push(outcome);
  await writeSafe(artifactRoot, `attempt-${String(number).padStart(2, '0')}.json`, outcome);
}

const oneDigest = new Set(attempts.map(attempt => attempt.canonicalResolvedDigest).filter(Boolean)).size === 1;
const stable = attempts.length === 10 && attempts.every(attempt =>
  attempt.compilerResult === 'compiled' && attempt.cleanup === 'verified' &&
  attempt.invariants && Object.values(attempt.invariants).every(Boolean) &&
  attempt.sourceTraceDigest === expected.traceDigest && attempt.semanticDigest === expected.semanticDigest &&
  attempt.groundingDigest === expected.groundingDigest) && oneDigest;
const summary = { classification: stable ? 'COMPILER_STAGE_STABLE' : 'INCONCLUSIVE', source: { ...expected,
  artifactPath: sourceArtifact, authenticated: true }, attempts: attempts.map(attempt => ({
  attempt: attempt.attempt, compilerAttemptId: attempt.compilerAttemptId,
  sourceTraceId: attempt.sourceTraceId, sourceTraceDigest: attempt.sourceTraceDigest,
  semanticDigest: attempt.semanticDigest, groundingDigest: attempt.groundingDigest,
  browserContext: attempt.browserContext, compilerResult: attempt.compilerResult,
  resolvedSpecId: attempt.resolvedSpecId, canonicalResolvedDigest: attempt.canonicalResolvedDigest,
  failure: attempt.failure, cleanup: attempt.cleanup, invariants: attempt.invariants,
  freshness: attempt.freshness, fixtureFulfillCount: attempt.fixtureFulfillCount,
  blockedRequests: attempt.blockedRequests, diagnosticsPersisted: attempt.diagnosticsPersisted ?? false,
})), providerCalls: 0, publicSiteCalls: 0, runnerReplayQaInvoked: false,
successCount: attempts.filter(attempt => attempt.compilerResult === 'compiled' && attempt.cleanup === 'verified').length,
cleanupSuccesses: attempts.filter(attempt => attempt.cleanup === 'verified').length,
uniqueCanonicalResolvedDigests: [...new Set(attempts.map(attempt => attempt.canonicalResolvedDigest).filter(Boolean))],
materialCompilerVariance: new Set(attempts.map(attempt => attempt.canonicalResolvedDigest).filter(Boolean)).size > 1,
artifactRoot, diagnosticsRoot };
await writeSafe(artifactRoot, 'summary.json', summary);
process.stdout.write(`${JSON.stringify(summary)}\n`);
