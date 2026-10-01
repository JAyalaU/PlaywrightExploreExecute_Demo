/** Agentic protocol-v2 machine entry. All incidental output is suppressed. */
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;

const { installSubprocessCancellation } = await import('./cancellation.js');
const controller = new AbortController();
const remove = installSubprocessCancellation(controller);
try {
  const { loadProjectEnv } = await import('../local/project-env.js');
  loadProjectEnv();
  const { runAgenticSubprocessAdapterV2 } = await import('./agentic-entry.js');
  const { readSubprocessTrustedConfiguration } = await import('./entry.js');
  const { serializeSubprocessResponseV2, SUBPROCESS_PROTOCOL_V2 } = await import('./protocol-v2.js');
  const args = process.argv.slice(2);
  const path = args.length === 2 && args[0] === '--config' && args[1] ? args[1] : undefined;
  const selected = process.env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION ?? 'agentic-exploration-v1';
  const workflowVersion = selected === 'deferred-action-v1' && process.env.PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE === 'offline-review' ||
    selected === 'structured-action-v1' || selected === 'goal-directed-v1' || selected === 'agentic-exploration-v1'
    ? selected : undefined;
  const response = path && workflowVersion ? await runAgenticSubprocessAdapterV2(process.stdin,
    () => readSubprocessTrustedConfiguration(path),
    { provider: { apiKey: () => process.env.OPENAI_API_KEY } },
    { signal: controller.signal, workflowVersion }) :
    { protocolVersion: SUBPROCESS_PROTOCOL_V2, kind: 'bridge_error' as const,
      code: 'INVALID_TRUSTED_CONFIGURATION' as const, cleanup: 'not_started' as const };
  let wire;
  try { wire = serializeSubprocessResponseV2(response); }
  catch { wire = serializeSubprocessResponseV2({ protocolVersion: SUBPROCESS_PROTOCOL_V2,
    kind: 'bridge_error', code: 'REPORT_INVALID', cleanup: 'unverified' }); }
  await new Promise<void>((resolve, reject) => write(wire.body, (error) => error ? reject(error) : resolve()));
  process.exitCode = wire.exitCode;
} catch {
  process.exitCode = 64;
} finally { remove(); }
