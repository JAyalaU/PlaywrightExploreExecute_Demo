import { readFile, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import { LocalWorkflowOutcomeSchema, parseTrustedLocalConfiguration, parseActivePocTrustedConfiguration,
  type LocalWorkflowTrustedDependencies } from '../local/contracts.js';
import { LocalWorkflowError, runLocalWorkflow } from '../local/workflow.js';
import type { ResultRecord } from '../domain/schema.js';
import type { LiveEventProducer } from '../observability/live-events.js';
import type { ImageChannel } from '../observability/image-channel.js';
import type { ViewerLifecycle } from '../observability/viewer-channel.js';
import {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, SUBPROCESS_PROTOCOL_VERSION,
  SubprocessProtocolError, SubprocessResponseSchema, expectedSubprocessExit,
  parseSubprocessRequest, safeTerminalReason,
  type SubprocessResponse,
} from './protocol.js';

const MAX_CONFIG_BYTES = 1_048_576;
type Workflow = typeof runLocalWorkflow;

export interface SubprocessAdapterOptions {
  signal?: AbortSignal;
  /** Trusted P4-1A producer seam; P4-1B owns its private transport. */
  events?: LiveEventProducer;
  images?: ImageChannel;
  viewer?: ViewerLifecycle;
  /** Trusted test composition seam. The production entry never supplies this option. */
  workflow?: Workflow;
}

export async function readSubprocessRequest(input: Readable, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = (): void => { input.destroy(new Error('CANCELLED')); };
  if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of input) {
      if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
      length += bytes.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        input.destroy();
        throw new SubprocessProtocolError('REQUEST_TOO_LARGE');
      }
      chunks.push(bytes);
    }
    if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** The path is launch-side trusted input; task JSON never contains it. */
export async function readSubprocessTrustedConfiguration(file: string,
  mode: 'historical' | 'active-poc' = 'historical'): Promise<unknown> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new Error('Invalid configuration');
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error('Configuration too large');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const input = JSON.parse(decoded) as unknown;
    return mode === 'active-poc'
      ? parseActivePocTrustedConfiguration(input)
      : parseTrustedLocalConfiguration(input);
  } catch {
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  }
}

function terminal(record: ResultRecord): { phase: ResultRecord['phase'];
  status: ResultRecord['status']; reason?: ReturnType<typeof safeTerminalReason> } {
  const reason = safeTerminalReason(record.reason);
  return { phase: record.phase, status: record.status, ...(reason ? { reason } : {}) };
}

function projectOutcome(input: unknown): SubprocessResponse {
  const outcome = LocalWorkflowOutcomeSchema.parse(input);
  const progress = outcome.handoff.kind === 'executed'
    ? { stage: 'replayed' as const, explorationAttemptId: outcome.handoff.attemptId,
        resolvedSpecId: outcome.handoff.resolvedSpecId,
        executionRunIds: [outcome.handoff.replay[0].executionRunId,
          outcome.handoff.replay[1].executionRunId] as [string, string] }
    : outcome.handoff.attemptId
      ? { stage: 'exploration' as const, explorationAttemptId: outcome.handoff.attemptId }
      : { stage: 'not_started' as const };
  const context = {
    testSpecId: outcome.testSpecId,
    executionProfileRef: outcome.executionProfileRef,
    profileFingerprint: outcome.profileFingerprint,
    presentationMode: outcome.presentationMode,
    observation: outcome.observation,
    progress,
    report: outcome.report.kind === 'available'
      ? { kind: 'available' as const, testSpecId: outcome.report.testSpecId }
      : { kind: 'unavailable' as const },
  };
  if (outcome.handoff.kind === 'stopped') {
    return SubprocessResponseSchema.parse({
      protocolVersion: SUBPROCESS_PROTOCOL_VERSION, kind: 'typed_stop',
      stopKind: outcome.handoff.result.status === 'QA_ASSERTION_FAILED'
        ? 'qa_failure' : 'automation_stop',
      context, terminal: terminal(outcome.handoff.result),
    });
  }
  const all = outcome.handoff.replay.flatMap((run) => run.outcomes);
  const automation = all.find((record) => ![
    'OPERATION_SUCCEEDED', 'QA_ASSERTION_PASSED', 'QA_ASSERTION_FAILED', 'NOT_RUN',
  ].includes(record.status));
  const qa = all.find((record) => record.status === 'QA_ASSERTION_FAILED');
  const selected = automation ?? qa ?? all.at(-1);
  if (!selected || selected.status === 'NOT_RUN' ||
      (selected.status !== 'OPERATION_SUCCEEDED' && selected.status !== 'QA_ASSERTION_PASSED'
        && !automation && !qa)) throw new LocalWorkflowError('REPORT_INVALID');
  return SubprocessResponseSchema.parse({
    protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
    kind: automation || qa ? 'typed_stop' : 'success',
    ...(automation || qa ? { stopKind: automation ? 'automation_stop' : 'qa_failure' } : {}),
    context, terminal: terminal(selected),
  });
}

function bridgeError(error: unknown, cleanup: 'not_started' | 'unverified'): SubprocessResponse {
  const code = error instanceof SubprocessProtocolError
    ? error.code === 'PROTOCOL_UNSUPPORTED_VERSION' ? error.code
      : error.code === 'REQUEST_TOO_LARGE' ? error.code : 'PROTOCOL_INVALID'
    : error instanceof LocalWorkflowError ? error.code : 'WORKFLOW_FAILED';
  return SubprocessResponseSchema.parse({
    protocolVersion: SUBPROCESS_PROTOCOL_VERSION, kind: 'bridge_error', code, cleanup,
  });
}

/** One request and one safe result. The dependency seam is callable only by trusted code. */
export async function runSubprocessAdapter(
  input: Readable, loadConfiguration: () => Promise<unknown>,
  dependencies: LocalWorkflowTrustedDependencies,
  options: SubprocessAdapterOptions = {},
): Promise<SubprocessResponse> {
  let started = false;
  const final = (response: SubprocessResponse): SubprocessResponse => {
    options.events?.finish(response);
    return response;
  };
  try {
    const request = parseSubprocessRequest(await readSubprocessRequest(input, options.signal));
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    const config = parseTrustedLocalConfiguration(await loadConfiguration());
    options.images?.policy(config.liveImagePolicy);
    options.viewer?.policy(config.liveViewerPolicy);
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    started = true;
    const outcome = await (options.workflow ?? runLocalWorkflow)(request.request, config, dependencies,
      { ...(options.signal ? { signal: options.signal } : {}),
        ...(options.events ? { events: options.events } : {}),
        ...(options.images ? { liveImageSink: options.images.sink } : {}),
        ...(options.viewer ? { viewer: options.viewer } : {}) });
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    if (outcome.executionProfileRef.id !== request.request.executionProfileRef.id ||
        outcome.executionProfileRef.version !== request.request.executionProfileRef.version) {
      throw new LocalWorkflowError('REPORT_INVALID');
    }
    return final(projectOutcome(outcome));
  } catch (error) {
    const failure = options.signal?.aborted ? new LocalWorkflowError('CANCELLED') : error;
    // Destination approval runs before the workflow creates models, artifacts, or a browser.
    const cleanup = failure instanceof LocalWorkflowError && failure.code === 'DESTINATION_DENIED'
      ? 'not_started' : started ? 'unverified' : 'not_started';
    return final(bridgeError(failure, cleanup));
  }
}

/** Validates the final envelope and size before any byte is written to stdout. */
export function serializeSubprocessResponse(response: SubprocessResponse): { body: string; exitCode: number } {
  const validated = SubprocessResponseSchema.parse(response);
  const body = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new SubprocessProtocolError('RESPONSE_TOO_LARGE');
  }
  return { body, exitCode: expectedSubprocessExit(validated) };
}
