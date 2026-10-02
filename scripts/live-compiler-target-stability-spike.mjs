/** Read-only, explicitly gated reproduction of the deferred compiler's first target query. */
if (process.env.PLAYWRIGHT_DEMO_LIVE_COMPILER_TARGET_SPIKE !== '1') {
  process.stderr.write('Set PLAYWRIGHT_DEMO_LIVE_COMPILER_TARGET_SPIKE=1 to run the protected spike.\n');
  process.exit(2);
}

const configPath = process.env.PLAYWRIGHT_DEMO_COMPILER_SPIKE_TRUSTED_CONFIG;
if (!configPath) {
  process.stderr.write('PLAYWRIGHT_DEMO_COMPILER_SPIKE_TRUSTED_CONFIG is required.\n');
  process.exit(2);
}

const { randomUUID } = await import('node:crypto');
const { readSubprocessTrustedConfiguration } = await import('../dist/subprocess/entry.js');
const { SuccessfulTraceV5Store, requireTrustedSuccessfulTraceReadbackV5 } = await import('../dist/evidence/trace-store-v5.js');
const { DeferredCompilerV4Store } = await import('../dist/evidence/deferred-compiler-store-v4.js');
const { ProfileCatalog, ProtectedContextFactory, assertEquivalentEffectiveProfile } = await import('../dist/profile/index.js');
const { McpExplorationSession } = await import('../dist/exploration/mcp.js');
const { ActionCandidateGroundingSessionV1, ActionCandidateGroundingError } = await import('../dist/exploration/action-candidate-grounding.js');

const testSpecId = 'local-c7da74a8-0b99-4289-93b8-ac6d02f18927';
const explorationAttemptId = 'exploration-82c41041-b6a5-4d2e-b5a9-2ef3a5183d62';
const successfulTraceId = 'trace-709e24ad-159a-4656-abff-f19a16eabf49';
const compilerAttemptId = 'compiler-d9e21cac-c0e0-4365-a36d-7145d8d0ebe0';
const root = 'https://the-internet.herokuapp.com/';
const clean = (value, max = 96) => String(value ?? '').replace(/[\r\n|<>]/g, ' ').slice(0, max);
const safeUrl = (value) => {
  try { const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}`; }
  catch { return 'unavailable'; }
};
const sleepUntil = async (at) => {
  const remaining = at - performance.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
};
const errorCode = (error) => error?.message === 'Isolated browser startup and cleanup failed' ? 'ISOLATED_STARTUP_CLEANUP_UNVERIFIED' :
  error instanceof ActionCandidateGroundingError ? error.reason :
  error?.name === 'McpToolError' ? `${error.tool}:failed` : clean(error?.name ?? 'environment_error', 48);

const config = await readSubprocessTrustedConfiguration(configPath, 'active-poc');
const readback = await new SuccessfulTraceV5Store(config.artifactRoot)
  .readSuccessfulExplorationV5(testSpecId, explorationAttemptId);
const { trace } = requireTrustedSuccessfulTraceReadbackV5(readback);
const compiler = await new DeferredCompilerV4Store(config.artifactRoot)
  .readCompilerAttemptV4(testSpecId, compilerAttemptId, readback);
if (trace.successfulTraceId !== successfulTraceId || trace.source.startState.url !== root ||
    compiler.result.status !== 'rejected' || compiler.result.reasonCode !== 'TARGET_MISMATCH')
  throw new Error('Authenticated anchor trace/compiler does not match this spike');
const first = trace.successfulPath[0];
const action = trace.successfulPath.find((record) => record.type === 'action_goal' && record.originStepId === 'step_2');
if (!first || first.type !== 'navigate' || first.url !== root || !action || action.witness.finalCheck.operation !== 'click')
  throw new Error('Authenticated step order differs from the compiler path');
const finalCheck = action.witness.finalCheck;
const request = finalCheck.candidateObservation.request;
if (finalCheck.candidateObservation.predicate.domain !== 'all_current_page_frames' ||
    JSON.stringify(finalCheck.candidateObservation.predicate.roles) !== '["link"]' ||
    JSON.stringify(finalCheck.candidateObservation.predicate.names) !== '["Dropdown"]')
  throw new Error('Authenticated compiler predicate is no longer the expected link query');

const catalog = new ProfileCatalog(config.profiles, config.networkPolicies);
const profileRef = trace.source.executionProfileRef;
const profile = catalog.resolve(profileRef);
if (profile.fingerprint !== trace.profileFingerprint) throw new Error('Trusted profile does not match trace fingerprint');
const factory = new ProtectedContextFactory(catalog);
const rows = [];

async function sample(session, runtime, mapping, at, targetTime) {
  await sleepUntil(targetTime);
  const actualOffsetMs = Math.round(performance.now() - at);
  const pages = session.browserSession.context.pages();
  const page = pages.length === 1 ? pages[0] : undefined;
  if (!page || page.isClosed()) return { actualOffsetMs, error: 'PAGE_UNAVAILABLE' };
  const frames = page.frames().slice(0, 8);
  let linkCount = 0;
  let directDropdownCount = 0;
  for (const frame of frames) {
    linkCount += await frame.getByRole('link', { includeHidden: true }).count();
    directDropdownCount += await frame.getByRole('link', { name: 'Dropdown', exact: true, includeHidden: true }).count();
  }
  const readyState = await page.mainFrame().evaluate(() => document.readyState).catch(() => 'unavailable');
  const title = clean(await page.title().catch(() => 'unavailable'));
  const finalUrl = safeUrl(page.url());
  try {
    // These are precisely the compiler's query and preparation calls. No execution follows.
    const observation = await runtime.query(request);
    if (observation.status !== 'complete') return { actualOffsetMs, finalUrl, readyState, title,
      linkCount, directDropdownCount, candidateCount: null, error: observation.reason };
    let prepared = false;
    let preparationError;
    try { await runtime.prepareGrounding(observation, mapping, 'click'); prepared = true; }
    catch (error) { preparationError = errorCode(error); }
    return { actualOffsetMs, finalUrl, readyState, title, linkCount, directDropdownCount,
      candidateCount: observation.count, prepared, preparationError };
  } catch (error) {
    return { actualOffsetMs, finalUrl, readyState, title, linkCount, directDropdownCount,
      candidateCount: null, error: errorCode(error) };
  }
}

for (let iteration = 1; iteration <= 5; iteration++) {
  let session;
  const row = { iteration, samples: {}, cleanup: 'not_started' };
  rows.push(row);
  try {
    session = await McpExplorationSession.open(factory, profileRef, profile, `compiler-spike-${randomUUID()}`);
    assertEquivalentEffectiveProfile(profile, session.browserSession.effectiveProfile);
    if (session.browserSession.effectiveProfile.fingerprint !== trace.profileFingerprint)
      throw new Error('FRESH_PROFILE_MISMATCH');
    const navigationStart = performance.now();
    await session.navigate(trace.source.startState.url);
    const { runtime, mappings } = ActionCandidateGroundingSessionV1.forFreshCompiler(
      session, readback, `compiler-spike-${randomUUID()}`);
    await ActionCandidateGroundingSessionV1.prototype.protectedTraceState.call(runtime);
    await session.navigate(first.url);
    runtime.invalidate();
    row.navigationMs = Math.round(performance.now() - navigationStart);
    const at = performance.now();
    const mapping = mappings.get(finalCheck.goalId);
    if (!mapping) throw new Error('FRESH_MAPPING_MISSING');
    row.samples.at0 = await sample(session, runtime, mapping, at, at);
    if (row.samples.at0.candidateCount === 0) {
      // Existing Playwright read-only readiness primitive; never clicks or changes the page.
      const page = session.browserSession.context.pages()[0];
      try { await page.waitForLoadState('domcontentloaded', { timeout: 1000 }); row.domContentLoaded = true; }
      catch { row.domContentLoaded = false; }
      row.samples.at1 = await sample(session, runtime, mapping, at, at + 1000);
      row.samples.at3 = await sample(session, runtime, mapping, at, at + 3000);
      row.samples.at5 = await sample(session, runtime, mapping, at, at + 5000);
    }
  } catch (error) {
    row.error = errorCode(error);
  } finally {
    if (session) {
      try { await session.close(); row.cleanup = 'verified'; }
      catch { row.cleanup = 'unverified'; }
    }
  }
  process.stderr.write(`Protected iteration ${iteration}: ${row.error ?? 'observed'}, cleanup=${row.cleanup}\n`);
  if (row.error || row.cleanup !== 'verified') break;
}

const count = (sample) => sample ? (sample.candidateCount ?? `error:${sample.error ?? 'unknown'}`) : '—';
process.stdout.write('| Iteration | Navigation ms | Final URL | readyState | Title | Link count | Direct Dropdown link count | Dropdown candidate count @0s/@1s/@3s/@5s | Cleanup |\n');
process.stdout.write('|---:|---:|---|---|---|---:|---:|---|---|\n');
for (const row of rows) {
  const firstSample = row.samples.at0;
  process.stdout.write(`| ${row.iteration} | ${row.navigationMs ?? 'error'} | ${firstSample?.finalUrl ?? 'unavailable'} | ${firstSample?.readyState ?? 'unavailable'} | ${firstSample?.title ?? 'unavailable'} | ${firstSample?.linkCount ?? '—'} | ${firstSample?.directDropdownCount ?? '—'} | ${[row.samples.at0,row.samples.at1,row.samples.at3,row.samples.at5].map(count).join('/')} | ${row.cleanup} |\n`);
}
for (const row of rows) {
  const facts = Object.entries(row.samples).map(([name, value]) =>
    `${name}:${value.actualOffsetMs}ms query=${count(value)} prepared=${value.prepared ?? 'n/a'}${value.preparationError ? ` prepareStop=${value.preparationError}` : ''}${value.error ? ` queryStop=${value.error}` : ''}`);
  process.stdout.write(`Iteration ${row.iteration} sample timing: ${facts.join(', ') || row.error || 'none'}; domcontentloaded=${row.domContentLoaded ?? 'n/a'}\n`);
}
if (rows.some((row) => row.cleanup !== 'verified' || row.error || row.samples.at0?.candidateCount == null))
  process.exitCode = 1;
