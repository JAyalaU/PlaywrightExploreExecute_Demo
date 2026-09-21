import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { ResultRecord } from '../domain/index.js';
import type { ProtectedBrowserSession, ProtectedContextFactory } from '../profile/index.js';
import { executeResolvedTestSpec, type ExecutionRun, type RunObserver, type RunnerOptions } from '../runner/index.js';
import { LocalArtifactStore } from './store.js';

export interface EvidenceCapturePolicy {
  finalScreenshot: boolean;
  failureScreenshot: boolean;
  failureTrace: boolean;
  failureVideo: boolean;
  /** Browser pixels/trace/video can contain secrets; operator approval is explicit. */
  sensitiveBinaryApproved: boolean;
}

const failed = (result: ResultRecord): boolean =>
  result.status !== 'OPERATION_SUCCEEDED' && result.status !== 'QA_ASSERTION_PASSED' && result.status !== 'NOT_RUN';

class RunCapture implements RunObserver {
  readonly videoDir?: string;
  readonly #store: LocalArtifactStore;
  readonly #testSpecId: string;
  readonly #runId: string;
  readonly #policy: EvidenceCapturePolicy;
  #session?: ProtectedBrowserSession;
  #counter = 0;

  constructor(store: LocalArtifactStore, testSpecId: string, runId: string, policy: EvidenceCapturePolicy, videoDir?: string) {
    this.#store = store; this.#testSpecId = testSpecId; this.#runId = runId; this.#policy = policy;
    if (videoDir) this.videoDir = videoDir;
  }

  async onStart(session: ProtectedBrowserSession): Promise<void> {
    this.#session = session;
    if (this.#policy.failureTrace) await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  async #record(result: ResultRecord | undefined, mediaType: 'application/json' | 'image/png' | 'application/zip' | 'video/webm', content: unknown): Promise<string> {
    const descriptor = await this.#store.writeEvidence(this.#testSpecId, {
      evidenceId: `capture-${++this.#counter}`, owner: { kind: 'run', id: this.#runId }, mediaType, content,
      ...(result?.originStepId ? { originStepId: result.originStepId } : {}),
      ...(result?.executionStepId ? { executionStepId: result.executionStepId } : {}),
      ...(result?.locatorId ? { locatorId: result.locatorId } : {}),
      allowSensitiveBinary: this.#policy.sensitiveBinaryApproved,
    });
    return descriptor.ref;
  }

  async onStep(page: Page, result: ResultRecord): Promise<readonly string[]> {
    const refs = [await this.#record(result, 'application/json', {
      executionRunId: this.#runId, executionStepId: result.executionStepId,
      status: result.status, reason: result.reason, url: page.url(), at: result.finishedAt,
    })];
    if (failed(result) && this.#policy.failureScreenshot && !page.isClosed()) {
      refs.push(await this.#record(result, 'image/png', await page.screenshot()));
    }
    return refs;
  }

  async onFinish(page: Page, outcomes: readonly ResultRecord[]): Promise<readonly string[]> {
    const refs: string[] = [];
    const last = [...outcomes].reverse().find((item) => item.status !== 'NOT_RUN');
    const hasFailure = outcomes.some(failed);
    if (this.#policy.finalScreenshot && !page.isClosed()) {
      refs.push(await this.#record(last, 'image/png', await page.screenshot()));
    }
    if (this.#policy.failureTrace) {
      if (hasFailure) {
        const dir = await mkdtemp(path.join(tmpdir(), 'qa-trace-'));
        try {
          const file = path.join(dir, 'trace.zip');
          await this.#session!.context.tracing.stop({ path: file });
          refs.push(await this.#record(last, 'application/zip', await readFile(file)));
        } finally { await rm(dir, { recursive: true, force: true }); }
      } else await this.#session!.context.tracing.stop();
    }
    if (this.#policy.failureVideo && page.video()) {
      await page.close();
      if (hasFailure) {
        const dir = await mkdtemp(path.join(tmpdir(), 'qa-video-'));
        try {
          const file = path.join(dir, 'failure.webm');
          await page.video()!.saveAs(file);
          refs.push(await this.#record(last, 'video/webm', await readFile(file)));
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
    }
    return refs;
  }
}

/** Capture is opt-in. The fixed runner still owns step semantics and the protected context. */
export async function executeAndStoreRun(
  factory: ProtectedContextFactory, store: LocalArtifactStore, testSpecId: string,
  resolvedSpecId: string, runId: string, policy: EvidenceCapturePolicy,
  options: Pick<RunnerOptions, 'dataValues' | 'expectedProfile'> = {},
): Promise<ExecutionRun> {
  const { source } = await store.readJob(testSpecId);
  const resolved = await store.readResolved(testSpecId, resolvedSpecId);
  if (!policy.sensitiveBinaryApproved &&
    (policy.finalScreenshot || policy.failureScreenshot || policy.failureTrace || policy.failureVideo)) {
    throw new Error('Browser binary capture requires sensitive-capture approval');
  }
  const videoDir = policy.failureVideo ? await mkdtemp(path.join(tmpdir(), 'qa-recording-')) : undefined;
  try {
    const observer = new RunCapture(store, testSpecId, runId, policy, videoDir);
    const run = await executeResolvedTestSpec(factory, source, resolved, {
      ...options, executionRunId: runId, observer,
    });
    await store.writeRun(testSpecId, resolvedSpecId, run);
    return run;
  } finally {
    if (videoDir) await rm(videoDir, { recursive: true, force: true });
  }
}
