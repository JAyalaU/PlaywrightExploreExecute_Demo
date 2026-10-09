import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const phase = z.enum(['guard_complete', 'click_invocation_started', 'click_invocation_returned',
  'click_invocation_threw', 'action_receipt_sealed', 'post_action_boundary_entered']);
export const ClickFailureV10Schema = z.enum(['PLAYWRIGHT_CLICK_TIMEOUT', 'TARGET_DETACHED_DURING_CLICK',
  'PAGE_CLOSED_DURING_CLICK', 'CONTEXT_CLOSED_DURING_CLICK', 'BROWSER_DISCONNECTED',
  'NAVIGATION_INTERRUPTED_CLICK', 'EXECUTION_CONTEXT_CHANGED', 'PROTOCOL_ERROR',
  'CLICK_API_FAILURE', 'UNKNOWN_CLICK_FAILURE']);
export type ClickFailureV10 = z.infer<typeof ClickFailureV10Schema>;
const state = z.strictObject({ monotonicMs: z.number().finite().nonnegative(), browserConnected: z.boolean(),
  contextOpen: z.boolean(), pageOpen: z.boolean(), sanitizedUrl: z.string().max(256),
  pageId: id, mainFrameId: id, navigationGeneration: z.number().int().nonnegative(),
  navigationRequestGeneration: z.number().int().nonnegative(),
  documentTimeOrigin: z.number().finite().nonnegative().nullable(),
  readyState: z.enum(['loading', 'interactive', 'complete']).nullable() });
const milestone = z.strictObject({ stepId: id, phase, state, elapsedMs: z.number().finite().nonnegative(),
  targetIdentity: digest, domainDigest: digest, failure: ClickFailureV10Schema.nullable(),
  navigationDuringClick: z.boolean().nullable(), documentReplacedDuringClick: z.boolean().nullable() });
const effect = z.strictObject({ actionStepId: id, assertionStepId: id, count: z.number().int().min(0).max(100).nullable(),
  state, error: z.boolean() });
const transition = z.strictObject({ count: z.number().int().min(0).max(100), state });
const settling = z.strictObject({ stepId: id, comparator: z.enum(['equals', 'at_least', 'at_most']),
  expected: z.number().int().min(0).max(10000), started: state, initialCount: z.number().int().min(0).max(100),
  transitions: z.array(transition).max(32), finalCount: z.number().int().min(0).max(100),
  ended: state, elapsedMs: z.number().finite().nonnegative(), exhausted: z.boolean(),
  interrupted: z.boolean(), navigationRequestedDuringSettling: z.boolean(),
  documentChanged: z.boolean() });
const boundary = z.strictObject({ stepId: id, phase: z.enum(['step_started', 'step_sealed']), state });
const countFailure = z.strictObject({ stepId: id,
  category: z.enum(['COUNT_OBSERVATION_ERROR', 'COUNT_SETTLING_WAIT_ERROR']), state });
export const SemanticRunnerDiagnosticV10Schema = z.strictObject({
  recordVersion: z.literal('semantic_runner_diagnostic_v10'), executionRunId: id,
  resolvedSpecId: id, compilerAttemptId: id, traceDigest: digest,
  clicks: z.array(milestone).max(600), effects: z.array(effect).max(100),
  counts: z.array(settling).max(100), boundaries: z.array(boundary).max(200),
  countFailures: z.array(countFailure).max(100) });
export type DiagnosticStateV10 = z.infer<typeof state>;
export type ClickMilestoneV10 = z.infer<typeof milestone>;
export type EffectProbeV10 = z.infer<typeof effect>;
export type CountSettlingV10 = z.infer<typeof settling>;
export type SemanticRunnerDiagnosticV10 = z.infer<typeof SemanticRunnerDiagnosticV10Schema>;

const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1_000_000;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Preserve only origin and a digest of the path. Query, fragment, credentials and page text never leave the browser. */
function sanitizedUrl(raw: string): string {
  try { const url = new URL(raw); return `${url.protocol}//${url.host}/#path-${sha(url.pathname).slice(0, 16)}`.slice(0, 256); }
  catch { return 'unavailable'; }
}
export function classifyClickFailureV10(error: unknown, state: DiagnosticStateV10): ClickFailureV10 {
  if (!state.browserConnected) return 'BROWSER_DISCONNECTED';
  if (!state.contextOpen) return 'CONTEXT_CLOSED_DURING_CLICK';
  if (!state.pageOpen) return 'PAGE_CLOSED_DURING_CLICK';
  const value = error instanceof Error ? `${error.name} ${error.message}` : '';
  if (/detached|not attached/i.test(value)) return 'TARGET_DETACHED_DURING_CLICK';
  if (/navigation.*interrupt|interrupted.*navigation/i.test(value)) return 'NAVIGATION_INTERRUPTED_CLICK';
  if (/execution context.*destroyed|context.*changed/i.test(value)) return 'EXECUTION_CONTEXT_CHANGED';
  if (/protocol error|target closed.*protocol/i.test(value)) return 'PROTOCOL_ERROR';
  if (/timeout/i.test(value)) return 'PLAYWRIGHT_CLICK_TIMEOUT';
  if (error instanceof Error) return 'CLICK_API_FAILURE';
  return 'UNKNOWN_CLICK_FAILURE';
}

/** Observation only. The event counter is a navigation signal; timeOrigin distinguishes a new document. */
export class RunnerV10DiagnosticCollector {
  readonly clicks: ClickMilestoneV10[] = [];
  readonly effects: EffectProbeV10[] = [];
  readonly counts: CountSettlingV10[] = [];
  readonly boundaries: z.infer<typeof boundary>[] = [];
  readonly countFailures: z.infer<typeof countFailure>[] = [];
  readonly #pageId = `page-${randomUUID()}`;
  readonly #frameId = `frame-${randomUUID()}`;
  readonly #clickStarts = new Map<string, number>();
  #navigationGeneration = 0;
  #navigationRequestGeneration = 0;
  #contextClosed = false;
  readonly #started = monotonicMs();
  constructor(readonly page: Page) {
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.#navigationGeneration++; });
    page.on('request', request => { try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        this.#navigationRequestGeneration++;
    } catch { /* observation */ } });
    page.context().on('close', () => { this.#contextClosed = true; });
  }
  base(): DiagnosticStateV10 {
    let connected = false;
    try { connected = this.page.context().browser()?.isConnected() ?? false; } catch { /* observation */ }
    let url = 'unavailable';
    try { url = sanitizedUrl(this.page.url()); } catch { /* observation */ }
    return { monotonicMs: monotonicMs() - this.#started, browserConnected: connected,
      contextOpen: !this.#contextClosed, pageOpen: !this.page.isClosed(), sanitizedUrl: url,
      pageId: this.#pageId, mainFrameId: this.#frameId,
      navigationGeneration: this.#navigationGeneration,
      navigationRequestGeneration: this.#navigationRequestGeneration,
      documentTimeOrigin: null, readyState: null };
  }
  /** Browser evaluation is launched without awaiting it in the execution path. */
  snapshot(onResult: (value: DiagnosticStateV10) => void): void {
    const base = this.base();
    try {
      const pending = this.page.evaluate(() => ({ readyState: document.readyState,
        timeOrigin: performance.timeOrigin })).then(value => {
        onResult({ ...base, readyState: value.readyState,
          documentTimeOrigin: Number.isFinite(value.timeOrigin) ? value.timeOrigin : null });
      }).catch(() => { onResult(base); });
      void pending;
    } catch { onResult(base); }
  }
  enrich(value: DiagnosticStateV10): void { this.snapshot(snapshot => Object.assign(value, snapshot)); }
  boundary(stepId: string, phaseValue: 'step_started' | 'step_sealed'): void {
    if (this.boundaries.length >= 200) return;
    const value = { stepId, phase: phaseValue, state: this.base() };
    this.boundaries.push(value); this.enrich(value.state);
  }
  countFailure(stepId: string, category: 'COUNT_OBSERVATION_ERROR' | 'COUNT_SETTLING_WAIT_ERROR'): void {
    if (this.countFailures.length >= 100) return;
    const value = { stepId, category, state: this.base() };
    this.countFailures.push(value); this.enrich(value.state);
  }
  milestone(stepId: string, phaseValue: ClickMilestoneV10['phase'], targetIdentity: string,
    domainDigest: string, startMs: number, failure: ClickFailureV10 | null = null): void {
    if (this.clicks.length >= 600) return;
    if (phaseValue === 'guard_complete') this.#clickStarts.set(stepId, startMs);
    const index = this.clicks.length;
    this.clicks.push({ stepId, phase: phaseValue, targetIdentity, domainDigest,
      state: this.base(), elapsedMs: Math.max(0, monotonicMs() - startMs), failure,
      navigationDuringClick: null, documentReplacedDuringClick: null });
    this.snapshot(stateValue => { this.clicks[index]!.state = stateValue; });
  }
  clickStart(stepId: string): number { return this.#clickStarts.get(stepId) ?? this.startMs(); }
  startMs(): number { return monotonicMs(); }
  effect(actionStepId: string, assertionStepId: string, query: () => Promise<number>): void {
    if (this.effects.length >= 100) return;
    const index = this.effects.length;
    this.effects.push({ actionStepId, assertionStepId, count: null, state: this.base(), error: false });
    const pending = Promise.resolve().then(query).then(count => {
      this.effects[index]!.count = count >= 0 && count <= 100 ? count : null;
      this.effects[index]!.state = this.base();
    }).catch(() => { this.effects[index]!.error = true; this.effects[index]!.state = this.base(); });
    void pending;
  }
  record(input: Omit<SemanticRunnerDiagnosticV10,
    'recordVersion' | 'clicks' | 'effects' | 'counts' | 'boundaries' | 'countFailures'>):
    SemanticRunnerDiagnosticV10 {
    for (const click of this.clicks) if (click.phase === 'click_invocation_returned' ||
      click.phase === 'click_invocation_threw') {
      const start = this.clicks.find(item => item.stepId === click.stepId &&
        item.phase === 'click_invocation_started');
      if (start) {
        click.navigationDuringClick = start.state.navigationGeneration !== click.state.navigationGeneration;
        click.documentReplacedDuringClick = start.state.documentTimeOrigin !== null &&
          click.state.documentTimeOrigin !== null ?
          start.state.documentTimeOrigin !== click.state.documentTimeOrigin : null;
      }
    }
    for (const count of this.counts) count.documentChanged =
      count.started.documentTimeOrigin !== null && count.ended.documentTimeOrigin !== null ?
        count.started.documentTimeOrigin !== count.ended.documentTimeOrigin : false;
    return SemanticRunnerDiagnosticV10Schema.parse({ ...input, recordVersion: 'semantic_runner_diagnostic_v10',
      clicks: this.clicks, effects: this.effects, counts: this.counts,
      boundaries: this.boundaries, countFailures: this.countFailures });
  }
}

const envelope = z.strictObject({ data: SemanticRunnerDiagnosticV10Schema, authentication: digest });
/** Restricted, capped, authenticated readback; never used for replay or QA. */
export class SemanticRunnerDiagnosticsV10Store {
  readonly #root: string;
  #key: Promise<Buffer> | undefined;
  constructor(root: string) { this.#root = path.resolve(root); }
  async #directory(): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (path.relative(this.#root, await realpath(this.#root)) !== '') throw new Error('Diagnostic root symlink');
    const directory = path.join(this.#root, 'semantic-runner-diagnostics-v10');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const item of [this.#root, directory]) { const info = await lstat(item);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid diagnostic directory'); }
    return directory;
  }
  async #authority(): Promise<Buffer> {
    this.#key ??= (async () => {
      await this.#directory(); const file = path.join(this.#root, '.semantic-runner-v10-diagnostic-authority');
      try { const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error('Invalid diagnostic authority');
      return readFile(file);
    })(); return this.#key;
  }
  async write(value: SemanticRunnerDiagnosticV10): Promise<void> {
    const data = SemanticRunnerDiagnosticV10Schema.parse(value), directory = await this.#directory();
    const authentication = createHmac('sha256', await this.#authority()).update(JSON.stringify(data)).digest('hex');
    const file = path.join(directory, `${data.executionRunId}.json`);
    const pending = path.join(directory, `.pending-${randomUUID()}`);
    const handle = await open(pending, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ data, authentication })); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(pending, file); } finally { await unlink(pending).catch(() => {}); }
    const names = (await readdir(directory)).filter(name => /^semantic-run-[A-Za-z0-9_-]+\.json$/.test(name));
    if (names.length > 64) {
      const ordered = await Promise.all(names.map(async name => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
      ordered.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
      for (const item of ordered.slice(0, ordered.length - 64)) { const target = path.join(directory, item.name);
        const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostic file');
        await unlink(target); }
    }
  }
  async readByRunId(executionRunId: string): Promise<SemanticRunnerDiagnosticV10> {
    const file = path.join(await this.#directory(), `${id.parse(executionRunId)}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('Invalid diagnostic file');
    const value = envelope.parse(JSON.parse((await readFile(file)).toString('utf8')));
    const expected = createHmac('sha256', await this.#authority()).update(JSON.stringify(value.data)).digest();
    if (!timingSafeEqual(expected, Buffer.from(value.authentication, 'hex')))
      throw new Error('INVALID_SEMANTIC_RUNNER_DIAGNOSTIC_AUTHENTICATION');
    if (value.data.executionRunId !== executionRunId) throw new Error('RUN_CORRELATION_MISMATCH');
    return value.data;
  }
}
