import { repoRoot, importProduct } from '../../paths.mjs';
/** Provider-free, TEST_FIXTURE_ONLY grounding stability cohort for semantic-v7. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createSemanticGroundingTestFixtureSourceV1, destination,
  expectedSemanticDigest, publicRoot } from './semantic-grounding-v1-test-fixture-source.mjs';

const root = repoRoot;
const [grounding, traceDomain, explorationSession, profiles, diagnostics,
  { SemanticExplorationDiagnosticsV1Store },
  { SemanticGroundedTraceV1Store }] =
  await Promise.all([
    importProduct('exploration/semantic-grounding-v1.js'),
    importProduct('domain/semantic-resolved-v10.js'),
    importProduct('exploration/mcp.js'),
    importProduct('profile/index.js'),
    importProduct('domain/semantic-exploration-diagnostics-v1.js'),
    importProduct('evidence/semantic-exploration-diagnostics-v1.js'),
    importProduct('evidence/semantic-grounded-trace-v1-store.js'),
  ]);

const cohortId = `semantic-grounding-v1-test-fixture-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const artifactRoot = path.join(root, 'artifacts', cohortId);
await mkdir(artifactRoot, { recursive: false });
if (path.relative(artifactRoot, await realpath(artifactRoot)) !== '') throw new Error('INVALID_EXPERIMENT_ROOT');

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
async function recordSafe(name, value) {
  const target = path.join(artifactRoot, name), pending = path.join(artifactRoot, `.pending-${randomUUID()}`);
  const handle = await open(pending, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(pending, target); } finally { await unlink(pending).catch(() => {}); }
}
// The source builder accepts the persisted TestSpec ID on later compiler experiments.
const { source, normalized, semanticDigest, admissionForAttempt } =
  createSemanticGroundingTestFixtureSourceV1();
const fixtureProjection = {
  authority: 'TEST_FIXTURE_ONLY',
  stepCount: normalized.steps.length,
  semanticDigest,
  expectedDigest: expectedSemanticDigest,
  matching: semanticDigest === expectedSemanticDigest,
  steps: normalized.steps.map((step, index) => ({ index: index + 1, id: step.id, type: step.type,
    dependency: step.dependsOnStepId, target: step.type === 'action_intent' ? step.target :
      step.type === 'verification_intent' ? step.subject : null,
    desiredEffect: step.type === 'action_intent' ? step.desiredEffect : null,
    observable: step.type === 'verification_intent' ? step.observable : null,
    expected: step.type === 'verification_intent' ? step.expected : null })),
};
await recordSafe('fixture-preflight.json', fixtureProjection);
if (normalized.steps.length !== 8 || semanticDigest !== expectedSemanticDigest) {
  await recordSafe('summary.json', { classification: 'FIXTURE_DIGEST_MISMATCH', fixtureProjection,
    providerCalls: 0, browserAttempts: 0, attempts: [] });
  process.stdout.write(`${JSON.stringify({ classification: 'FIXTURE_DIGEST_MISMATCH', fixtureProjection, attempts: [] })}\n`);
  process.exit(0);
}
if (process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_PREFLIGHT_ONLY === '1') {
  await recordSafe('summary.json', { classification: 'FIXTURE_PREFLIGHT_PASSED', fixtureProjection,
    providerCalls: 0, browserAttempts: 0, attempts: [] });
  process.stdout.write(`${JSON.stringify({ classification: 'FIXTURE_PREFLIGHT_PASSED', fixtureProjection, attempts: [] })}\n`);
  process.exit(0);
}

// This controlled fixture uses the active Windows protected backend explicitly.
const browserProfile = profiles.LocalWindowsExecutionProfileSchema.parse({
  id: source.executionProfileRef.id, version: source.executionProfileRef.version, profileSchemaVersion: '5',
  presentationMode: 'headless', browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows',
  browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 2000 } },
});
const catalog = new profiles.NativeProfileCatalog([browserProfile]);
const factory = new profiles.ProtectedContextFactory(catalog);
const effectiveProfile = catalog.resolve(source.executionProfileRef);
if (effectiveProfile.profile.profileSchemaVersion !== '5' ||
    effectiveProfile.profile.browserIsolation !== 'local-windows' ||
    effectiveProfile.profile.browserRuntime !== 'playwright-chromium-windows')
  throw new Error('LOCAL_WINDOWS_PROFILE_REQUIRED');
const attemptLimit = process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE === 'smoke' ||
  process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE === 'freeze' ? 1 :
  process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE === 'cohort' ? 10 : null;
if (attemptLimit === null) throw new Error('Set SEMANTIC_GROUNDING_TEST_FIXTURE_MODE=smoke, freeze, or cohort');
const localRootHtml = '<!doctype html><html><body><a href="https://the-internet.herokuapp.com/add_remove_elements/">Add/Remove Elements</a></body></html>';
const localDestinationHtml = `<!doctype html><html><body><button id="add">Add Element</button><script>
document.querySelector('#add').addEventListener('click',()=>{const b=document.createElement('button');b.textContent='Delete';
b.addEventListener('click',()=>b.remove());document.body.appendChild(b);});</script></body></html>`;
const canonicalOrigin = new URL(publicRoot).origin;
const diagnosticStore = new SemanticExplorationDiagnosticsV1Store(artifactRoot);
const groundedTraceStore = new SemanticGroundedTraceV1Store(artifactRoot);
const attempts = [];
const expectedGroundingDigest = '58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7';

// Experiment projection only. All decisions are read from the complete stored trace;
// runtime session/evidence identifiers and absolute revision counters are omitted.
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
      selectedCandidateIndex: evidence.selectedDomainIndex,
      mechanic: witness.mechanic,
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
      relationship: evidence.relationProof?.kind ?? 'none', verificationStrategy: witness.observation,
      assertionProperty: witness.property, resultingValue: witness.observed,
      expectedSatisfied: witness.expectedSatisfied, documentGroup: documentGroup(evidence.pageUrl),
    };
  });
  return { version: 'semantic-grounding-v1-test-fixture-projection-1', steps };
}
const canonicalGroundingDigest = trace => sha256(JSON.stringify(canonicalGroundingProjection(trace)));

for (let attemptNo = 1; attemptNo <= attemptLimit; attemptNo++) {
  const attemptId = `semanticGroundingAttempt${String(attemptNo).padStart(2, '0')}${randomUUID().replaceAll('-', '')}`;
  const outcome = { attempt: attemptNo, authority: 'TEST_FIXTURE_ONLY', testSpecId: source.testSpecId,
    semanticDigest, admission: 'not_issued', browserContext: 'not_started', explorationAttemptId: attemptId,
    grounding: 'not_started', traceId: null, failureCategory: null, failureStepId: null,
    firstFailureBoundary: null, cleanup: 'not_started', providerCalls: 0, localFixtureResponses: 0,
    blockedRequests: 0, canonicalGroundingDigest: null, steps: [], invariants: null };
  const collector = new diagnostics.SemanticExplorationDiagnosticCollectorV1(source.testSpecId, attemptId);
  const browserState = { browserLaunchAttempted: false, documentGenerationId: null,
    domContentLoadedObserved: null, mainResponseStatusClass: null, navigation: 'not_started', viewer: 'not_requested' };
  let session, currentStep, frozenTrace, frozenAdmission;
  try {
    const admission = admissionForAttempt();
    outcome.admission = 'fresh_test_fixture_capability';
    collector.record('mcp_session_started'); browserState.browserLaunchAttempted = true;
    session = await explorationSession.McpExplorationSession.open(factory, source.executionProfileRef,
      effectiveProfile, attemptId);
    outcome.browserContext = 'initialized'; collector.record('mcp_session_completed');
    const context = session.browserSession.context;
    if (context.pages().length !== 0) throw new Error('UNEXPECTED_PREEXISTING_PAGE');
    await context.route('**/*', async route => {
      let url;
      try { url = new URL(route.request().url()); }
      catch { outcome.blockedRequests++; await route.abort(); return; }
      if (url.origin === canonicalOrigin && url.pathname === '/') {
        outcome.localFixtureResponses++; await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: localRootHtml }); return;
      }
      if (url.origin === canonicalOrigin && url.pathname === '/add_remove_elements/') {
        outcome.localFixtureResponses++; await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: localDestinationHtml }); return;
      }
      outcome.blockedRequests++; await route.abort('blockedbyclient');
    });
    const groundingSession = new grounding.SemanticGroundingSessionV1(session, admission, attemptId, event => {
      collector.record(event.boundary, currentStep);
      if (event.documentGenerationId) browserState.documentGenerationId = event.documentGenerationId;
      if (event.domContentLoadedObserved !== undefined) browserState.domContentLoadedObserved = event.domContentLoadedObserved;
    });
    collector.record('grounding_session_initialized');
    const records = [], canonicalSteps = [];
    const documentGroups = new Map();
    const canonicalDocumentGroup = url => {
      if (!documentGroups.has(url)) documentGroups.set(url, documentGroups.size + 1);
      return documentGroups.get(url);
    };
    for (const [stepIndex, step] of normalized.steps.entries()) {
      currentStep = { stepId: step.id, kind: step.type === 'navigate' ? 'navigation' :
        step.type === 'action_intent' ? 'action' : 'verification',
        family: step.type === 'navigate' ? 'navigate' : step.type === 'action_intent' ? step.desiredEffect : step.observable,
        ordinalPresent: step.type === 'navigate' ? false :
          (step.type === 'action_intent' ? step.target : step.subject)?.ordinal !== null,
        relationshipPresent: step.type !== 'navigate' && ['same_as_step', 'created_by_step'].includes(
          (step.type === 'action_intent' ? step.target : step.subject)?.relation ?? 'unspecified'),
        mechanic: null, observation: null };
      collector.record('step_started', currentStep);
      if (step.type === 'navigate') {
        browserState.navigation = 'started'; collector.record('root_navigation_started', currentStep);
        await session.navigate(step.url);
        const page = context.pages()[0];
        if (!page || page.url() !== step.url) throw new Error('NAVIGATION_URL_MISMATCH');
        browserState.navigation = 'returned'; collector.record('root_navigation_returned', currentStep);
        records.push({ type: 'navigate', step, observedUrl: page.url() });
        canonicalSteps.push({ order: stepIndex + 1, kind: 'navigation', operationFamily: 'navigate',
          url: step.url, candidateDomainCardinality: null, selectedCandidateIndex: null, mechanic: null,
          authoredOrdinal: null, relationship: 'none', verificationStrategy: null, observation: 'url',
          resultingValue: page.url(), documentGroup: canonicalDocumentGroup(page.url()) });
        continue;
      }
      if (step.type === 'action_intent') {
        currentStep.mechanic = null;
        const witness = await groundingSession.groundAction(step.id);
        if (witness.mechanic !== 'click') throw new Error('UNEXPECTED_ACTION_MECHANIC');
        currentStep.mechanic = witness.mechanic; collector.record('step_grounded', currentStep);
        const receipt = await groundingSession.executeGroundedAction(witness);
        records.push({ type: 'action', witness, receipt });
        const evidence = witness.evidence;
        canonicalSteps.push({ order: stepIndex + 1, stepId: step.id, kind: 'action',
          operationFamily: step.desiredEffect, targetCategory: step.target.category,
          targetNameDigest: step.target.exactName === null ? null : sha256(step.target.exactName),
          candidateDomainCardinality: evidence.candidates.length, selectedCandidateIndex: evidence.selectedDomainIndex,
          mechanic: witness.mechanic, authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? step.target.ordinal,
          ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
            selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
          relationship: evidence.relationProof?.kind ?? 'none', receiptClass: receipt.commandReturned ? receipt.effectStatus : 'invalid',
          pageUrlBefore: receipt.beforePageUrl, pageUrlAfter: receipt.afterPageUrl,
          documentGroupBefore: canonicalDocumentGroup(receipt.beforePageUrl),
          documentGroupAfter: canonicalDocumentGroup(receipt.afterPageUrl) });
      } else {
        const witness = await groundingSession.groundVerification(step.id);
        if (!witness.expectedSatisfied) throw new Error('VERIFICATION_UNSATISFIED');
        currentStep.observation = witness.observation; collector.record('step_grounded', currentStep);
        records.push({ type: 'verification', witness });
        const evidence = witness.evidence;
        canonicalSteps.push({ order: stepIndex + 1, stepId: step.id, kind: 'verification',
          operationFamily: step.observable, targetCategory: step.subject?.category ?? null,
          targetNameDigest: step.subject?.exactName ? sha256(step.subject.exactName) : null,
          candidateDomainCardinality: evidence.candidates.length, selectedCandidateIndex: evidence.selectedDomainIndex,
          authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? null,
          ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
            selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
          relationship: evidence.relationProof?.kind ?? 'none', verificationStrategy: witness.observation,
          assertionProperty: witness.property, resultingValue: witness.observed,
          expectedSatisfied: witness.expectedSatisfied, documentGroup: canonicalDocumentGroup(evidence.pageUrl) });
        if (step.observable === 'url' && witness.observed !== destination ||
            step.observable === 'cardinality' && witness.observed !== step.expected)
          throw new Error('GROUNDING_ASSERTION_MISMATCH');
      }
    }
    const trace = traceDomain.issueSemanticGroundedTraceV1(admission, {
      attemptId, sessionId: records.find(record => record.type !== 'navigate')?.witness.evidence.sessionId,
      profileFingerprint: session.browserSession.effectiveProfile.fingerprint, records,
    });
    if (process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE === 'freeze') {
      frozenTrace = trace;
      frozenAdmission = admission;
    }
    outcome.traceId = `semanticTrace${trace.traceDigest.slice(0, 32)}`;
    outcome.grounding = 'succeeded';
    const projection = { version: 'semantic-grounding-v1-test-fixture-projection-1', steps: canonicalSteps };
    outcome.canonicalGroundingDigest = sha256(JSON.stringify(projection));
    if (canonicalGroundingDigest(trace) !== outcome.canonicalGroundingDigest)
      throw new Error('GROUNDED_TRACE_PROJECTION_MISMATCH');
    outcome.steps = canonicalSteps;
    collector.issuedTrace(outcome.traceId); collector.record('cleanup_started');
  } catch (error) {
    outcome.grounding = 'failed';
    outcome.failureCategory = error instanceof grounding.SemanticGroundingStopV1 ? error.reason :
      error instanceof Error ? error.message.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : 'UNKNOWN_CLOSED_FAILURE';
    outcome.failureStepId = currentStep?.stepId ?? null;
    outcome.firstFailureBoundary = collector.latest;
    const category = outcome.failureCategory === 'ORDINAL_OUT_OF_BOUNDS' || outcome.failureCategory === 'AMBIGUOUS_TARGET' ||
      outcome.failureCategory === 'UNRESOLVED_TARGET' || outcome.failureCategory === 'UNSUPPORTED_CAPABILITY' ?
        'GROUNDING_CANDIDATE_FAILED' : outcome.failureCategory === 'EFFECT_UNPROVEN' ? 'ACTION_EFFECT_FAILED' :
          outcome.failureCategory === 'ENVIRONMENT_UNAVAILABLE' || outcome.failureCategory === 'BROWSER_FAILURE' ?
            'BROWSER_DISCONNECTED' : browserState.navigation === 'started' ? 'ROOT_NAVIGATION_FAILED' :
              'UNKNOWN_EXPLORATION_FAILURE';
    await collector.fail(category, diagnostics.semanticExplorationBrowserSnapshotV1(session?.browserSession, browserState),
      outcome.failureStepId);
    collector.record('cleanup_started');
  } finally {
    if (session) {
      try { await session.close(); outcome.cleanup = 'succeeded'; }
      catch { outcome.cleanup = 'failed'; }
    }
    if (outcome.cleanup === 'succeeded') collector.record('cleanup_completed');
    try { await diagnosticStore.write(collector.snapshot()); } catch { outcome.diagnosticWrite = 'failed'; }
    outcome.localOnly = outcome.blockedRequests === 0 && outcome.localFixtureResponses === 2;
  }
  if (outcome.grounding === 'succeeded') {
    const actions = outcome.steps.filter(step => step.kind === 'action');
    const counts = outcome.steps.filter(step => step.kind === 'verification' && step.operationFamily === 'cardinality');
    const adds = actions.filter(step => step.targetNameDigest === sha256('Add Element'));
    const firstDelete = actions.find(step => step.targetNameDigest === sha256('Delete'));
    outcome.invariants = {
      add1UniqueClickReceipt: adds.length === 2 && adds[0]?.candidateDomainCardinality === 1 &&
        adds[0]?.mechanic === 'click' && adds[0]?.receiptClass === 'delivery_only',
      add2UniqueNoIdentityClickReceipt: adds.length === 2 && adds[1]?.candidateDomainCardinality === 1 &&
        adds[1]?.relationship === 'none' && adds[1]?.mechanic === 'click' && adds[1]?.receiptClass === 'delivery_only',
      deleteCount2CompleteSet: counts.some(step => step.resultingValue === 2 &&
        step.candidateDomainCardinality === 2 && step.verificationStrategy === 'complete_count'),
      firstDeleteOrdinalZero: firstDelete?.candidateDomainCardinality === 2 && firstDelete.selectedCandidateIndex === 0 &&
        firstDelete.ordinalProof?.completeDomainCardinality === 2 && firstDelete.ordinalProof.selectedCandidateIndex === 0 &&
        firstDelete.authoredOrdinal === 1 && firstDelete.mechanic === 'click' && firstDelete.receiptClass === 'delivery_only',
      deleteCount1FreshCompleteSet: counts.some(step => step.resultingValue === 1 &&
        step.candidateDomainCardinality === 1 && step.verificationStrategy === 'complete_count'),
      noPersistentIdentityRequirement: outcome.steps.every(step => step.relationship === 'none'),
      localFixtureOnly: outcome.localOnly,
    };
    if (process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE === 'freeze') {
      if (outcome.cleanup !== 'succeeded' || outcome.diagnosticWrite === 'failed' ||
          outcome.canonicalGroundingDigest !== expectedGroundingDigest ||
          !Object.values(outcome.invariants).every(Boolean) || !frozenTrace || !frozenAdmission)
        throw new Error('FROZEN_GROUNDED_TRACE_PRECONDITION_FAILED');
      const originalDigest = frozenTrace.traceDigest;
      const ref = await groundedTraceStore.writeSuccessfulGroundingV1(frozenAdmission, frozenTrace);
      frozenTrace = undefined;
      frozenAdmission = undefined;
      const restored = await new SemanticGroundedTraceV1Store(artifactRoot)
        .readSuccessfulGroundingV1(ref.testSpecId, ref.attemptId, admissionForAttempt());
      if (restored.traceDigest !== originalDigest ||
          canonicalGroundingDigest(restored) !== expectedGroundingDigest)
        throw new Error('FROZEN_GROUNDED_TRACE_READBACK_MISMATCH');
      outcome.frozenTraceArtifact = { path: ref.path, traceDigest: ref.traceDigest,
        storageVersion: '1', authenticatedReadback: true,
        recomputedGroundingDigest: canonicalGroundingDigest(restored) };
    }
  }
  await recordSafe(`attempt-${String(attemptNo).padStart(2, '0')}.json`, outcome);
  attempts.push(outcome);
  await recordSafe('progress.json', { authority: 'TEST_FIXTURE_ONLY', testSpecId: source.testSpecId,
    semanticDigest, providerCalls: 0, completedAttempts: attempts.length,
    attempts: attempts.map(({ attempt, grounding: result, failureCategory, cleanup, canonicalGroundingDigest }) =>
      ({ attempt, grounding: result, failureCategory, cleanup, canonicalGroundingDigest })) });
}

const summary = { authority: 'TEST_FIXTURE_ONLY', fixtureConstruction: 'semantic-v7 acceptance fixture builder pattern plus production normalize/canonicalize and test admission helper',
  testSpecId: source.testSpecId, semanticDigest, expectedSemanticDigest, stepCount: normalized.steps.length,
  mode: process.env.SEMANTIC_GROUNDING_TEST_FIXTURE_MODE,
  browserBackend: effectiveProfile.profile.browserIsolation,
  profileSchemaVersion: effectiveProfile.profile.profileSchemaVersion,
  browserIsolation: effectiveProfile.profile.browserIsolation,
  providerCalls: 0, attempts: attempts.map(({ steps, ...attempt }) => attempt),
  successCount: attempts.filter(attempt => attempt.grounding === 'succeeded').length,
  cleanupSuccesses: attempts.filter(attempt => attempt.cleanup === 'succeeded').length,
  uniqueCanonicalGroundingDigests: [...new Set(attempts.map(attempt => attempt.canonicalGroundingDigest).filter(Boolean))],
  materialGroundingVariance: new Set(attempts.filter(attempt => attempt.grounding === 'succeeded')
    .map(attempt => attempt.canonicalGroundingDigest)).size > 1,
  artifactRoot };
await recordSafe('summary.json', summary);
process.stdout.write(`${JSON.stringify(summary)}\n`);
