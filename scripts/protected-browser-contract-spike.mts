/** Explicit, read-only protected-browser boundary probe. No provider or action tools. */
if (process.env.PLAYWRIGHT_DEMO_LIVE_BROWSER_TESTS !== '1') {
  process.stderr.write('Set PLAYWRIGHT_DEMO_LIVE_BROWSER_TESTS=1 to run this protected-browser probe.\n');
  process.exit(2);
}

const { randomUUID } = await import('node:crypto');
const { loadProjectEnv } = await import('../dist/local/project-env.js');
loadProjectEnv();
const { readSubprocessTrustedConfiguration } = await import('../dist/subprocess/entry.js');
const { ProfileCatalog, ProtectedContextFactory } = await import('../dist/profile/index.js');
const { McpExplorationSession, McpToolError } = await import('../dist/exploration/mcp.js');
const { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } = await import('../dist/exploration/action-candidate-grounding.js');
const { admitActionSemanticsV2 } = await import('../dist/domain/action-semantic-admission.js');

const root = 'https://the-internet.herokuapp.com/';
const configPath = process.env.PLAYWRIGHT_DEMO_TRUSTED_CONFIG;
if (!configPath) throw new Error('PLAYWRIGHT_DEMO_TRUSTED_CONFIG is required');
const config = await readSubprocessTrustedConfiguration(configPath);
const approvedRef = config.publicTargetApproval?.executionProfileRef;
const profileRef = approvedRef && config.profiles.some((item) =>
  item.id === approvedRef.id && item.version === approvedRef.version)
  ? approvedRef : { id: config.profiles[0].id, version: config.profiles[0].version };
// This read-only diagnostic allows the public site's slow assets more time to
// reach DOM readiness. Production profile settings are not rewritten.
const profiles = config.profiles.map((item) => item.id === profileRef.id && item.version === profileRef.version
  ? { ...item, timeoutPolicy: { ...item.timeoutPolicy,
    navigationMs: Math.max(item.timeoutPolicy.navigationMs, 90_000) } }
  : item);
const catalog = new ProfileCatalog(profiles, config.networkPolicies);
const profile = catalog.resolve(profileRef);
const factory = new ProtectedContextFactory(catalog);

type Result = { probe: string; result: 'PASS' | 'FAIL' | 'SKIP'; elapsedMs: number; detail: string };
const rows: Result[] = [];
const now = () => performance.now();
const boundedDiagnostic = (value: string) => value
  .replace(/https?:\/\/[^\s|]+/gi, '[url]')
  .replace(/[\r\n|]+/g, ' ').slice(0, 240);
function safeFailure(error: unknown): string {
  if (error instanceof AggregateError && error.message === 'Isolated browser startup and cleanup failed')
    return `isolated-startup+cleanup:${error.errors.slice(0, 2).map(safeFailure).join(',')}`;
  if (error instanceof ActionCandidateGroundingError) return `grounding:${error.reason}`;
  if (error instanceof McpToolError) {
    return `${error.tool}:${boundedDiagnostic(error.reason)}`;
  }
  if (error instanceof Error) {
    if (error.message === 'Docker control command failed') return 'DOCKER_CONTROL_FAILED';
    if (error.message === 'Docker control command unavailable') return 'DOCKER_CONTROL_UNAVAILABLE';
    if (error.message === 'Isolated browser control stopped') return 'ISOLATED_BROWSER_CONTROL_EXIT';
    if (error.message === 'Isolated browser control unavailable') return 'ISOLATED_BROWSER_CONTROL_UNAVAILABLE';
    if (error.message === 'Isolated browser container cleanup unverified') return 'CONTAINER_CLEANUP_UNVERIFIED';
    return `${error.name}:${boundedDiagnostic(error.message)}`;
  }
  return 'UNKNOWN_ENVIRONMENT_ERROR';
}
async function probe(label: string, execute: () => Promise<string>): Promise<boolean> {
  const start = now();
  try {
    const detail = await execute();
    rows.push({ probe: label, result: 'PASS', elapsedMs: Math.round(now() - start), detail });
    return true;
  } catch (error) {
    const page = label === 'B navigate' ? session?.browserSession.context.pages()[0] : undefined;
    const pageState = !page ? 'none' : page.url() === root ? 'root' : page.url() === 'about:blank' ? 'about:blank' : 'other';
    const detail = label === 'B navigate'
      ? `${safeFailure(error)}; mcpCall=${session?.calls.some((call) => call.name === 'browser_navigate') ? 'yes' : 'no'}; page=${pageState}`
      : safeFailure(error);
    rows.push({ probe: label, result: 'FAIL', elapsedMs: Math.round(now() - start), detail });
    return false;
  }
}
const skipRest = (from: number) => {
  for (const label of ['A open', 'B navigate', 'C snapshot', 'D state'].slice(from))
    rows.push({ probe: label, result: 'SKIP', elapsedMs: 0, detail: 'earlier probe failed' });
};

let session: InstanceType<typeof McpExplorationSession> | undefined;
let cleanup = 'not_started';
try {
  if (!await probe('A open', async () => {
    session = await McpExplorationSession.open(factory, profileRef, profile, `exploration-${randomUUID()}`);
    return `MCP ready; protected context; tools=${session.toolInventory.length}`;
  })) skipRest(1);
  else if (!await probe('B navigate', async () => {
    const outcome = await session!.navigate(root);
    const page = session!.browserSession.context.pages()[0];
    const finalUrl = page?.url();
    return `MCP completed; responseChars=${outcome.length}; finalUrl=${finalUrl === root ? 'root' : 'other'}`;
  })) skipRest(2);
  else if (!await probe('C snapshot', async () => {
    const observation = await session!.snapshot();
    const page = session!.browserSession.context.pages()[0];
    const finalUrl = page?.url();
    return `snapshot=${observation.length > 0 ? 'present' : 'empty'}; boundedChars=${Math.min(observation.length, 131_072)}; finalUrl=${finalUrl === root ? 'root' : 'other'}`;
  })) skipRest(3);
  else await probe('D state', async () => {
    // A local, deterministic navigation-only sentinel supplies semantic context.
    // No model, interpretation, decision or mutation runs.
    const sourceInstruction = `Navigate to ${root}`;
    const sourceInstructionSpan = { start: 0, end: sourceInstruction.length };
    const spec = { schemaVersion: '6' as const, sourceContractVersion: '2' as const,
      testSpecId: 'browser-contract-spike', sourceInstruction,
      executionProfileRef: profileRef, startState: { url: root },
      steps: [{ id: 's1', type: 'navigate' as const, sourceText: sourceInstruction,
        sourceInstructionSpan, url: root }],
      instructionAccounting: [{ classification: 'clause' as const, stepId: 's1',
        sourceSpan: sourceInstructionSpan, authoredText: sourceInstruction }] };
    const trusted = { testSpecId: spec.testSpecId, sourceInstruction, executionProfileRef: spec.executionProfileRef,
      startState: spec.startState };
    const admission = admitActionSemanticsV2(trusted, spec, structuredClone(spec), {
      goalContractVersion: '2', primaryExtractionVersion: 'browser_contract_spike',
      independentExtractionVersion: 'browser_contract_spike', primaryPromptVersion: 'browser_contract_spike',
      independentPromptVersion: 'browser_contract_spike',
    });
    const runtime = new ActionCandidateGroundingSessionV1(session!, admission, 'browser-contract-spike');
    const state = await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(runtime);
    return `validState=${!!state.stateDigest}; pages=1; frames=${Math.min(state.frames.length, 8)}; finalUrl=${state.page.url() === root ? 'root' : 'other'}`;
  });
} finally {
  if (session) {
    try { await session.close(); cleanup = 'verified'; }
    catch { cleanup = 'unverified'; }
  }
  process.stdout.write('| Probe | Result | Time | Safe detail |\n|---|---|---:|---|\n');
  for (const row of rows) process.stdout.write(`| ${row.probe} | ${row.result} | ${row.elapsedMs} ms | ${row.detail} |\n`);
  process.stdout.write(`Session cleanup: ${cleanup}${session ? '' : ' (open did not return; internal startup cleanup is separate)'}\n`);
}
if (rows.some((row) => row.result === 'FAIL') || cleanup !== 'verified') process.exitCode = 1;
