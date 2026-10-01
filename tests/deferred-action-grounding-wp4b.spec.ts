import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { harness, input, compile, fill, execute, select } from './helpers/deferred-v9-fixtures.js';
import { DeferredCompilerV4Store, TrustedResolvedTestReadbackV9, requireTrustedResolvedTestReadbackV9 } from '../app/evidence/deferred-compiler-store-v4.js';
import { DeferredReplayV9Store, requireTrustedDeferredReplayReadbackV1, TrustedDeferredReplayReadbackV1 } from '../app/evidence/deferred-replay-store-v9.js';
import { runDeferredTwoFreshReplaysV1, requireTrustedDeferredReplayV1, TrustedDeferredReplayV1 } from '../app/interpretation/deferred-action-replay.js';
import { projectDeferredReportV2, DeferredReportProjectionV2Schema } from '../app/subprocess/deferred-report-projection-v2.js';
import { SuccessfulTraceAssemblerV5 } from '../app/exploration/trace-assembly-v5.js';
import { SuccessfulTraceV5Store } from '../app/evidence/trace-store-v5.js';
import { TrustedObservationSessionV1 } from '../app/exploration/trusted-observation.js';
import { GoalDirectedVerificationControllerV1 } from '../app/interpretation/verification-strategy.js';
import { ProtectedContextFactory, ProfileCatalog } from '../app/profile/index.js';
import { runAgenticLocalWorkflow } from '../app/local/agentic-workflow.js';
import { LocalArtifactStore } from '../app/evidence/store.js';
import { projectStoredAgenticReportV2 } from '../app/subprocess/report-projection-v2.js';
import { parseTrustedLocalConfiguration } from '../app/local/contracts.js';
import { envelopeForAgenticTerminalV2 } from '../app/subprocess/protocol-v2.js';
import { parseResultRecordV2 } from '../app/domain/agentic-result-v2.js';
import { parseDeferredReplayRecordV1 } from '../app/domain/deferred-action-replay.js';
import { candidateGroundingDigest as hash } from '../app/domain/action-candidate-grounding.js';
import type { TestSpecV6V2 } from '../app/domain/index.js';

type Fixture = Awaited<ReturnType<typeof harness>>;
async function accepted(f: Fixture) { const trace = await input(f), c = await compile(f, trace); expect(c.kind).toBe('compiled');
  const cap = await new DeferredCompilerV4Store(f.root).writeCompilationV4(c.artifact, trace); if (!cap) throw new Error('No v9'); return cap; }
async function withCount(two = false) {
  const text = 'Verify exactly one Notice dialog exists.';
  const g: TestSpecV6V2['steps'][number] = { id: 'verify', type: 'verification_goal', sourceText: text, instruction: text, sourceInstructionSpan: { start: 0, end: text.length },
    subject: { role: 'dialog', accessibleName: 'Notice' }, intent: { kind: 'cardinality', comparison: 'equal', count: 1 } };
  const second = { ...structuredClone(g), id: 'verify2', sourceText: 'Verify exactly one Other dialog exists.', instruction: 'Verify exactly one Other dialog exists.', subject: { role: 'dialog' as const, accessibleName: 'Other' } };
  const f = await harness('<input><div role="dialog" aria-label="Notice">PRIVATE_BROWSER_TEXT</div>' + (two ? '<div role="dialog" aria-label="Other"></div>' : ''), [fill(), g, ...(two ? [second] : [])]);
  const observations = new TrustedObservationSessionV1(f.session, f.runtime);
  const controller = new GoalDirectedVerificationControllerV1(observations, f.runtime, { complete: async ({ context }) => {
    const observation = context.observations.find(o => o.request.kind === 'semantic_query' && o.request.query.name === context.goal.subject!.accessibleName);
    return JSON.stringify(observation ?
      { decisionVersion: '4', kind: 'conclude', conclusion: 'satisfied', comparison: { kind: 'count', operator: 'equal', observationId: observation.observationId, expected: 1 } } :
      { decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query', query: { role: 'dialog', name: context.goal.subject!.accessibleName!, frame: { kind: 'main' } } } });
  } });
  try {
    const b = await SuccessfulTraceAssemblerV5.create({ ...f, observations, verification: controller }), o = await execute(f);
    if (o.status !== 'succeeded') throw new Error('No action'); b.appendActionGroundingWitness(o.witness); controller.noteSuccessfulGroundingWitness(o.witness);
    expect((await controller.evaluate(f.admission.spec.steps[1], 1)).conclusion).toBe('satisfied'); await b.appendVerificationGoal('verify');
    if (two) { const evaluation = await controller.evaluate(f.admission.spec.steps[2], 2); expect(evaluation.conclusion, JSON.stringify(evaluation)).toBe('satisfied'); await b.appendVerificationGoal('verify2'); }
    const t = await new SuccessfulTraceV5Store(f.root).writeSuccessfulExplorationV5(await b.finalize()), c = await compile(f, t); expect(c.kind).toBe('compiled');
    const cap = await new DeferredCompilerV4Store(f.root).writeCompilationV4(c.artifact, t); if (!cap) throw new Error('No v9'); return { f, cap };
  } catch (e) { await f.close(); throw e; }
}
async function persisted(f: Fixture, cap: TrustedResolvedTestReadbackV9) {
  const pair = await runDeferredTwoFreshReplaysV1(f.factory, cap), store = new DeferredReplayV9Store(f.root);
  const readback = await store.writeReplayV1(pair, cap); return { pair, readback, store, ...requireTrustedDeferredReplayReadbackV1(readback) };
}
for (const value of ['true', 'false', 'disagree', 'false-actual-disagree'] as const) test(`two-fresh replay ${value} exact observation agreement`, async () => {
  const { f, cap } = await withCount(); try {
    if (value === 'false' || value === 'false-actual-disagree') f.setHtml('<input>');
    const old = f.factory.open.bind(f.factory); let opens = 0;
    if (value === 'disagree' || value === 'false-actual-disagree') f.factory.open = async (...args) => {
      if (++opens === 2) f.setHtml(value === 'disagree' ? '<input>' : '<input><div role="dialog" aria-label="Notice"></div><div role="dialog" aria-label="Notice"></div>');
      return old(...args);
    };
    const { result, record, readback, store } = await persisted(f, cap);
    expect(record.runs).toHaveLength(2); expect(new Set(record.runs.map(r => r.executionRunId)).size).toBe(2);
    expect(new Set(record.runs.map(r => r.provenance!.sessionId)).size).toBe(2); expect(new Set(record.runs.map(r => r.startState!.pageId)).size).toBe(2);
    const expected = value.includes('disagree') ? 'REPRODUCIBILITY_FAILED' : value === 'true' ? 'QA_ASSERTION_PASSED' : 'QA_ASSERTION_FAILED';
    expect(result.terminal.status).toBe(expected); expect(result.deferredReplay!.resolvedDigest).toBe(requireTrustedResolvedTestReadbackV9(cap).resolved.resolvedDigest);
    const reopened = await new DeferredReplayV9Store(f.root).readReplayV1(result.testSpecId, record.orchestrationId, cap);
    expect(requireTrustedDeferredReplayReadbackV1(reopened)).toEqual({ result, record });
    const display = projectDeferredReportV2(readback), safe = JSON.stringify(display);
    for (const secret of ['exact text', 'PRIVATE_BROWSER_TEXT', 'semantic_count', 'sourceInstruction', 'verification', 'effect', 'predicate', 'actual', 'expected']) expect(safe).not.toContain(secret);
    expect(display.authoritativeQa).toBe(value.includes('disagree') ? undefined : expected);
    expect(envelopeForAgenticTerminalV2(result, true).kind).toBe(value === 'true' ? 'success' : 'typed_stop');
    await expect(store.writeReplayV1({ ...requireTrustedDeferredReplayV1((await runDeferredTwoFreshReplaysV1(f.factory, cap))) } as never, cap)).rejects.toThrow('Untrusted two-replay origin');
  } finally { await f.close(); }
});
test('zero assertion completed execution stays non-QA with isolated fresh state', async () => { const f = await harness(select); try {
  const cap = await accepted(f); const old = f.factory.open.bind(f.factory); let opens = 0;
  f.factory.open = async (...args) => { const session = await old(...args); opens++; expect(await session.context.cookies()).toEqual([]);
    await session.context.addCookies([{ name: 'isolation', value: `${opens}`, url: f.url }]); return session; };
  const { result, record, readback } = await persisted(f, cap); expect(opens).toBe(2); expect(result.terminal).toEqual({ stage: 'execution', status: 'EXECUTION_REPRODUCED', reason: 'NO_ASSERTIONS' });
  expect(record.agreement).toBe('agreed'); expect(projectDeferredReportV2(readback).authoritativeQa).toBeUndefined(); expect(envelopeForAgenticTerminalV2(result, true).kind).toBe('typed_stop');
} finally { await f.close(); } });
for (const kind of ['guard', 'cleanup', 'second-guard', 'throw'] as const) test(`runner ${kind} remains non-QA without retry`, async () => {
  const f = await harness(select); try { const cap = await accepted(f), old = f.factory.open.bind(f.factory); let opens = 0;
    if (kind === 'guard') f.setHtml(select + select);
    f.factory.open = async (...args) => { opens++; if (kind === 'throw') throw new Error('PRIVATE_ERROR'); if (kind === 'second-guard' && opens === 2) f.setHtml(select + select);
      const session = await old(...args); if (kind === 'cleanup') session.closeWithFinalCheck = async () => { await session.close(); throw new Error('PRIVATE_CLEANUP'); }; return session; };
    const { record, result, readback } = await persisted(f, cap); expect(opens).toBe(kind === 'second-guard' ? 2 : 1); expect(result.terminal.stage).not.toBe('qa');
    expect(record.agreement).toBe('not_established'); expect(projectDeferredReportV2(readback).authoritativeQa).toBeUndefined();
    if (kind === 'cleanup') expect(result.cleanup).toBe('unverified');
    if (kind === 'throw') { expect(result.terminal.stage).toBe('environment'); expect(result.cleanup).toBe('verified'); }
    if (kind === 'second-guard') { expect(record.runs[0]!.steps[0]!.effect?.kind).toBe('native_choice'); expect(record.runs[1]!.steps[0]!.effect).toBeUndefined(); }
  } finally { await f.close(); }
});
test('authentic v9/pair/readback only; forged provenance cannot grant authority', async () => { const f = await harness(select); try {
  const cap = await accepted(f), old = f.factory.open.bind(f.factory); let opens = 0; f.factory.open = async (...a) => { opens++; return old(...a); };
  for (const forged of [{}, Object.create(TrustedResolvedTestReadbackV9.prototype), requireTrustedResolvedTestReadbackV9(cap)]) await expect(runDeferredTwoFreshReplaysV1(f.factory, forged as never)).rejects.toThrow();
  expect(opens).toBe(0); const p = await persisted(f, cap);
  expect(() => projectDeferredReportV2(Object.create(TrustedDeferredReplayReadbackV1.prototype))).toThrow();
  await expect(p.store.writeReplayV1(Object.create(TrustedDeferredReplayV1.prototype), cap)).rejects.toThrow();
  const altered = structuredClone(p.record); altered.runs[0]!.provenance!.resolvedSpecId = 'substitute'; const { recordDigest: _d, ...body } = altered; altered.recordDigest = hash(body);
  expect(() => parseDeferredReplayRecordV1(altered, requireTrustedResolvedTestReadbackV9(cap))).toThrow();
  const file = path.join(f.root, 'deferred-replay-v9-result-v2', p.result.testSpecId, `${p.record.orchestrationId}.json`), envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.result.terminal = { stage: 'qa', status: 'QA_ASSERTION_PASSED' }; await writeFile(file, JSON.stringify(envelope));
  await expect(new DeferredReplayV9Store(f.root).readReplayV1(p.result.testSpecId, p.record.orchestrationId, cap)).rejects.toThrow('authenticated owner');
} finally { await f.close(); } });
test('version-aware result isolated from old route and selection remains disabled', async () => {
  expect(() => parseResultRecordV2({ resultVersion: '2', workflowVersion: 'agentic-exploration-v1', testSpecId: 's', executionProfileRef: { id: 'p', version: '1' }, profileFingerprint: 'a'.repeat(64),
    presentationMode: 'headless', observation: 'unobserved', executionRunIds: [], cleanup: 'verified', terminal: { stage: 'execution', status: 'EXECUTION_REPRODUCED', reason: 'NO_ASSERTIONS' } })).toThrow();
  await expect(runAgenticLocalWorkflow({}, {}, {} as never, { workflowVersion: 'deferred-action-v1' } as never)).rejects.toThrow('INVALID_TRUSTED_CONFIGURATION');
});
test('actual two-run execution and authenticated result read with exploration/MCP/SDK unavailable', async () => { const f = await harness(select); try {
  const cap = await accepted(f), a = requireTrustedResolvedTestReadbackV9(cap), profile = f.factory.catalog.resolve(a.trace.executionProfileRef);
  const script = `import { registerHooks } from 'node:module';registerHooks({resolve(s,c,n){if(s.includes('@playwright/mcp')||s.includes('@modelcontextprotocol/'))throw Error('blocked');const r=n(s,c);if(r.url.includes('/exploration/'))throw Error('blocked exploration');return r;}});
  const {SuccessfulTraceV5Store}=await import('./dist/evidence/trace-store-v5.js');const {DeferredCompilerV4Store}=await import('./dist/evidence/deferred-compiler-store-v4.js');
  const {runDeferredTwoFreshReplaysV1}=await import('./dist/interpretation/deferred-action-replay.js');const {DeferredReplayV9Store}=await import('./dist/evidence/deferred-replay-store-v9.js');
  const {projectDeferredReportV2}=await import('./dist/subprocess/deferred-report-projection-v2.js');const {ProtectedContextFactory}=await import('./dist/profile/context.js');const {ProfileCatalog}=await import('./dist/profile/contracts.js');
  const trace=await new SuccessfulTraceV5Store(${JSON.stringify(f.root)}).readSuccessfulExplorationV5(${JSON.stringify(a.trace.testSpecId)},${JSON.stringify(a.trace.explorationAttemptId)});
  const cap=await new DeferredCompilerV4Store(${JSON.stringify(f.root)}).readResolvedV9(${JSON.stringify(a.resolved.testSpecId)},${JSON.stringify(a.compiler.compilerAttemptId)},trace);
  const pair=await runDeferredTwoFreshReplaysV1(new ProtectedContextFactory(new ProfileCatalog(${JSON.stringify([profile.profile])},${JSON.stringify([profile.policy])})),cap);
  const read=await new DeferredReplayV9Store(${JSON.stringify(f.root)}).writeReplayV1(pair,cap);console.log(JSON.stringify(projectDeferredReportV2(read).result.terminal));`;
  const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 45000, encoding: 'utf8' });
  expect(JSON.parse(output.stdout.trim())).toEqual({ stage: 'execution', status: 'EXECUTION_REPRODUCED', reason: 'NO_ASSERTIONS' });
} finally { await f.close(); } });
test('fresh process authenticates a previously persisted pair and projects only bounded results', async () => {
  const { f, cap } = await withCount(); try {
    const saved = await persisted(f, cap), artifact = requireTrustedResolvedTestReadbackV9(cap);
    expect(saved.result.terminal.status).toBe('QA_ASSERTION_PASSED');
    const script = `import { registerHooks } from 'node:module';registerHooks({resolve(s,c,n){if(s.includes('@playwright/mcp')||s.includes('@modelcontextprotocol/'))throw Error('blocked');const r=n(s,c);if(r.url.includes('/exploration/'))throw Error('blocked exploration');return r;}});
      const {SuccessfulTraceV5Store}=await import('./dist/evidence/trace-store-v5.js');
      const {DeferredCompilerV4Store}=await import('./dist/evidence/deferred-compiler-store-v4.js');
      const {DeferredReplayV9Store}=await import('./dist/evidence/deferred-replay-store-v9.js');
      const {projectDeferredReportV2}=await import('./dist/subprocess/deferred-report-projection-v2.js');
      const trace=await new SuccessfulTraceV5Store(${JSON.stringify(f.root)}).readSuccessfulExplorationV5(${JSON.stringify(artifact.trace.testSpecId)},${JSON.stringify(artifact.trace.explorationAttemptId)});
      const cap=await new DeferredCompilerV4Store(${JSON.stringify(f.root)}).readResolvedV9(${JSON.stringify(artifact.resolved.testSpecId)},${JSON.stringify(artifact.compiler.compilerAttemptId)},trace);
      const pair=await new DeferredReplayV9Store(${JSON.stringify(f.root)}).readReplayV1(${JSON.stringify(saved.result.testSpecId)},${JSON.stringify(saved.record.orchestrationId)},cap);
      const safe=projectDeferredReportV2(pair);console.log(JSON.stringify({terminal:safe.result.terminal,qa:safe.authoritativeQa,replayCount:safe.replays.length,assertionCounts:safe.replays.map(r=>r.assertionCount),serialized:JSON.stringify(safe)}));`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
      { cwd: process.cwd(), timeout: 30000, encoding: 'utf8' });
    const output = JSON.parse(child.stdout.trim()) as { terminal: unknown; qa: string; replayCount: number; assertionCounts: number[]; serialized: string };
    expect(output.terminal).toEqual({ stage: 'qa', status: 'QA_ASSERTION_PASSED' });
    expect(output.qa).toBe('QA_ASSERTION_PASSED'); expect(output.replayCount).toBe(2); expect(output.assertionCounts).toEqual([1, 1]);
    for (const secret of ['PRIVATE_BROWSER_TEXT', 'exact text', 'sourceInstruction', 'semantic_count', 'predicate', 'actual', 'expected', 'guard'])
      expect(output.serialized).not.toContain(secret);
  } finally { await f.close(); }
});
test('aggregate false does not hide disagreement over corresponding assertions', async () => {
  const { f, cap } = await withCount(true); try {
    f.setHtml('<input><div role="dialog" aria-label="Other"></div>');
    const old = f.factory.open.bind(f.factory); let opens = 0;
    f.factory.open = async (...args) => { if (++opens === 2) f.setHtml('<input><div role="dialog" aria-label="Notice"></div>'); return old(...args); };
    const { record, result } = await persisted(f, cap);
    expect(record.runs.map(r => r.result)).toEqual([{ kind: 'completed', assertions: 2, passed: false }, { kind: 'completed', assertions: 2, passed: false }]);
    expect(result.terminal.status).toBe('REPRODUCIBILITY_FAILED');
  } finally { await f.close(); }
});
test('closed projection and result reject contradictory execution or missing successful sessions', async () => {
  const f = await harness(select); try { const cap = await accepted(f), p = await persisted(f, cap), display = projectDeferredReportV2(p.readback);
    expect(() => DeferredReportProjectionV2Schema.parse({ ...display, reproducibility: 'not_established' })).toThrow();
    expect(() => DeferredReportProjectionV2Schema.parse({ ...display, replays: display.replays.map(r => ({ ...r, assertionCount: 1 })) })).toThrow();
    expect(() => parseResultRecordV2({ ...p.result, deferredReplay: { ...p.result.deferredReplay, executionSessionIds: [] } })).toThrow();
  } finally { await f.close(); }
});
test('missing approved profile produces typed stop before context creation', async () => {
  const f = await harness(select); try { const cap = await accepted(f), empty = new ProtectedContextFactory(new ProfileCatalog([], []));
    const pair = await runDeferredTwoFreshReplaysV1(empty, cap), record = requireTrustedDeferredReplayV1(pair);
    expect(record.runs).toHaveLength(1); expect(record.runs[0]!.result).toMatchObject({ kind: 'non_qa_stop', reasonCode: 'ENVIRONMENT_FAILURE' });
    expect(record.agreement).toBe('not_established');
  } finally { await f.close(); }
});
test('historical store and projector explicitly reject a valid deferred-family envelope', async () => {
  const f = await harness(select); try {
    const cap = await accepted(f), p = await persisted(f, cap), effective = f.factory.catalog.resolve(p.result.executionProfileRef);
    const source = { schemaVersion: '2', testSpecId: p.result.testSpecId, sourceInstruction: `Go to ${f.url}.`, executionProfileRef: p.result.executionProfileRef,
      startState: { url: f.url }, steps: [{ id: 'go', type: 'navigate', sourceText: `Go to ${f.url}.`, url: f.url }] };
    const old = new LocalArtifactStore(f.root); await old.createJob(source, effective);
    await expect(old.writeAgenticTerminalV2(p.result)).rejects.toThrow('authenticated replay-v9');
    // Direct historical-file substitution must also fail on read, even with an otherwise valid job/profile.
    await writeFile(path.join(f.root, p.result.testSpecId, 'agentic-terminal-v2.json'), JSON.stringify(p.result));
    await expect(old.readAgenticTerminalV2(p.result.testSpecId)).rejects.toThrow('authenticated replay-v9');
    const config = parseTrustedLocalConfiguration({ profiles: [effective.profile], networkPolicies: [effective.policy], artifactRoot: f.root, retentionDays: 7,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false, failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false } });
    expect(await projectStoredAgenticReportV2({ reportProjectionVersion: '2', result: envelopeForAgenticTerminalV2(p.result, true) }, config))
      .toEqual({ reportProjectionVersion: '2', kind: 'unavailable', reason: 'REPORT_UNAVAILABLE' });
    expect(projectDeferredReportV2(p.readback).result.terminal.status).toBe('EXECUTION_REPRODUCED');
  } finally { await f.close(); }
});
