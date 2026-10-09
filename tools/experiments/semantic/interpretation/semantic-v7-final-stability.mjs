import { repoRoot, importProduct } from '../../paths.mjs';
if (process.env.SEMANTIC_V7_INTERPRETATION_STABILITY !== '1') {
  throw new Error('Set SEMANTIC_V7_INTERPRETATION_STABILITY=1 for this opt-in provider experiment');
}
/** Fresh ten-sample semantic-v7 interpretation-only stability cohort. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const root = repoRoot;
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.OPENAI_API_KEY?.trim()) {
  process.stderr.write('INTERPRETATION_EXPERIMENT_BLOCKED: trusted provider credential unavailable\n');
  process.exit(2);
}

const [{ createOpenAISemanticIntentModelsV3 }, intent, relations, wire, { ModelCompletionFailure }] =
  await Promise.all([
    importProduct('interpretation/semantic-intent-v3-adapters.js'),
    importProduct('interpretation/semantic-intent-v3.js'),
    importProduct('interpretation/semantic-intent-v3-relations.js'),
    importProduct('interpretation/semantic-intent-v3-wire.js'),
    importProduct('interpretation/model-failure.js'),
  ]);

const instruction = `Go to https://the-internet.herokuapp.com/
Find and activate the link named "Add/Remove Elements".
Verify that the current URL is https://the-internet.herokuapp.com/add_remove_elements/
Activate the "Add Element" button twice.
Verify that exactly two "Delete" buttons exist.
Activate the first "Delete" button.
Verify that exactly one "Delete" button exists.`;
const cohortId = `semantic-v7-final-stability-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
const artifactDirectory = path.join(root, 'artifacts', cohortId);
await mkdir(artifactDirectory);
if (path.relative(artifactDirectory, await realpath(artifactDirectory)) !== '')
  throw new Error('INVALID_EXPERIMENT_ARTIFACT_DIRECTORY');

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
function safeProjection(spec) {
  const position = new Map(spec.steps.map((step, index) => [step.id, index + 1]));
  const target = value => value === null ? null : ({ category: value.category,
    exactNameDigest: value.exactName === null ? null : sha256(value.exactName),
    contextDigest: value.context === null ? null : sha256(value.context), ordinal: value.ordinal,
    relation: value.relation,
    relatedStep: value.relatedStepId === null ? null : position.get(value.relatedStepId) ?? null });
  const steps = spec.steps.map((step, index) => {
    const common = { order: index + 1, dependency: step.dependsOnStepId === null ? null :
      position.get(step.dependsOnStepId) ?? null };
    if (step.type === 'navigate') return { ...common, kind: 'navigation', url: step.url };
    if (step.type === 'action_intent') return { ...common, kind: 'action', target: target(step.target),
      desiredEffect: step.desiredEffect, valueDigest: step.value === null ? null : sha256(step.value),
      checkedState: step.checkedState, explicitMechanic: step.authoredMechanic };
    const expected = typeof step.expected === 'string' ?
      (step.observable === 'url' ? { kind: 'approved_url', value: step.expected } :
        { kind: 'literal_digest', sha256: sha256(step.expected) }) : step.expected;
    return { ...common, kind: 'verification', target: target(step.subject), property: step.observable,
      comparator: step.comparator, expected };
  });
  const actions = steps.filter(step => step.kind === 'action');
  const verifications = steps.filter(step => step.kind === 'verification');
  const addActions = actions.filter(step => step.target?.exactNameDigest === sha256('Add Element'));
  const deleteAssertions = verifications.filter(step => step.property === 'cardinality' &&
    step.target?.exactNameDigest === sha256('Delete'));
  const firstDelete = actions.find(step => step.target?.exactNameDigest === sha256('Delete'));
  const root = steps.find(step => step.kind === 'navigation' &&
    step.url === 'https://the-internet.herokuapp.com/');
  const linkAction = actions.find(step => step.target?.exactNameDigest === sha256('Add/Remove Elements'));
  const destination = verifications.find(step => step.property === 'url');
  const checks = {
    rootUrlPreserved: Boolean(root),
    addRemoveActivationPreserved: Boolean(linkAction?.desiredEffect === 'activate'),
    destinationUrlEqualityPreserved: Boolean(destination?.comparator === 'equals' &&
      destination.expected?.kind === 'approved_url' &&
      destination.expected.value === 'https://the-internet.herokuapp.com/add_remove_elements/'),
    exactlyTwoAddActivations: addActions.length === 2 && addActions.every(step =>
      step.desiredEffect === 'activate'),
    repeatedAddHasNoAuthoredRelation: addActions.length === 2 && addActions.every(step =>
      step.target.relation === 'unspecified' && step.target.relatedStep === null),
    deleteCompleteSetCardinalityTwo: deleteAssertions.some(step => step.comparator === 'equals' &&
      step.expected === 2 && step.target?.relation === 'unspecified' && step.target?.ordinal === null),
    firstDeleteOrdinalPreserved: firstDelete?.target?.ordinal === 1,
    firstDeleteSemanticActivate: firstDelete?.desiredEffect === 'activate',
    deleteCompleteSetCardinalityOne: deleteAssertions.some(step => step.comparator === 'equals' &&
      step.expected === 1 && step.target?.relation === 'unspecified' && step.target?.ordinal === null),
    noInventedBrowserMechanic: actions.every(step => step.explicitMechanic === null),
    noUnauthoredRelationCandidateSurvives: addActions.length === 2 && addActions.every(step =>
      step.target.relation === 'unspecified') && deleteAssertions.length === 2 && deleteAssertions.every(step =>
      step.target?.relation === 'unspecified') && firstDelete?.target?.relation === 'unspecified',
  };
  return { stepCount: steps.length, semanticDigest: relations.semanticIntentCanonicalDigestV3(spec), steps, checks };
}

function transportFailure(error) {
  return error instanceof ModelCompletionFailure ? error.code : 'PROVIDER_ERROR';
}
async function persist(record) {
  const finalPath = path.join(artifactDirectory, `attempt-${String(record.attempt).padStart(2, '0')}.json`);
  const tempPath = path.join(artifactDirectory, `.pending-${randomUUID()}`);
  const handle = await open(tempPath, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(tempPath, finalPath); } finally { await unlink(tempPath); }
}

const summary = [];
for (let attempt = 1; attempt <= 10; attempt += 1) {
  const source = { testSpecId: `semantic-final-${randomUUID()}`, sourceInstruction: instruction,
    executionProfileRef: { id: 'semantic-stability-experiment', version: '1' },
    startState: { url: 'https://the-internet.herokuapp.com/' } };
  const state = { primaryTransport: 'not_attempted', primaryStructured: 'not_reached',
    normalization: 'not_reached', canonicalization: 'not_reached', canonicalValidation: 'not_reached',
    reviewerTransport: 'not_attempted', fidelity: 'not_reached', admission: 'not_reached',
    normalizationDiagnostic: null, primaryFailureCode: null, reviewerFailureCode: null,
    providerDiagnostics: [] };
  const diagnostic = phase => event => state.providerDiagnostics.push({ phase, source: event.source,
    httpStatus: event.httpStatus ?? null, transportCode: event.transportCode ?? null, code: event.code });
  // A new pair of stateless adapters is constructed for every sample. The production
  // interpreter owns the exact prompts, schemas, normalization, canonicalization and admission.
  const models = createOpenAISemanticIntentModelsV3(
    { apiKey: () => process.env.OPENAI_API_KEY, diagnostic: diagnostic('primary') },
    { apiKey: () => process.env.OPENAI_API_KEY, diagnostic: diagnostic('fidelity') });
  const wrapped = {
    primary: { complete: async input => {
      try {
        const output = await models.primary.complete(input);
        state.primaryTransport = 'succeeded';
        try {
          const parsed = JSON.parse(output);
          wire.SemanticIntentPrimaryWireV3Schema.parse(parsed);
          state.primaryStructured = parsed.response.kind === 'extraction' ? 'succeeded' : 'unresolved';
        } catch { state.primaryStructured = 'failed'; }
        return output;
      } catch (error) {
        const completedMalformed = error instanceof ModelCompletionFailure &&
          (error.completedMalformedOutput || error.code === 'PROVIDER_OUTPUT_INVALID');
        state.primaryTransport = completedMalformed ? 'succeeded' : 'failed';
        state.primaryStructured = completedMalformed ? 'failed' : 'not_reached';
        state.primaryFailureCode = transportFailure(error);
        throw error;
      }
    } },
    reviewer: { complete: async input => {
      try {
        const output = await models.reviewer.complete(input);
        state.reviewerTransport = 'succeeded';
        try {
          const review = wire.SemanticIntentFidelityWireV3Schema.parse(JSON.parse(output)).response;
          state.fidelity = review.verdict === 'faithful' && review.issues.length === 0 ? 'passed' : 'rejected';
        } catch { state.fidelity = 'response_invalid'; }
        return output;
      } catch (error) {
        const completedMalformed = error instanceof ModelCompletionFailure &&
          (error.completedMalformedOutput || error.code === 'PROVIDER_OUTPUT_INVALID');
        state.reviewerTransport = completedMalformed ? 'succeeded' : 'failed';
        state.reviewerFailureCode = transportFailure(error);
        state.fidelity = completedMalformed ? 'response_invalid' : 'provider_failed';
        throw error;
      }
    } },
  };

  let outcome;
  try {
    outcome = await intent.interpretSemanticIntentV3(source, wrapped, AbortSignal.timeout(180_000));
  } catch {
    outcome = { kind: 'rejected', code: 'UNEXPECTED_CLOSED_FAILURE' };
  }
  const d = outcome.kind === 'rejected' ? outcome.normalizationDiagnostic ?? null : null;
  state.normalizationDiagnostic = d;
  const extractionReached = state.primaryStructured === 'succeeded' || state.primaryStructured === 'unresolved';
  // `spec_cross_step` is emitted both by the pre-canonical structural pass and
  // the final canonical pass. Only this known regression predicate is exclusive
  // to the latter; keep all other such stage attribution explicitly unresolved.
  const canonicalValidationFailure = d?.phase === 'spec_cross_step' &&
    d.predicate === 'CONFLICTING_TARGET_IDENTITY';
  const crossStepBoundaryUnresolved = d?.phase === 'spec_cross_step' && !canonicalValidationFailure;
  if (outcome.kind === 'accepted' || d?.phase === 'relation_canonicalization' || d?.phase === 'admission' ||
      canonicalValidationFailure || outcome.code === 'SEMANTIC_FIDELITY_MISMATCH') state.normalization = 'succeeded';
  else if (crossStepBoundaryUnresolved) state.normalization = 'boundary_unresolved';
  else if (d || outcome.code === 'INVALID_SOURCE_REPRESENTATION') state.normalization = 'failed';
  else if (extractionReached && outcome.code !== 'SEMANTIC_INTERPRETATION_UNRESOLVED') state.normalization = 'failed';
  if (state.normalization === 'succeeded') {
    state.canonicalization = d?.phase === 'relation_canonicalization' ? 'failed' : 'succeeded';
    state.canonicalValidation = canonicalValidationFailure ? 'failed' : 'succeeded';
  } else if (crossStepBoundaryUnresolved) {
    state.canonicalization = 'boundary_unresolved';
    state.canonicalValidation = 'boundary_unresolved';
  }
  if (outcome.kind === 'accepted') {
    state.admission = 'passed';
    if (state.fidelity === 'not_reached') state.fidelity = 'passed';
  } else if (d?.phase === 'admission') state.admission = 'rejected';

  const projection = outcome.kind === 'accepted' ? safeProjection(outcome.admission.spec) : null;
  const record = { cohortId, attempt, primaryTransport: state.primaryTransport,
    primaryResponse: state.primaryStructured, normalization: state.normalization,
    relationCanonicalization: state.canonicalization, canonicalSemanticValidation: state.canonicalValidation,
    fidelity: state.fidelity, reviewerTransport: state.reviewerTransport, admission: state.admission,
    status: outcome.kind === 'accepted' ? 'admitted' : 'rejected',
    rejectionCode: outcome.kind === 'accepted' ? null : outcome.code,
    closedDiagnostic: d === null ? null : { phase: d.phase, predicate: d.predicate,
      stepIndex: d.stepIndex, fieldFamily: d.fieldFamily },
    semanticDigest: projection?.semanticDigest ?? null, stepCount: projection?.stepCount ?? null,
    projection: projection?.steps ?? null, requiredMeaningChecks: projection?.checks ?? null,
    primaryFailureCode: state.primaryFailureCode, reviewerFailureCode: state.reviewerFailureCode,
    providerDiagnostics: state.providerDiagnostics };
  await persist(record);
  const row = { attempt, primaryTransport: record.primaryTransport, primaryResponse: record.primaryResponse,
    normalization: record.normalization, relationCanonicalization: record.relationCanonicalization,
    canonicalSemanticValidation: record.canonicalSemanticValidation, fidelity: record.fidelity,
    admission: record.admission, status: record.status, rejectionCode: record.rejectionCode,
    closedDiagnostic: record.closedDiagnostic, semanticDigest: record.semanticDigest, stepCount: record.stepCount,
    requiredMeaningChecks: record.requiredMeaningChecks };
  summary.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
process.stdout.write(`COHORT_ID=${cohortId}\nARTIFACT_DIRECTORY=${artifactDirectory}\n`);
