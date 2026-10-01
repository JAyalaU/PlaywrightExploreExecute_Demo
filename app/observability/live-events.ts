import { z } from 'zod';
import { ExecutionProfileRefSchema, ResultStatusSchema } from '../domain/schema.js';
import { BridgeErrorCodeSchema, SafeTerminalReasonSchema, safeTerminalReason,
  type SubprocessResponse } from '../subprocess/protocol.js';

export const EVENT_STREAM_VERSION = '1' as const;
export const MAX_EVENT_FRAME_BYTES = 2_048;
export const MAX_EVENT_FRAMES = 256;
export const MAX_EVENT_STREAM_BYTES = 256 * 1024;
const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const profile = ExecutionProfileRefSchema.refine((value) => value.id.length <= 128 && value.version.length <= 64);
const context = z.strictObject({
  testSpecId: id, executionProfileRef: profile, profileFingerprint: fingerprint,
  explorationAttemptId: id.optional(), resolvedSpecId: id.optional(), executionRunId: id.optional(),
  originStepId: id.optional(), executionStepId: id.optional(), locatorId: id.optional(), mcpCallId: id.optional(),
});
export type LiveEventContext = z.infer<typeof context>;
const workflowContext = context.pick({ testSpecId: true, executionProfileRef: true, profileFingerprint: true });
const empty = z.strictObject({});
export const McpToolNameSchema = z.enum([
  'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_generate_locator',
  'browser_click', 'browser_fill_form', 'browser_select_option', 'browser_wait_for',
]);
export const LocatorQualityReasonSchema = z.enum([
  'UNSUPPORTED_GRAMMAR', 'WEAK_IDENTITY', 'TEST_ID_PROVENANCE_UNVERIFIED',
  'NON_UNIQUE_MATCH', 'TARGET_MISMATCH',
]);
const locatorReasons = z.array(LocatorQualityReasonSchema).max(5).refine(
  (values) => new Set(values).size === values.length, 'Reasons must be distinct');
const terminal = z.union([
  z.strictObject({ resultKind: z.literal('success'), phase: z.enum(['interpretation', 'exploration', 'locator', 'execution']),
    status: ResultStatusSchema, reason: SafeTerminalReasonSchema.optional() }),
  z.strictObject({ resultKind: z.literal('typed_stop'), stopKind: z.enum(['qa_failure', 'automation_stop']),
    phase: z.enum(['interpretation', 'exploration', 'locator', 'execution']), status: ResultStatusSchema,
    reason: SafeTerminalReasonSchema.optional() }),
  z.strictObject({ resultKind: z.literal('bridge_error'), code: BridgeErrorCodeSchema,
    cleanup: z.enum(['not_started', 'verified', 'unverified']) }),
]);
const variants = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workflow_started'), context, data: empty }),
  z.strictObject({ kind: z.literal('interpretation_started'), context, data: empty }),
  z.strictObject({ kind: z.literal('interpretation_finished'), context, data: z.strictObject({ outcome: z.enum(['accepted', 'stopped']) }) }),
  z.strictObject({ kind: z.literal('exploration_started'), context, data: empty }),
  z.strictObject({ kind: z.literal('step_decision_started'), context, data: empty }),
  z.strictObject({ kind: z.literal('step_decision_finished'), context, data: empty }),
  z.strictObject({ kind: z.literal('mcp_tool_started'), context, data: z.strictObject({ tool: McpToolNameSchema }) }),
  z.strictObject({ kind: z.literal('mcp_tool_finished'), context, data: z.strictObject({ tool: McpToolNameSchema, outcome: z.enum(['completed', 'failed']) }) }),
  z.strictObject({ kind: z.literal('locator_assessed'), context, data: z.strictObject({ outcome: z.enum(['accepted', 'rejected']),
    basis: z.enum(['mcp_generated', 'semantic_row_scope']), reasons: locatorReasons }) }),
  z.strictObject({ kind: z.literal('resolved_spec_ready'), context, data: empty }),
  z.strictObject({ kind: z.literal('replay_started'), context, data: z.strictObject({ ordinal: z.union([z.literal(1), z.literal(2)]) }) }),
  z.strictObject({ kind: z.literal('replay_finished'), context, data: z.strictObject({ ordinal: z.union([z.literal(1), z.literal(2)]), status: ResultStatusSchema }) }),
  z.strictObject({ kind: z.literal('report_completed'), context, data: z.strictObject({ availability: z.enum(['available', 'unavailable']) }) }),
  z.strictObject({ kind: z.literal('stream_truncated'), context, data: z.strictObject({ cause: z.enum(['event_limit', 'byte_limit']) }) }),
  z.strictObject({ kind: z.literal('terminal'), context: context.nullable(), data: terminal }),
]);
const eventEnvelope = z.intersection(z.strictObject({
  eventStreamVersion: z.literal(EVENT_STREAM_VERSION), streamId: z.string().uuid(),
  sequence: z.number().int().min(1).max(MAX_EVENT_FRAMES),
  occurredAt: z.string().datetime({ offset: true }),
}), variants);
const scopedIdFields = [
  'explorationAttemptId', 'resolvedSpecId', 'executionRunId', 'originStepId',
  'executionStepId', 'locatorId', 'mcpCallId',
] as const;
type ScopedId = typeof scopedIdFields[number];
const scopes: Record<LiveEventFact['kind'], { required: readonly ScopedId[]; allowed: readonly ScopedId[] }> = {
  workflow_started: { required: [], allowed: [] },
  interpretation_started: { required: [], allowed: [] },
  interpretation_finished: { required: [], allowed: [] },
  exploration_started: { required: ['explorationAttemptId'], allowed: ['explorationAttemptId'] },
  step_decision_started: { required: ['explorationAttemptId', 'originStepId'], allowed: ['explorationAttemptId', 'originStepId'] },
  step_decision_finished: { required: ['explorationAttemptId', 'originStepId'], allowed: ['explorationAttemptId', 'originStepId'] },
  mcp_tool_started: { required: ['explorationAttemptId', 'mcpCallId'], allowed: ['explorationAttemptId', 'mcpCallId'] },
  mcp_tool_finished: { required: ['explorationAttemptId', 'mcpCallId'], allowed: ['explorationAttemptId', 'mcpCallId'] },
  locator_assessed: { required: ['explorationAttemptId', 'originStepId', 'executionStepId', 'locatorId'],
    allowed: ['explorationAttemptId', 'originStepId', 'executionStepId', 'locatorId'] },
  resolved_spec_ready: { required: ['explorationAttemptId', 'resolvedSpecId'], allowed: ['explorationAttemptId', 'resolvedSpecId'] },
  replay_started: { required: ['explorationAttemptId', 'resolvedSpecId', 'executionRunId'],
    allowed: ['explorationAttemptId', 'resolvedSpecId', 'executionRunId'] },
  replay_finished: { required: ['explorationAttemptId', 'resolvedSpecId', 'executionRunId'],
    allowed: ['explorationAttemptId', 'resolvedSpecId', 'executionRunId'] },
  report_completed: { required: [], allowed: ['explorationAttemptId', 'resolvedSpecId'] },
  stream_truncated: { required: [], allowed: [] },
  terminal: { required: [], allowed: ['explorationAttemptId', 'resolvedSpecId'] },
};
export const LiveEventSchema = eventEnvelope.superRefine((event, issue) => {
  if (event.kind === 'terminal' && event.data.resultKind === 'bridge_error') {
    if (event.context !== null) issue.addIssue({ code: 'custom', path: ['context'], message: 'Bridge terminal has no context' });
    return;
  }
  if (event.context === null) {
    issue.addIssue({ code: 'custom', path: ['context'], message: 'Workflow event requires context' });
    return;
  }
  const scope = scopes[event.kind];
  for (const field of scopedIdFields) {
    if (scope.required.includes(field) && !event.context[field]) {
      issue.addIssue({ code: 'custom', path: ['context', field], message: 'Required event correlation missing' });
    } else if (!scope.allowed.includes(field) && event.context[field] !== undefined) {
      issue.addIssue({ code: 'custom', path: ['context', field], message: 'Unrelated event correlation present' });
    }
  }
  if (event.kind === 'terminal' && event.data.resultKind !== 'bridge_error' &&
      event.context === null) issue.addIssue({ code: 'custom', path: ['context'], message: 'Engine terminal requires context' });
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export type LiveEventFact = z.infer<typeof variants>;
export type LiveEventSink = (event: LiveEvent) => void | Promise<void>;
type OperationalKind = Exclude<LiveEventFact['kind'], 'terminal' | 'stream_truncated'>;

/** Synchronous, bounded, best-effort producer. A sink may only enqueue; it cannot affect QA. */
export class LiveEventProducer {
  readonly #streamId: string;
  readonly #sink: LiveEventSink;
  #context: LiveEventContext | undefined;
  #sequence = 0;
  #bytes = 0;
  #closed = false;
  #truncated = false;
  #originStepsRegistered = false;
  readonly #originStepIds = new Map<string, string>();

  constructor(streamId: string, sink: LiveEventSink) {
    this.#streamId = z.string().uuid().parse(streamId);
    this.#sink = sink;
  }

  get context(): LiveEventContext | undefined { return this.#context; }
  get sequence(): number { return this.#sequence; }
  get streamId(): string { return this.#streamId; }

  begin(contextInput: z.infer<typeof workflowContext>): void {
    if (this.#context) return;
    const parsed = workflowContext.safeParse(contextInput);
    if (!parsed.success) { this.#closed = true; return; }
    this.#context = parsed.data;
    this.emit('workflow_started', {}, {});
  }

  /** Bind validated authored steps to event-only IDs; model-authored IDs never cross the event channel. */
  registerOriginSteps(steps: readonly { id: string }[]): void {
    if (this.#closed || !this.#context || this.#originStepsRegistered) return;
    this.#originStepsRegistered = true;
    const rawIds = steps.map((step) => step.id);
    if (!rawIds.length || rawIds.some((value) => typeof value !== 'string') ||
        new Set(rawIds).size !== rawIds.length) return;
    const authoredIds = new Set(rawIds);
    for (const [index, rawId] of rawIds.entries()) {
      let eventId = `event_step_${index + 1}`;
      for (let suffix = 1; authoredIds.has(eventId); suffix++) eventId = `event_step_${index + 1}_${suffix}`;
      this.#originStepIds.set(rawId, eventId);
    }
  }

  emit<K extends OperationalKind>(kind: K,
    data: Extract<LiveEventFact, { kind: K }>['data'],
    additions: Partial<LiveEventContext> = {}): void {
    if (this.#closed || !this.#context) return;
    if (this.#truncated || this.#sequence >= 254 || this.#bytes >= MAX_EVENT_STREAM_BYTES - 4096) {
      this.#truncate(this.#sequence >= 254 ? 'event_limit' : 'byte_limit');
      return;
    }
    const originStepId = additions.originStepId === undefined ? undefined
      : this.#originStepIds.get(additions.originStepId);
    if (additions.originStepId !== undefined && originStepId === undefined) return;
    const fact = variants.safeParse({ kind, context: { ...this.#context, ...additions,
      ...(originStepId === undefined ? {} : { originStepId }) }, data });
    if (!fact.success) return;
    if (!this.#send(fact.data, MAX_EVENT_STREAM_BYTES - 4096)) this.#truncate('byte_limit');
  }

  /** Final-result preview is emitted only from the already validated v1 response. */
  finish(response: SubprocessResponse): void {
    if (this.#closed) return;
    const data = response.kind === 'bridge_error'
      ? { resultKind: 'bridge_error' as const, code: response.code, cleanup: response.cleanup }
      : { resultKind: response.kind, ...(response.kind === 'typed_stop' ? { stopKind: response.stopKind } : {}),
          phase: response.terminal.phase, status: response.terminal.status,
          ...(response.terminal.reason ? { reason: safeTerminalReason(response.terminal.reason) } : {}) };
    const terminalContext = response.kind === 'bridge_error' ? null : {
      testSpecId: response.context.testSpecId,
      executionProfileRef: response.context.executionProfileRef,
      profileFingerprint: response.context.profileFingerprint,
      ...(response.context.progress.stage !== 'not_started' ? {
        explorationAttemptId: response.context.progress.explorationAttemptId } : {}),
      ...(response.context.progress.stage === 'replayed' ? {
        resolvedSpecId: response.context.progress.resolvedSpecId } : {}),
    };
    const fact = variants.safeParse({ kind: 'terminal', context: terminalContext, data });
    if (fact.success) this.#send(fact.data, MAX_EVENT_STREAM_BYTES);
    this.#closed = true;
  }

  #truncate(cause: 'event_limit' | 'byte_limit'): void {
    if (this.#truncated || !this.#context) return;
    this.#truncated = true;
    this.#send(variants.parse({ kind: 'stream_truncated', context: this.#context, data: { cause } }), MAX_EVENT_STREAM_BYTES - 2048);
  }

  #send(fact: LiveEventFact, limit: number): boolean {
    const parsed = LiveEventSchema.safeParse({ ...fact, eventStreamVersion: EVENT_STREAM_VERSION,
      streamId: this.#streamId, sequence: this.#sequence + 1, occurredAt: new Date().toISOString() });
    if (!parsed.success) return false;
    const event = parsed.data;
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (size > MAX_EVENT_FRAME_BYTES || this.#bytes + size > limit || this.#sequence >= MAX_EVENT_FRAMES) return false;
    this.#sequence++;
    this.#bytes += size;
    try {
      const delivered = this.#sink(event);
      // A caller that accidentally returns a promise cannot crash the workflow later.
      if (delivered && typeof delivered.then === 'function') void delivered.catch(() => { this.#closed = true; });
    } catch { this.#closed = true; }
    return true;
  }
}
