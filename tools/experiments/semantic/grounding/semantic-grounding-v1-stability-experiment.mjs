import { repoRoot, importProduct } from '../../paths.mjs';
/** One interpretation fixture followed by ten provider-free protected-grounding attempts. */
if (process.env.SEMANTIC_GROUNDING_PROVIDER_STABILITY !== '1') {
  throw new Error('Set SEMANTIC_GROUNDING_PROVIDER_STABILITY=1 for this opt-in provider experiment');
}
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const root = repoRoot;
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('FIXTURE_PREPARATION_PROVIDER_CREDENTIAL_UNAVAILABLE');

const [{ createOpenAISemanticIntentModelsV3 }, fixturePreparation, relations, wire,
  { ModelCompletionFailure },
  { AdmittedSemanticTestSpecV7Store }, grounding, traceDomain, explorationSession, profiles, diagnostics] =
  await Promise.all([
    importProduct('interpretation/semantic-intent-v3-adapters.js'),
    importProduct('interpretation/semantic-grounding-fixture-preparation-v1.js'),
    importProduct('interpretation/semantic-intent-v3-relations.js'),
    importProduct('interpretation/semantic-intent-v3-wire.js'),
    importProduct('interpretation/model-failure.js'),
    importProduct('evidence/admitted-semantic-test-spec-v7-store.js'),
    importProduct('exploration/semantic-grounding-v1.js'),
    importProduct('domain/semantic-resolved-v10.js'),
    importProduct('exploration/mcp.js'),
    importProduct('profile/index.js'),
    importProduct('domain/semantic-exploration-diagnostics-v1.js'),
  ]);

const authored = `Go to https://the-internet.herokuapp.com/
Find and activate the link named "Add/Remove Elements".
Verify that the current URL is https://the-internet.herokuapp.com/add_remove_elements/
Activate the "Add Element" button twice.
Verify that exactly two "Delete" buttons exist.
Activate the first "Delete" button.
Verify that exactly one "Delete" button exists.`;
const expectedDigest = '154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d';
const publicRoot = 'https://the-internet.herokuapp.com/';
const destination = 'https://the-internet.herokuapp.com/add_remove_elements/';
const canonicalOrigin = new URL(publicRoot).origin;
const experimentId = `semantic-grounding-v1-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const artifactRoot = path.join(root, 'artifacts', experimentId);
await mkdir(artifactRoot, { recursive: false });
if (path.relative(artifactRoot, await realpath(artifactRoot)) !== '') throw new Error('INVALID_EXPERIMENT_ROOT');
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ?
  `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const targetNameDigest = value => value?.exactName ? sha256(value.exactName) : null;
const recordSafe = async (filename, value) => {
  const file = path.join(artifactRoot, filename), temp = path.join(artifactRoot, `.pending-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await (await import('node:fs/promises')).rename(temp, file);
};

const source = { testSpecId: `semantic-grounding-${randomUUID().replaceAll('-', '')}`,
  sourceInstruction: authored, executionProfileRef: { id: 'semantic-stability-experiment', version: '1' },
  startState: { url: publicRoot } };
let providerTransactions = 0;
const models = createOpenAISemanticIntentModelsV3({ apiKey: () => process.env.OPENAI_API_KEY },
  { apiKey: () => process.env.OPENAI_API_KEY });
const measuredModel = phase => ({ complete: async input => {
  providerTransactions++;
  try { return await models[phase].complete(input); }
  catch (error) { throw error instanceof ModelCompletionFailure ? error : new ModelCompletionFailure('PROVIDER_ERROR'); }
} });
const measuredModels = { primary: measuredModel('primary'), reviewer: measuredModel('reviewer') };

// This is the sole interpretation transaction. Any failed gate ends the experiment without a retry.
let prepared = await fixturePreparation.prepareSemanticGroundingFixtureInterpretationV1(source,
  measuredModels, artifactRoot, AbortSignal.timeout(180_000));
const preparation = { providerTransactions, primaryStructured: 'unknown', normalization: 'unknown',
  canonicalization: 'unknown', canonicalValidation: 'unknown', fidelity: 'unknown', admission: 'unknown',
  testSpecId: source.testSpecId, semanticDigest: null, stepCount: null, artifactPath: null,
  authenticatedReload: false, failure: null };
if (prepared.kind === 'rejected') {
  preparation.failure = prepared.code;
  if (prepared.normalizationDiagnostic) preparation.diagnostic = prepared.normalizationDiagnostic;
  if (prepared.primaryOutputDiagnostic) preparation.diagnostic = prepared.primaryOutputDiagnostic;
  preparation.primaryStructured = prepared.code === 'PROVIDER_OUTPUT_INVALID' ? 'failed' : 'unknown';
  preparation.normalization = prepared.code === 'INVALID_SOURCE_REPRESENTATION' ? 'failed' : 'unknown';
  preparation.fidelity = prepared.code === 'SEMANTIC_FIDELITY_MISMATCH' ? 'rejected' : 'unknown';
  preparation.admission = 'rejected';
  await recordSafe('fixture-preparation.json', preparation);
  process.stdout.write(`${JSON.stringify({ preparation, attempts: [] })}\n`);
  process.exit(0);
}
let admission = prepared.admission;
let spec = admission.spec;
const semanticDigest = relations.semanticIntentCanonicalDigestV3(spec);
preparation.primaryStructured = 'passed'; preparation.normalization = 'passed';
preparation.canonicalization = 'passed'; preparation.canonicalValidation = 'passed';
preparation.fidelity = 'passed'; preparation.admission = 'passed';
preparation.semanticDigest = semanticDigest; preparation.stepCount = spec.steps.length;
const gatesPass = providerTransactions > 0 && spec.steps.length === 8 && semanticDigest === expectedDigest &&
  spec.steps.some(step => step.type === 'navigate' && step.url === publicRoot) &&
  spec.steps.some(step => step.type === 'verification_intent' && step.observable === 'url' &&
    step.comparator === 'equals' && step.expected === destination);
if (!gatesPass) {
  preparation.failure = 'FIXTURE_PREPARATION_GATE_MISMATCH';
  await recordSafe('fixture-preparation.json', preparation);
  process.stdout.write(`${JSON.stringify({ preparation, attempts: [] })}\n`);
  process.exit(0);
}

const store = new AdmittedSemanticTestSpecV7Store(artifactRoot);
let ref;
try {
  ref = await store.writeAdmittedV7(admission);
  preparation.artifactPath = ref.path;
} catch (error) {
  preparation.failure = error instanceof Error ? error.message : 'ARTIFACT_WRITE_FAILED';
  await recordSafe('fixture-preparation.json', preparation);
  process.stdout.write(`${JSON.stringify({ preparation, attempts: [] })}\n`);
  process.exit(0);
}
// Drop the only original capability and reload through the authenticated trusted reader.
let frozen = undefined;
prepared = undefined;
admission = undefined;
spec = undefined;
frozen = undefined;
try {
  const rereadStore = new AdmittedSemanticTestSpecV7Store(artifactRoot);
  frozen = await rereadStore.readAdmittedV7(source.testSpecId);
  preparation.authenticatedReload = true;
  if (relations.semanticIntentCanonicalDigestV3(frozen.spec) !== expectedDigest ||
      !Object.isFrozen(frozen.spec)) throw new Error('FIXTURE_RELOAD_SEMANTIC_MISMATCH');
} catch (error) {
  preparation.failure = error instanceof Error ? error.message : 'FIXTURE_AUTHENTICATION_FAILED';
  await recordSafe('fixture-preparation.json', preparation);
  process.stdout.write(`${JSON.stringify({ preparation, attempts: [] })}\n`);
  process.exit(0);
}
const profileRef = frozen.spec.executionProfileRef;
const profileId = profileRef.id, profileVersion = profileRef.version;
const browserProfile = {
  id: profileId, version: profileVersion, profileSchemaVersion: '5', presentationMode: 'headless',
  browserIsolation: 'local-windows', browserRuntime: 'playwright-chromium-windows', browser: 'chromium',
  viewport: { width: 900, height: 600 }, locale: 'en-US',
  timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 2000 } },
};
const catalog = new profiles.NativeProfileCatalog([browserProfile]);
const factory = new profiles.ProtectedContextFactory(catalog);
const digestAtFreeze = relations.semanticIntentCanonicalDigestV3(frozen.spec);
const fixedTestSpecId = frozen.spec.testSpecId;
const localRootHtml = '<!doctype html><html><body><a href="https://the-internet.herokuapp.com/add_remove_elements/">Add/Remove Elements</a></body></html>';
const localDestinationHtml = `<!doctype html><html><body><button id="add">Add Element</button><script>
document.querySelector('#add').addEventListener('click',()=>{const b=document.createElement('button');b.textContent='Delete';
b.addEventListener('click',()=>b.remove());document.body.appendChild(b);});</script></body></html>`;
const attempts = [];
const diagnosticStore = new diagnostics.SemanticExplorationDiagnosticsV1Store(artifactRoot);
const diagnosticRoot = artifactRoot;
let providerCountBeforeGrounding = providerTransactions;

for (let attemptNo = 1; attemptNo <= 10; attemptNo++) {
  const attemptId = `semantic-grounding-attempt-${String(attemptNo).padStart(2, '0')}-${randomUUID().replaceAll('-', '')}`;
  const outcome = { attempt: attemptNo, testSpecId: fixedTestSpecId, artifactAuthentication: 'not_attempted',
    admissionRecreated: 'not_attempted', browserContext: 'not_started', explorationAttemptId: attemptId,
    traceId: null, grounding: 'not_started', failureCategory: null, failureStepId: null,
    firstFailureBoundary: null, cleanup: 'not_started', canonicalGroundingDigest: null,
    steps: [], fixtureRequestCount: 0, unexpectedRequestCount: 0 };
  const collector = new diagnostics.SemanticExplorationDiagnosticCollectorV1(fixedTestSpecId, attemptId);
  const state = { browserLaunchAttempted: false, documentGenerationId: null, domContentLoadedObserved: null,
    mainResponseStatusClass: null, navigation: 'not_started', viewer: 'not_requested' };
  let currentSession, currentStepInfo = null, finalTrace;
  try {
    // New store reader creates a new in-memory admission capability for this sample.
    const reloaded = await new AdmittedSemanticTestSpecV7Store(artifactRoot).readAdmittedV7(fixedTestSpecId);
    outcome.artifactAuthentication = 'passed'; outcome.admissionRecreated = 'passed';
    if (relations.semanticIntentCanonicalDigestV3(reloaded.spec) !== digestAtFreeze ||
        reloaded.spec.testSpecId !== fixedTestSpecId) throw new Error('FIXED_ARTIFACT_IDENTITY_CHANGED');
    collector.record('mcp_session_started'); state.browserLaunchAttempted = true;
    currentSession = await explorationSession.McpExplorationSession.open(factory, profileRef,
      catalog.resolve(profileRef), attemptId);
    outcome.browserContext = 'initialized'; collector.record('mcp_session_completed');
    const context = currentSession.browserSession.context;
    const pages = context.pages();
    if (pages.length !== 0) throw new Error('UNEXPECTED_PREEXISTING_PAGE');
    await context.route('**/*', async route => {
      let url; try { url = new URL(route.request().url()); } catch { outcome.unexpectedRequestCount++; await route.abort(); return; }
      if (url.origin === canonicalOrigin && url.pathname === '/') {
        outcome.fixtureRequestCount++; await route.fulfill({ status: 200,
          contentType: 'text/html; charset=utf-8', body: localRootHtml }); return;
      }
      if (url.origin === canonicalOrigin && url.pathname === '/add_remove_elements/') {
        outcome.fixtureRequestCount++; await route.fulfill({ status: 200,
          contentType: 'text/html; charset=utf-8', body: localDestinationHtml }); return;
      }
      outcome.unexpectedRequestCount++; await route.abort('blockedbyclient');
    });
    context.on('response', response => {
      try {
        if (response.request().isNavigationRequest() && response.request().frame() === response.request().frame().page().mainFrame()) {
          const status = response.status(); state.mainResponseStatusClass = status >= 200 && status < 300 ? '2xx' :
            status >= 300 && status < 400 ? '3xx' : status >= 400 && status < 500 ? '4xx' : status >= 500 ? '5xx' : 'other';
        }
      } catch { /* bounded diagnostics only */ }
    });
    const groundingSession = new grounding.SemanticGroundingSessionV1(currentSession, reloaded, attemptId, event => {
      collector.record(event.boundary, currentStepInfo);
      if (event.documentGenerationId) state.documentGenerationId = event.documentGenerationId;
      if (event.domContentLoadedObserved !== undefined) state.domContentLoadedObserved = event.domContentLoadedObserved;
    });
    collector.record('grounding_session_initialized');
    const traceRecords = [];
    const canonicalSteps = [];
    for (const [stepIndex, step] of reloaded.spec.steps.entries()) {
      currentStepInfo = { stepId: step.id, kind: step.type === 'navigate' ? 'navigation' :
        step.type === 'action_intent' ? 'action' : 'verification',
        family: step.type === 'navigate' ? 'navigate' : step.type === 'action_intent' ? step.desiredEffect : step.observable,
        ordinalPresent: step.type === 'navigate' ? false : (step.type === 'action_intent' ? step.target : step.subject)?.ordinal != null,
        relationshipPresent: step.type !== 'navigate' && ['same_as_step', 'created_by_step'].includes(
          (step.type === 'action_intent' ? step.target : step.subject)?.relation ?? 'unspecified'),
        mechanic: null, observation: null };
      collector.record('step_started', currentStepInfo);
      if (step.type === 'navigate') {
        state.navigation = 'started'; collector.record('root_navigation_started', currentStepInfo);
        await currentSession.navigate(step.url);
        const page = context.pages()[0];
        if (!page || page.url() !== step.url) throw new Error('NAVIGATION_URL_MISMATCH');
        state.navigation = 'returned'; collector.record('root_navigation_returned', currentStepInfo);
        traceRecords.push({ type: 'navigate', step, observedUrl: page.url() });
        canonicalSteps.push({ order: stepIndex + 1, stepId: step.id, operationFamily: 'navigate',
          url: step.url, candidateDomainCardinality: null, selectedCandidateIndex: null, mechanic: null,
          authoredOrdinal: null, relationship: 'none', verificationStrategy: null, observation: 'url',
          resultingValue: page.url() });
        continue;
      }
      collector.record(step.type === 'action_intent' ? 'candidate_read_started' : 'verification_observation_started', currentStepInfo);
      if (step.type === 'action_intent') {
        const witness = await groundingSession.groundAction(step.id);
        if (witness.mechanic !== 'click') throw new Error('UNEXPECTED_ACTION_MECHANIC');
        currentStepInfo.mechanic = witness.mechanic; collector.record('step_grounded', currentStepInfo);
        const receipt = await groundingSession.executeGroundedAction(witness);
        traceRecords.push({ type: 'action', witness, receipt });
        const evidence = witness.evidence;
        canonicalSteps.push({ order: stepIndex + 1, stepId: step.id, operationFamily: step.desiredEffect,
          targetNameDigest: targetNameDigest(evidence.target), candidateDomainCardinality: evidence.candidates.length,
          selectedCandidateIndex: evidence.selectedDomainIndex, mechanic: witness.mechanic,
          authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? evidence.target?.ordinal ?? null,
          ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
            selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
          relationship: evidence.relationProof?.kind ?? 'none', receiptClass: receipt.commandReturned ?
            receipt.effectStatus : 'invalid', verificationStrategy: null, observation: null, resultingValue: null });
      } else {
        const witness = await groundingSession.groundVerification(step.id);
        if (!witness.expectedSatisfied) throw new Error('VERIFICATION_UNSATISFIED');
        currentStepInfo.observation = witness.observation; collector.record('step_grounded', currentStepInfo);
        traceRecords.push({ type: 'verification', witness });
        const evidence = witness.evidence;
        canonicalSteps.push({ order: stepIndex + 1, stepId: step.id,
          operationFamily: step.observable === 'url' ? 'url' : 'cardinality',
          targetNameDigest: targetNameDigest(evidence.target), candidateDomainCardinality: evidence.candidates.length,
          selectedCandidateIndex: evidence.selectedDomainIndex,
          mechanic: null, authoredOrdinal: evidence.ordinalProof?.authoredOrdinal ?? null,
          ordinalProof: evidence.ordinalProof ? { completeDomainCardinality: evidence.ordinalProof.completeDomainCount,
            selectedCandidateIndex: evidence.ordinalProof.selectedDomainIndex } : null,
          relationship: evidence.relationProof?.kind ?? 'none', receiptClass: null,
          verificationStrategy: witness.observation, observation: witness.property, resultingValue: witness.observed });
        if (step.observable === 'url' && witness.observed !== destination ||
            step.observable === 'cardinality' && witness.observed !== step.expected)
          throw new Error('GROUNDING_ASSERTION_MISMATCH');
      }
    }
    const result = { attemptId, sessionId: traceRecords.find(record => record.type !== 'navigate')?.witness.evidence.sessionId,
      profileFingerprint: currentSession.browserSession.effectiveProfile.fingerprint, records: traceRecords };
    finalTrace = traceDomain.issueSemanticGroundedTraceV1(reloaded, result);
    const groundingProjection = { version: 'semantic-grounding-v1-canonical-projection-1', steps: canonicalSteps };
    const canonicalDigest = sha256(groundingProjection);
    outcome.grounding = 'succeeded'; outcome.traceId = `semantic-trace-${finalTrace.traceDigest.slice(0, 32)}`;
    outcome.canonicalGroundingDigest = canonicalDigest; outcome.steps = canonicalSteps;
    collector.issuedTrace(outcome.traceId); collector.record('cleanup_started');
  } catch (error) {
    outcome.grounding = 'failed';
    const reason = error instanceof grounding.SemanticGroundingStopV1 ? error.reason :
      error instanceof Error ? error.message : 'UNKNOWN_CLOSED_FAILURE';
    outcome.failureCategory = reason;
    outcome.failureStepId = currentStepInfo?.stepId ?? null;
    const category = reason === 'ORDINAL_OUT_OF_BOUNDS' || reason === 'AMBIGUOUS_TARGET' ||
      reason === 'UNRESOLVED_TARGET' || reason === 'UNSUPPORTED_CAPABILITY' ? 'GROUNDING_CANDIDATE_FAILED' :
      reason === 'EFFECT_UNPROVEN' ? 'ACTION_EFFECT_FAILED' :
      reason === 'ENVIRONMENT_UNAVAILABLE' || reason === 'BROWSER_FAILURE' ? 'BROWSER_DISCONNECTED' :
      state.navigation === 'started' ? 'ROOT_NAVIGATION_FAILED' : 'UNKNOWN_EXPLORATION_FAILURE';
    const snapshot = await diagnostics.semanticExplorationBrowserSnapshotV1(currentSession?.browserSession, state);
    await collector.fail(category, Promise.resolve(snapshot), outcome.failureStepId);
    collector.record('cleanup_started');
  } finally {
    if (currentSession) {
      try { await currentSession.close(); outcome.cleanup = 'succeeded'; }
      catch { outcome.cleanup = 'failed'; }
    } else outcome.cleanup = 'not_started';
    if (outcome.cleanup === 'succeeded') collector.record('cleanup_completed');
    try { await diagnosticStore.write(collector.snapshot()); } catch { /* private diagnostics best effort */ }
  }
  outcome.fixtureRequestCount = outcome.fixtureRequestCount;
  outcome.providerCallsDuringGrounding = providerTransactions - providerCountBeforeGrounding;
  outcome.artifactPath = ref.path;
  if (outcome.grounding === 'succeeded') {
    const steps = outcome.steps;
    const adds = steps.filter(step => step.operationFamily === 'activate' && step.targetNameDigest === sha256('Add Element'));
    const deleteCounts = steps.filter(step => step.operationFamily === 'cardinality' &&
      step.targetNameDigest === sha256('Delete'));
    const firstDelete = steps.find(step => step.authoredOrdinal === 1 && step.targetNameDigest === sha256('Delete'));
    outcome.invariants = {
      add1UniqueClickReceipt: adds.length === 2 && adds[0]?.candidateDomainCardinality === 1 &&
        adds[0]?.mechanic === 'click' && adds[0]?.receiptClass === 'delivery_only',
      add2UniqueNoIdentityClickReceipt: adds.length === 2 && adds[1]?.candidateDomainCardinality === 1 &&
        adds[1]?.relationship === 'none' && adds[1]?.mechanic === 'click' && adds[1]?.receiptClass === 'delivery_only',
      deleteCount2CompleteSet: deleteCounts.some(step => step.resultingValue === 2 &&
        step.candidateDomainCardinality === 2 && step.verificationStrategy === 'complete_count'),
      firstDeleteOrdinalZero: firstDelete?.candidateDomainCardinality === 2 && firstDelete?.selectedCandidateIndex === 0 &&
        firstDelete.ordinalProof?.completeDomainCardinality === 2 && firstDelete.ordinalProof.selectedCandidateIndex === 0 &&
        firstDelete.mechanic === 'click' && firstDelete.receiptClass === 'delivery_only',
      deleteCount1FreshCompleteSet: deleteCounts.some(step => step.resultingValue === 1 &&
        step.candidateDomainCardinality === 1 && step.verificationStrategy === 'complete_count'),
      noPersistentIdentityRequirement: steps.every(step => step.relationship === 'none'),
      exactLocalFixtureOnly: outcome.fixtureRequestCount === 2 && outcome.unexpectedRequestCount === 0,
    };
  }
  await recordSafe(`attempt-${String(attemptNo).padStart(2, '0')}.json`, outcome);
  attempts.push(outcome);
  await recordSafe('progress.json', { testSpecId: fixedTestSpecId, semanticDigest: digestAtFreeze,
    providerTransactions: providerTransactions, attempts: attempts.map(item => ({ attempt: item.attempt,
      grounding: item.grounding, failureCategory: item.failureCategory,
      canonicalGroundingDigest: item.canonicalGroundingDigest, cleanup: item.cleanup })) });
}
preparation.authenticatedReload = true;
preparation.canonicalizationVersion = 'semantic_relation_canonicalization_v1';
preparation.validationVersion = 'semantic_intent_canonical_validation_v3';
preparation.fidelityVersion = frozen.record.versions.independentExtractionVersion;
preparation.admissionVersion = frozen.record.admissionVersion;
preparation.sourceBindingDigest = frozen.record.sourceDigest;
preparation.artifactContractVersion = '1';
await recordSafe('fixture-preparation.json', preparation);
const summary = { experimentId, artifactRoot, preparation, groundingProviderCalls: providerTransactions - providerCountBeforeGrounding,
  attempts: attempts.map(({ steps, ...attempt }) => attempt), uniqueCanonicalGroundingDigests:
    [...new Set(attempts.map(attempt => attempt.canonicalGroundingDigest).filter(Boolean))],
  cleanupSuccesses: attempts.filter(attempt => attempt.cleanup === 'succeeded').length };
await recordSafe('summary.json', summary);
process.stdout.write(`${JSON.stringify(summary)}\n`);
