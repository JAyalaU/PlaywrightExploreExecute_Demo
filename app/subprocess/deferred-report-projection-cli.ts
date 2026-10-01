/** Pure persisted-read entry. No exploration/compiler/MCP imports are needed for the deferred branch. */
import { readFile, lstat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { WorkflowReportProjectionRequestV2Schema, projectStoredWorkflowReportV2 } from './workflow-report-projection-v2.js';
import { DeferredReportProjectionV2Schema } from './deferred-report-projection-v2.js';
const unavailableSchema = z.strictObject({ reportProjectionVersion: z.literal('2'), kind: z.literal('unavailable'), reason: z.enum(['REPORT_UNAVAILABLE', 'INVALID_REQUEST', 'CONFIGURATION_UNAVAILABLE']) });
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)()); return true;
}
process.stdout.write = discard as typeof process.stdout.write; process.stderr.write = discard as typeof process.stderr.write;
const unavailable = (reason: 'REPORT_UNAVAILABLE' | 'INVALID_REQUEST' | 'CONFIGURATION_UNAVAILABLE') =>
  ({ reportProjectionVersion: '2' as const, kind: 'unavailable' as const, reason });
let response;
try {
  const args = process.argv.slice(2), file = args.length === 2 && args[0] === '--config' ? args[1] : undefined;
  if (!file) response = unavailable('CONFIGURATION_UNAVAILABLE');
  else {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += bytes.length;
      if (size > 8192) throw new Error('Request bound'); chunks.push(bytes);
    }
    const request = WorkflowReportProjectionRequestV2Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))));
    if (request.result.kind === 'bridge_error' || request.result.context.result.workflowVersion !== 'deferred-action-v1') response = unavailable('INVALID_REQUEST');
    else {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error('Config bound');
      const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)));
      response = await projectStoredWorkflowReportV2(request, config);
    }
  }
} catch { response = unavailable('INVALID_REQUEST'); }
let body = JSON.stringify(z.union([DeferredReportProjectionV2Schema, unavailableSchema]).parse(response)) + '\n';
if (Buffer.byteLength(body, 'utf8') > 8192) body = JSON.stringify(unavailable('REPORT_UNAVAILABLE')) + '\n';
await new Promise<void>((resolve, reject) => write(body, error => error ? reject(error) : resolve()));
