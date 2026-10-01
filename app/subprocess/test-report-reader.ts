/**
 * P2-3D test-only reader for a Node-owned report referenced by a successful
 * subprocess envelope. It emits a correlation-safe reconstruction summary,
 * never report evidence bytes, page data, or provider output.
 */
import { LocalArtifactStore, readStoredJobReport } from '../evidence/index.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artifactRoot = argument('--artifact-root');
const testSpecId = argument('--test-spec-id');
if (!artifactRoot || !testSpecId) {
  process.exitCode = 64;
} else {
  try {
    const store = new LocalArtifactStore(artifactRoot);
    const report = await readStoredJobReport(store, testSpecId);
    const summary = {
      testSpecId: report.testSpec.testSpecId,
      profileFingerprint: report.effectiveProfile.fingerprint,
      explorationAttemptIds: report.attempts.map((attempt) => attempt.explorationAttemptId),
      resolvedSpecIds: report.resolvedSpecs.map((resolved) => resolved.resolvedSpecId),
      executionRunIds: report.runs.map((run) => run.executionRunId),
      hasDiscoveredPrerequisite: report.resolvedSpecs.some((resolved) =>
        resolved.executionSteps.some((step) => step.source === 'discoveredPrerequisite')),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch {
    process.exitCode = 64;
  }
}
