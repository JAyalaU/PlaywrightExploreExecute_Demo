import { z } from 'zod';
import { projectDeferredReportV2 } from './deferred-report-projection-v2.js';
import { SubprocessResponseV2Schema } from './protocol-v2.js';
import { parseTrustedLocalConfiguration } from '../local/contracts.js';
import { SuccessfulTraceV5Store } from '../evidence/trace-store-v5.js';
import { DeferredCompilerV4Store } from '../evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store, requireTrustedDeferredReplayReadbackV1 } from '../evidence/deferred-replay-store-v9.js';

export const WorkflowReportProjectionRequestV2Schema = z.strictObject({ reportProjectionVersion: z.literal('2'), result: SubprocessResponseV2Schema });
/** Version router; historical projection remains unchanged and never reads deferred artifacts. */
export async function projectStoredWorkflowReportV2(input: unknown, configInput: unknown) {
  const request = WorkflowReportProjectionRequestV2Schema.parse(input);
  if (request.result.kind === 'bridge_error' || request.result.context.result.workflowVersion !== 'deferred-action-v1') {
    const { projectStoredAgenticReportV2 } = await import('./report-projection-v2.js');
    return projectStoredAgenticReportV2(request, configInput);
  }
  const unavailable = () => ({ reportProjectionVersion: '2' as const, kind: 'unavailable' as const, reason: 'REPORT_UNAVAILABLE' as const });
  const r = request.result.context.result;
  if (request.result.context.report.kind !== 'available' || !r.deferredReplay || !r.explorationAttemptId || !r.compilerAttemptId) return unavailable();
  try {
    const { artifactRoot } = parseTrustedLocalConfiguration(configInput);
    const trace = await new SuccessfulTraceV5Store(artifactRoot).readSuccessfulExplorationV5(r.testSpecId, r.explorationAttemptId);
    const resolved = await new DeferredCompilerV4Store(artifactRoot).readResolvedV9(r.testSpecId, r.compilerAttemptId, trace);
    const replay = await new DeferredReplayV9Store(artifactRoot).readReplayV1(r.testSpecId, r.deferredReplay.orchestrationId, resolved);
    if (JSON.stringify(requireTrustedDeferredReplayReadbackV1(replay).result) !== JSON.stringify(r)) return unavailable();
    return projectDeferredReportV2(replay);
  } catch { return unavailable(); }
}
