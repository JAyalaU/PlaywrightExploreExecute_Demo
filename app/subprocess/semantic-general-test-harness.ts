/** Offline-only subprocess fixture. Production agentic-cli never imports this entry. */
import { OFFLINE_SEMANTIC_FIXTURE_AUTHORITY } from '../local/offline-fixture-authority.js';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const write = process.stdout.write.bind(process.stdout);
function discard(_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
  return true;
}
process.stdout.write = discard as typeof process.stdout.write;
process.stderr.write = discard as typeof process.stderr.write;
// Product-neutral process guard: a Docker executable attempt fails this fixture.
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = ((command: string, ...args: unknown[]) => {
  if (/(?:^|[\\/])docker(?:\.exe|\.cmd)?$/i.test(command))
    throw new Error('Docker process invocation attempted by local semantic fixture');
  return (originalSpawn as (...values: unknown[]) => unknown)(command, ...args);
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
const { runAgenticSubprocessAdapterV2 } = await import('./agentic-entry.js');
const { runAgenticLocalWorkflow } = await import('../local/agentic-workflow.js');
const { readSubprocessTrustedConfiguration } = await import('./read-request.js');
const { serializeSubprocessResponseV2 } = await import('./protocol-v2.js');
const args = process.argv.slice(2);
const path = args.length === 2 && args[0] === '--config' ? args[1] : undefined;
try {
  const response = path ? await runAgenticSubprocessAdapterV2(process.stdin,
    () => readSubprocessTrustedConfiguration(path),
    { provider: { apiKey: () => undefined } },
    { workflowVersion: 'semantic-general-v1', workflow: (request, config, dependencies, options) => {
      const task = request as { targetUrl: string };
      const target = { category: 'checkbox', exactName: null, context: null, ordinal: 1,
        relation: 'unspecified', relatedStepId: null };
      const steps = [
        { id: 'navigate', type: 'navigate', authoredText: 'Go to the site',
          url: task.targetUrl, dependsOnStepId: null },
        { id: 'check', type: 'action_intent', authoredText: 'Check checkbox 1', target,
          desiredEffect: 'set_checked', value: null, checkedState: true,
          authoredMechanic: null, dependsOnStepId: 'navigate' },
        { id: 'assert', type: 'verification_intent', authoredText: 'Verify checkbox 1 is checked',
          subject: target, observable: 'checked', comparator: 'equals', expected: true,
          dependsOnStepId: 'check' },
      ];
      const semanticModels = { primary: { complete: async () => JSON.stringify({ response: {
        kind: 'extraction', steps } }) }, reviewer: { complete: async () => JSON.stringify({
        response: { verdict: 'faithful', issues: [] } }) } };
      return runAgenticLocalWorkflow(request, config, dependencies, { ...options, semanticModels,
        offlineFixtureAuthority: OFFLINE_SEMANTIC_FIXTURE_AUTHORITY });
    } }) : { protocolVersion: '2' as const, kind: 'bridge_error' as const,
    code: 'INVALID_TRUSTED_CONFIGURATION' as const, cleanup: 'not_started' as const };
  const wire = serializeSubprocessResponseV2(response);
  await new Promise<void>((resolve, reject) => write(wire.body, error => error ? reject(error) : resolve()));
  process.exitCode = wire.exitCode;
} catch { process.exitCode = 64; }
