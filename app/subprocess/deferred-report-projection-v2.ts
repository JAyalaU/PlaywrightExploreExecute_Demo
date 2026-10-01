import { z } from 'zod';
import { ResultRecordV2Schema } from '../domain/agentic-result-v2.js';
import { requireTrustedDeferredReplayReadbackV1, type TrustedDeferredReplayReadbackV1 } from '../evidence/deferred-replay-store-v9.js';
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
export const DeferredReportProjectionV2Schema = z.strictObject({ reportProjectionVersion: z.literal('2'),
  workflowVersion: z.literal('deferred-action-v1'), kind: z.literal('available'), result: ResultRecordV2Schema,
  replays: z.array(z.strictObject({ executionRunId: id, state: z.enum(['completed_true', 'completed_false', 'completed_execution', 'non_qa_stop']),
    assertionCount: z.number().int().min(0).max(100), cleanup: z.enum(['verified', 'unverified']) })).max(2),
  reproducibility: z.enum(['agreed', 'disagreed', 'not_established']),
  authoritativeQa: z.enum(['QA_ASSERTION_PASSED', 'QA_ASSERTION_FAILED']).optional(),
}).superRefine((value, ctx) => {
  if ((value.reproducibility === 'disagreed') !== (value.result.terminal.stage === 'reproducibility') ||
    value.result.terminal.stage === 'execution' && (value.reproducibility !== 'agreed' || value.replays.length !== 2 ||
      value.replays.some(r => r.state !== 'completed_execution' || r.assertionCount !== 0 || r.cleanup !== 'verified')) ||
    value.reproducibility === 'agreed' && !['qa', 'execution'].includes(value.result.terminal.stage))
    ctx.addIssue({ code: 'custom', message: 'Deferred reproducibility/execution contradiction' });
  if (value.result.workflowVersion !== 'deferred-action-v1' || value.result.executionRunIds.length !== value.replays.length ||
    value.replays.some((run, index) => run.executionRunId !== value.result.executionRunIds[index]) ||
    (value.result.terminal.stage === 'qa') !== !!value.authoritativeQa || value.authoritativeQa &&
    (value.authoritativeQa !== value.result.terminal.status || value.reproducibility !== 'agreed' ||
      value.replays.length !== 2 || value.replays.some(r => r.cleanup !== 'verified' || !r.assertionCount || r.state !==
        (value.authoritativeQa === 'QA_ASSERTION_PASSED' ? 'completed_true' : 'completed_false'))))
    ctx.addIssue({ code: 'custom', message: 'Deferred projection/terminal disagreement' });
});
export type DeferredReportProjectionV2 = z.infer<typeof DeferredReportProjectionV2Schema>;
/** Only authenticated pair readback grants projection. All assertion values, source and browser facts are withheld. */
export function projectDeferredReportV2(input: TrustedDeferredReplayReadbackV1): DeferredReportProjectionV2 {
  const { record, result } = requireTrustedDeferredReplayReadbackV1(input);
  const display = DeferredReportProjectionV2Schema.parse({ reportProjectionVersion: '2', workflowVersion: 'deferred-action-v1', kind: 'available', result,
    replays: record.runs.map(run => ({ executionRunId: run.executionRunId, state: run.result.kind !== 'completed' ? 'non_qa_stop' :
      !run.result.assertions ? 'completed_execution' : run.result.passed ? 'completed_true' : 'completed_false',
      assertionCount: run.result.kind === 'completed' ? run.result.assertions : run.steps.filter(s => s.verification).length, cleanup: run.cleanup })),
    reproducibility: record.agreement, ...(result.terminal.stage === 'qa' ? { authoritativeQa: result.terminal.status } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(display), 'utf8') > 8192) throw new Error('Deferred projection too large');
  return display;
}
