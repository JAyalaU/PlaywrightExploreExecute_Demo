/** Read-only, bounded agentic projection entry. */
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;
const { MAX_PROJECTION_V2_REQUEST_BYTES, MAX_PROJECTION_V2_RESPONSE_BYTES,
  AgenticReportProjectionResponseV2Schema, parseAgenticReportProjectionRequestV2,
  projectStoredAgenticReportV2 } = await import('./report-projection-v2.js');
const { readSubprocessTrustedConfiguration } = await import('./entry.js');
const unavailable = (reason: 'INVALID_REQUEST' | 'CONFIGURATION_UNAVAILABLE' | 'REPORT_TOO_LARGE') =>
  ({ reportProjectionVersion: '2' as const, kind: 'unavailable' as const, reason });
let response;
try {
  const args = process.argv.slice(2);
  const path = args.length === 2 && args[0] === '--config' && args[1] ? args[1] : undefined;
  if (!path) response = unavailable('CONFIGURATION_UNAVAILABLE');
  else {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += bytes.byteLength;
      if (length > MAX_PROJECTION_V2_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(bytes);
    }
    const request = parseAgenticReportProjectionRequestV2(Buffer.concat(chunks, length));
    const config = await readSubprocessTrustedConfiguration(path).catch(() => undefined);
    response = config ? await projectStoredAgenticReportV2(request, config) :
      unavailable('CONFIGURATION_UNAVAILABLE');
  }
} catch { response = unavailable('INVALID_REQUEST'); }
let body = `${JSON.stringify(AgenticReportProjectionResponseV2Schema.parse(response))}\n`;
if (Buffer.byteLength(body, 'utf8') > MAX_PROJECTION_V2_RESPONSE_BYTES)
  body = `${JSON.stringify(unavailable('REPORT_TOO_LARGE'))}\n`;
await new Promise<void>((resolve, reject) => write(body, (error) => error ? reject(error) : resolve()));
