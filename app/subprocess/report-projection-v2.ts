import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { SubprocessResponseV2Schema } from './protocol-v2.js';

export const REPORT_PROJECTION_V2 = '2' as const;
export const MAX_PROJECTION_V2_REQUEST_BYTES = 8_192;
export const MAX_PROJECTION_V2_RESPONSE_BYTES = 65_536;
const unavailableReason = z.enum(['REPORT_UNAVAILABLE', 'REPORT_NOT_FOUND', 'REPORT_EXPIRED',
  'CORRELATION_MISMATCH', 'REPORT_INVALID', 'REPORT_TOO_LARGE', 'INVALID_REQUEST',
  'CONFIGURATION_UNAVAILABLE']);

export const AgenticReportProjectionRequestV2Schema = z.strictObject({
  reportProjectionVersion: z.literal(REPORT_PROJECTION_V2), result: SubprocessResponseV2Schema,
});
export type AgenticReportProjectionRequestV2 = z.infer<typeof AgenticReportProjectionRequestV2Schema>;

/** Historical v2 artifacts are no longer readable; semantic results use safe terminal projection. */
export const AgenticReportProjectionResponseV2Schema = z.strictObject({
  reportProjectionVersion: z.literal(REPORT_PROJECTION_V2),
  kind: z.literal('unavailable'), reason: unavailableReason,
});
export type AgenticReportProjectionResponseV2 = z.infer<typeof AgenticReportProjectionResponseV2Schema>;
type Reason = z.infer<typeof unavailableReason>;
const unavailable = (reason: Reason): AgenticReportProjectionResponseV2 =>
  ({ reportProjectionVersion: REPORT_PROJECTION_V2, kind: 'unavailable', reason });

export async function projectStoredAgenticReportV2(input: unknown,
  _configInput: unknown): Promise<AgenticReportProjectionResponseV2> {
  const request = AgenticReportProjectionRequestV2Schema.safeParse(input);
  return unavailable(request.success ? 'REPORT_UNAVAILABLE' : 'INVALID_REQUEST');
}

export function parseAgenticReportProjectionRequestV2(bytes: Uint8Array): AgenticReportProjectionRequestV2 {
  if (bytes.byteLength > MAX_PROJECTION_V2_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error('INVALID_REQUEST'); }
  return AgenticReportProjectionRequestV2Schema.parse(value);
}
