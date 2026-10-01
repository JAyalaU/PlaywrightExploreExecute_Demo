/** Public acceptance release reader. Emits only contract-level proof fields. */
import { LocalArtifactStore, readStoredJobReport } from '../evidence/index.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function hasAcceptedSemanticRowLocator(value: unknown): boolean {
  const locator = record(value);
  const quality = record(locator?.quality);
  const form = record(locator?.validatedForm);
  const scope = record(form?.scope);
  const target = record(form?.target);
  return locator?.origin === 'semanticRowScope' &&
    typeof locator.mcpGeneratedExpression === 'string' && locator.mcpGeneratedExpression.length > 0 &&
    quality?.status === 'accepted' && quality.identityBasis === 'scoped-role-and-accessible-name' &&
    form?.type === 'within' && scope?.type === 'rowWithCell' && scope.cellName === 'Iuvaret1' &&
    target?.type === 'role' && target.role === 'link' && target.name === 'edit' && target.exact === true;
}

const artifactRoot = argument('--artifact-root');
const testSpecId = argument('--test-spec-id');
const expectedProfileFingerprint = argument('--profile-fingerprint');
const expectedTarget = 'https://the-internet.herokuapp.com/challenging_dom';
const expectedTask = `Go to ${expectedTarget}. In the table row containing Iuvaret1, select the edit link. Confirm that the URL is exactly ${expectedTarget}#edit.`;
const expectedUrl = `${expectedTarget}#edit`;

if (!artifactRoot || !testSpecId || !expectedProfileFingerprint) {
  process.exitCode = 64;
} else {
  try {
    const report = await readStoredJobReport(new LocalArtifactStore(artifactRoot), testSpecId);
    const source = report.testSpec;
    const authoredClick = source.steps.find((step) => step.type === 'click');
    const authoredAssertion = source.steps.find((step) => step.type === 'assert_url');
    const resolvedClick = report.resolvedSpecs.flatMap((spec) => spec.executionSteps)
      .find((step) => step.originStepId === authoredClick?.id && step.type === 'click');
    const resolvedAssertion = report.resolvedSpecs.flatMap((spec) => spec.executionSteps)
      .find((step) => step.originStepId === authoredAssertion?.id && step.type === 'assert_url');
    const locator = resolvedClick && 'locator' in resolvedClick ? resolvedClick.locator : undefined;
    const semanticRowLocatorAccepted = hasAcceptedSemanticRowLocator(locator);
    const runResults = report.runs.map((run) => ({
      executionRunId: run.executionRunId,
      profileFingerprint: run.profileFingerprint,
      clickSucceeded: !!resolvedClick && run.outcomes.some((outcome) =>
        outcome.executionStepId === resolvedClick.id && outcome.status === 'OPERATION_SUCCEEDED'),
      urlAssertionPassed: !!resolvedAssertion && run.outcomes.some((outcome) =>
        outcome.executionStepId === resolvedAssertion.id && outcome.status === 'QA_ASSERTION_PASSED'),
    }));
    const summary = {
      testSpecId: source.testSpecId,
      taskMatches: report.interpretation?.outcome === 'accepted' &&
        report.interpretation.sourceInstruction === expectedTask && source.sourceInstruction === expectedTask,
      targetMatches: source.startState.url === expectedTarget,
      profileFingerprint: report.effectiveProfile.fingerprint,
      profileMatches: report.effectiveProfile.fingerprint === expectedProfileFingerprint,
      explorationAttemptIds: report.attempts.map((attempt) => attempt.explorationAttemptId),
      resolvedSpecIds: report.resolvedSpecs.map((spec) => spec.resolvedSpecId),
      semanticRowLocatorAccepted,
      expectedUrl: authoredAssertion?.type === 'assert_url' ? authoredAssertion.expectedUrl : null,
      expectedUrlMatches: authoredAssertion?.type === 'assert_url' &&
        authoredAssertion.expectedUrl === expectedUrl && resolvedAssertion?.type === 'assert_url' &&
        resolvedAssertion.expectedUrl === expectedUrl,
      runResults,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch {
    process.exitCode = 64;
  }
}
