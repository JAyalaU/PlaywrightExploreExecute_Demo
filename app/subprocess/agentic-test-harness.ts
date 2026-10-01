/** Credential-free child for the v2 release test. Never selected by production. */
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;
const { runAgenticSubprocessAdapterV2 } = await import('./agentic-entry.js');
const { runAgenticLocalWorkflow } = await import('../local/agentic-workflow.js');
const { LocalWorkflowRequestSchema } = await import('../local/contracts.js');
const { readSubprocessTrustedConfiguration } = await import('./entry.js');
const { serializeSubprocessResponseV2, SUBPROCESS_PROTOCOL_V2 } = await import('./protocol-v2.js');
const { installSubprocessCancellation } = await import('./cancellation.js');
const controller = new AbortController();
const remove = installSubprocessCancellation(controller);
try {
  const args = process.argv.slice(2);
  const path = args.length === 2 && args[0] === '--config' && args[1] ? args[1] : undefined;
  const response = path ? await runAgenticSubprocessAdapterV2(process.stdin,
    () => readSubprocessTrustedConfiguration(path), { provider: { apiKey: () => undefined } },
    { signal: controller.signal, workflow: (request, config, deps, options) => {
      const parsedRequest = LocalWorkflowRequestSchema.parse(request);
      const base = parsedRequest.targetUrl.endsWith('/') ? parsedRequest.targetUrl : `${parsedRequest.targetUrl}/`;
      const steps = [
        { id: 'step_1', type: 'navigate', sourceText: 'Go to site', url: base },
        { id: 'step_2', type: 'click', sourceText: 'Click Status Codes', target: { description: 'link that says "Status Codes"' } },
        { id: 'step_3', type: 'assert_url', sourceText: 'Confirm Status Codes URL',
          expectedUrl: new URL('status_codes', base).href, match: 'exact' },
        { id: 'step_4', type: 'click', sourceText: 'Click 200', target: { description: 'link with the text: "200"' } },
        { id: 'step_5', type: 'assert_url', sourceText: 'Confirm 200 URL',
          expectedUrl: new URL('status_codes/200', base).href, match: 'exact' },
        { id: 'step_6', type: 'click', sourceText: 'Click here',
          target: { description: 'here link in sentence ending with go here' } },
        { id: 'step_7', type: 'assert_url', sourceText: 'Confirm return URL',
          expectedUrl: new URL('status_codes', base).href, match: 'exact' },
      ];
      const interpretationModel = { complete: async () => JSON.stringify({ kind: 'test_spec', steps }) };
      const decisionModel = { complete: async ({ context }: { context: {
        stage: string; authoredStep: { id: string }; snapshot: string } }) => {
        if (context.stage === 'evaluate') return JSON.stringify({ decisionVersion: '3', kind: 'evaluate', verdict: 'achieved' });
        const name = ({ step_2: 'Status Codes', step_4: '200', step_6: 'here' } as Record<string, string>)[context.authoredStep.id];
        const ref = context.snapshot.split('\n').flatMap((line) => line.includes(`- link "${name}"`)
          ? [/\[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(line)?.[1]] : [])
          .find((value): value is string => !!value);
        return JSON.stringify(ref ? { decisionVersion: '3', kind: 'act', ref, action: 'click',
          source: 'authored', expectedEffect: 'state_changed' } : { decisionVersion: '3', kind: 'inspect' });
      } };
      return runAgenticLocalWorkflow(request, config, deps,
        { ...options, interpretationModel, decisionModel });
    } }) : { protocolVersion: SUBPROCESS_PROTOCOL_V2, kind: 'bridge_error' as const,
      code: 'INVALID_TRUSTED_CONFIGURATION' as const, cleanup: 'not_started' as const };
  const wire = serializeSubprocessResponseV2(response);
  await new Promise<void>((resolve, reject) => write(wire.body, (error) => error ? reject(error) : resolve()));
  process.exitCode = wire.exitCode;
} catch { process.exitCode = 64; }
finally { remove(); }
