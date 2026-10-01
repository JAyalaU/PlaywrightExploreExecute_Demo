/** Separate read-only projection entry; subprocess protocol v1 is unchanged. */
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;

const {
  MAX_PROJECTION_REQUEST_BYTES, REPORT_PROJECTION_VERSION,
  parseReportProjectionRequest, projectStoredReport, ReportProjectionResponseSchema,
} = await import('./report-projection.js');
const { readSubprocessTrustedConfiguration } = await import('./entry.js');
type Reason = 'INVALID_REQUEST' | 'CONFIGURATION_UNAVAILABLE';
const unavailable = (reason: Reason) => ({ reportProjectionVersion: REPORT_PROJECTION_VERSION,
  kind: 'unavailable' as const, reason });
let response;
try {
  const args = process.argv.slice(2);
  const configPath = args.length === 2 && args[0] === '--config' ? args[1] : undefined;
  if (!configPath) response = unavailable('CONFIGURATION_UNAVAILABLE');
  else {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += bytes.byteLength;
      if (length > MAX_PROJECTION_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(bytes);
    }
    const request = parseReportProjectionRequest(Buffer.concat(chunks, length));
    const config = await readSubprocessTrustedConfiguration(configPath).catch(() => undefined);
    response = config ? await projectStoredReport(request, config) : unavailable('CONFIGURATION_UNAVAILABLE');
  }
} catch { response = unavailable('INVALID_REQUEST'); }

const body = `${JSON.stringify(ReportProjectionResponseSchema.parse(response))}\n`;
await new Promise<void>((resolve, reject) => write(body, (error) => error ? reject(error) : resolve()));
