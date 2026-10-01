/** Dedicated machine entry. stdout is reserved for one protocol document. */
const rawStdout = process.stdout.write.bind(process.stdout);
const rawStderr = process.stderr.write.bind(process.stderr);

function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}

// Third-party browser/provider diagnostics must not corrupt stdout or expose private page data.
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;

const controller = new AbortController();
const { installSubprocessCancellation } = await import('./cancellation.js');
const removeCancellationHandlers = installSubprocessCancellation(controller);
let closeEventChannel: (() => void) | undefined;
let closeImageChannel: (() => void) | undefined;
let closeViewerChannel: (() => void) | undefined;

try {
  const { loadProjectEnv } = await import('../local/project-env.js');
  loadProjectEnv();
  const { connectEventChannel } = await import('../observability/event-channel.js');
  let eventChannel;
  try { eventChannel = await connectEventChannel(); } catch {
    // A configured but unauthenticated observation channel fails before work.
    const { serializeSubprocessResponse } = await import('./entry.js');
    const { SUBPROCESS_PROTOCOL_VERSION } = await import('./protocol.js');
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    eventChannel = null;
  }
  closeEventChannel = eventChannel?.close;
  if (eventChannel !== null) {
  const { connectImageChannel } = await import('../observability/image-channel.js');
  let imageChannel;
  try { imageChannel = await connectImageChannel(eventChannel?.producer.streamId); } catch {
    const { serializeSubprocessResponse } = await import('./entry.js');
    const { SUBPROCESS_PROTOCOL_VERSION } = await import('./protocol.js');
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    imageChannel = null;
  }
  closeImageChannel = imageChannel?.close;
  if (imageChannel !== null) {
  const { ViewerLifecycle } = await import('../observability/viewer-channel.js');
  let viewerChannel;
  try { viewerChannel = await ViewerLifecycle.connect(eventChannel?.producer); } catch {
    const { serializeSubprocessResponse } = await import('./entry.js');
    const { SUBPROCESS_PROTOCOL_VERSION } = await import('./protocol.js');
    const wire = serializeSubprocessResponse({ protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'not_started' });
    await new Promise<void>((resolve) => rawStdout(wire.body, () => resolve()));
    process.exitCode = wire.exitCode;
    viewerChannel = null;
  }
  closeViewerChannel = viewerChannel?.close.bind(viewerChannel);
  if (viewerChannel !== null) {
  const { runSubprocessAdapter, readSubprocessTrustedConfiguration,
    serializeSubprocessResponse } = await import('./entry.js');
  const { SUBPROCESS_PROTOCOL_VERSION } = await import('./protocol.js');
  const diagnostic = process.env.PLAYWRIGHT_DEMO_UI_DIAGNOSTICS === '1'
    ? (event: import('../interpretation/openai-responses.js').OpenAIResponseDiagnostic): void => {
        rawStderr(`PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC=${JSON.stringify(event)}\n`);
      }
    : undefined;
  const args = process.argv.slice(2);
  const configPath = args.length === 2 && args[0] === '--config' && args[1]
    ? args[1] : undefined;
  const response = configPath
    ? await runSubprocessAdapter(process.stdin,
        () => readSubprocessTrustedConfiguration(configPath),
        { provider: { apiKey: () => process.env.OPENAI_API_KEY, ...(diagnostic ? { diagnostic } : {}) } },
        { signal: controller.signal, ...(eventChannel ? { events: eventChannel.producer } : {}),
          ...(imageChannel ? { images: imageChannel } : {}),
          ...(viewerChannel ? { viewer: viewerChannel } : {}) })
    : { protocolVersion: SUBPROCESS_PROTOCOL_VERSION, kind: 'bridge_error' as const,
        code: 'INVALID_TRUSTED_CONFIGURATION' as const, cleanup: 'not_started' as const };
  let wire;
  try {
    wire = serializeSubprocessResponse(response);
  } catch {
    wire = serializeSubprocessResponse({
      protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      kind: 'bridge_error', code: 'REPORT_INVALID', cleanup: 'unverified',
    });
  }
  await eventChannel?.flush();
  await new Promise<void>((resolve, reject) => rawStdout(wire.body, (error) =>
    error ? reject(error) : resolve()));
  process.exitCode = wire.exitCode;
  eventChannel?.close();
  imageChannel?.close();
  viewerChannel?.close();
  }
  }
  }
} catch {
  // If the channel itself fails, the host classifies the missing response as a process failure.
  process.exitCode = 64;
} finally {
  closeEventChannel?.();
  closeImageChannel?.();
  closeViewerChannel?.();
  removeCancellationHandlers();
}
