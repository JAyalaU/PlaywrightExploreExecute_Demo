#!/usr/bin/env node
/** Emits a safe WP1-WP3 summary from Node-owned artifacts for the live gate. */
import { LocalArtifactStore, readStoredJobReport } from '../dist/evidence/index.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artifactRoot = arg('--artifact-root');
const testSpecId = arg('--test-spec-id');
const attemptId = arg('--attempt-id');
const resolvedSpecId = arg('--resolved-spec-id');
if (![artifactRoot, testSpecId, attemptId, resolvedSpecId].every(Boolean)) process.exit(64);

const diagnosticFields = [
  'schemaVersion', 'explorationAttemptId', 'originStepId', 'executionStepId', 'callOrdinal',
  'snapshotDigest', 'retryMode', 'retryCodes', 'rejectionCodes', 'decisionKind',
  'selectedReferenceRelation', 'validationCode', 'resultCode', 'resolverOutcome',
].sort();
const targetUrl = 'https://the-internet.herokuapp.com/';
const expectedTask =
  'Go to https://the-internet.herokuapp.com/. Locate the link that says Status Codes and click it. ' +
  'Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes. ' +
  'Locate the link with text 200 and click it. ' +
  'Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes/200. ' +
  'Locate the here link in the sentence ending with go here and click it. ' +
  'Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes.';
const expectedUrls = [
  'https://the-internet.herokuapp.com/status_codes',
  'https://the-internet.herokuapp.com/status_codes/200',
  'https://the-internet.herokuapp.com/status_codes',
];
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

try {
  const store = new LocalArtifactStore(artifactRoot);
  const report = await readStoredJobReport(store, testSpecId);
  const resolved = report.resolvedSpecs.find((item) => item.resolvedSpecId === resolvedSpecId &&
    item.explorationAttemptId === attemptId);
  if (!resolved || report.testSpec.startState.url !== targetUrl) throw new Error('correlation');
  const click200 = report.testSpec.steps.find((step) => step.type === 'click' &&
    /\b200\b/.test(step.target.description));
  const clickHere = report.testSpec.steps.find((step) => step.type === 'click' &&
    /\bhere\b/i.test(step.target.description));
  const urls = report.testSpec.steps.filter((step) => step.type === 'assert_url')
    .map((step) => step.expectedUrl);
  const resolvedUrls = resolved.executionSteps.filter((step) => step.type === 'assert_url')
    .map((step) => step.expectedUrl);
  const resolvedFor = (step) => step && resolved.executionSteps.find((item) =>
    item.originStepId === step.id && item.type === 'click');
  const selected200 = resolvedFor(click200);
  const selectedHere = resolvedFor(clickHere);
  const locator200 = record(selected200?.locator);
  const form200 = record(locator200?.validatedForm);
  const observed200 = record(locator200?.observed);
  const rejection200 = record(locator200?.rawRejection);
  const locatorHere = record(selectedHere?.locator);
  const diagnostics = await store.readM7DecisionDiagnostics(testSpecId, attemptId);
  const diagnosticProjection = diagnostics.some((item) =>
    item.executionStepId === selected200?.id && item.resolverOutcome === 'role_name_projected' &&
    item.rejectionCodes.includes('WEAK_IDENTITY') && item.resultCode === 'OPERATION_SUCCEEDED');
  const fieldsClosed = diagnostics.length > 0 && diagnostics.every((item) =>
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify(diagnosticFields) &&
    /^[a-f0-9]{64}$/.test(item.snapshotDigest));
  const reportJson = JSON.stringify(report);
  const diagnosticsPrivate = !reportJson.includes('developer-diagnostics') &&
    !reportJson.includes('snapshotDigest') &&
    diagnostics.every((item) => !reportJson.includes(JSON.stringify(item))) &&
    report.evidence.every((item) => !item.ref?.includes('developer-diagnostics'));
  const roleNameProjectionVerified = locator200?.origin === 'verifiedRoleNameProjection' &&
    form200?.type === 'role' && form200.role === 'link' && form200.name === '200' && form200.exact === true &&
    locator200.mcpGeneratedExpression && rejection200?.reasons?.length === 1 &&
    rejection200.reasons[0] === 'WEAK_IDENTITY' && rejection200.matchCount === 1 &&
    rejection200.observedTargetMatches === true && observed200?.role === 'link' &&
    observed200.accessibleName === '200' && observed200.matchCount === 1 &&
    observed200.observedTargetMatches === true &&
    locator200.quality?.status === 'accepted' &&
    locator200.quality?.identityBasis === 'role-and-accessible-name';
  const hereAccepted = !!locatorHere?.mcpGeneratedExpression &&
    locatorHere.quality?.status === 'accepted' && !!record(locatorHere.validatedForm);
  const runIds = report.runs.filter((run) => run.resolvedSpecId === resolvedSpecId)
    .map((run) => run.executionRunId);
  const bothRunsPassed = runIds.length === 2 && new Set(runIds).size === 2 &&
    report.runs.filter((run) => run.resolvedSpecId === resolvedSpecId).every((run) =>
      run.outcomes.every((item) => item.status === 'OPERATION_SUCCEEDED' || item.status === 'QA_ASSERTION_PASSED'));
  const summary = {
    testSpecId,
    sourceTaskMatches: report.testSpec.sourceInstruction === expectedTask &&
      report.interpretation?.sourceInstruction === expectedTask,
    completeResolvedSpec: resolved.executionSteps.length === report.testSpec.steps.length,
    expectedUrlSequenceMatches: JSON.stringify(urls) === JSON.stringify(expectedUrls) &&
      JSON.stringify(resolvedUrls) === JSON.stringify(expectedUrls),
    bothFreshRunsPassed: bothRunsPassed,
    step4SameNodeProjectionPreservesProvenance: !!roleNameProjectionVerified,
    step6HereClickHasAcceptedDeclarativeLocator: hereAccepted,
    m7DiagnosticCount: diagnostics.length,
    m7ProjectionDiagnosticPresent: diagnosticProjection,
    m7DiagnosticFieldsClosed: fieldsClosed,
    diagnosticsPrivateFromStakeholderReport: diagnosticsPrivate,
  };
  if (!summary.sourceTaskMatches || !summary.completeResolvedSpec || !summary.expectedUrlSequenceMatches ||
      !summary.bothFreshRunsPassed ||
      !summary.step4SameNodeProjectionPreservesProvenance || !summary.step6HereClickHasAcceptedDeclarativeLocator ||
      !summary.m7ProjectionDiagnosticPresent || !summary.m7DiagnosticFieldsClosed ||
      !summary.diagnosticsPrivateFromStakeholderReport) throw new Error('proof');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch {
  process.stderr.write('STATUS_CODES_REPORT_PROOF_FAILED\n');
  process.exitCode = 1;
}
