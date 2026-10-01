import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  LiveEventProducer, LiveEventSchema, MAX_EVENT_FRAME_BYTES, MAX_EVENT_STREAM_BYTES,
  type LiveEvent,
} from '../app/observability/live-events.js';

const context = {
  testSpecId: 'local-123', executionProfileRef: { id: 'approved-public', version: '1' },
  profileFingerprint: 'a'.repeat(64),
};

test('P4-1A producer emits closed, ordered facts and rejects injected event fields', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin(context);
  producer.registerOriginSteps([{ id: 'MODEL_AUTHORED_STEP_ID' }]);
  producer.emit('mcp_tool_started', { tool: 'browser_snapshot' },
    { explorationAttemptId: 'explore-1', mcpCallId: 'mcp-1' });
  producer.emit('mcp_tool_finished', { tool: 'browser_snapshot', outcome: 'completed' },
    { explorationAttemptId: 'explore-1', mcpCallId: 'mcp-1' });
  producer.emit('locator_assessed', { outcome: 'rejected', basis: 'mcp_generated',
    reasons: ['WEAK_IDENTITY'] }, {
    explorationAttemptId: 'explore-1', originStepId: 'MODEL_AUTHORED_STEP_ID', executionStepId: 'x1', locatorId: 'loc1',
  });
  producer.emit('mcp_tool_started', { tool: 'browser_snapshot', rawSnapshot: 'SECRET_PAGE' } as never);
  producer.emit('mcp_tool_started', { tool: 'arbitrary_tool' } as never);
  producer.finish({ protocolVersion: '1', kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'unverified' });
  expect(received.map((event) => event.kind)).toEqual([
    'workflow_started', 'mcp_tool_started', 'mcp_tool_finished', 'locator_assessed', 'terminal',
  ]);
  expect(received.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(received.every((event) => LiveEventSchema.safeParse(event).success)).toBe(true);
  expect(JSON.stringify(received)).not.toContain('SECRET_PAGE');
  expect(JSON.stringify(received)).not.toContain('MODEL_AUTHORED_STEP_ID');
  expect(received[3]?.context).toMatchObject({ originStepId: 'event_step_1' });
  expect(received.at(-1)).toMatchObject({ context: null,
    data: { resultKind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'unverified' } });
});

test('P4-1A event boundary denies unknown authored IDs and generates collision-free stable aliases', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin(context);
  producer.emit('step_decision_started', {}, { explorationAttemptId: 'explore-1', originStepId: 'VALID_BUT_UNREGISTERED' });
  producer.registerOriginSteps([{ id: 'event_step_1' }, { id: 'MODEL_SUPPLIED_SECOND' }]);
  producer.registerOriginSteps([{ id: 'VALID_BUT_UNREGISTERED' }]);
  for (const raw of ['event_step_1', 'MODEL_SUPPLIED_SECOND']) {
    producer.emit('step_decision_started', {}, { explorationAttemptId: 'explore-1', originStepId: raw });
    producer.emit('step_decision_finished', {}, { explorationAttemptId: 'explore-1', originStepId: raw });
  }
  producer.emit('locator_assessed', { outcome: 'rejected', basis: 'mcp_generated', reasons: ['WEAK_IDENTITY'] },
    { explorationAttemptId: 'explore-1', originStepId: 'VALID_BUT_UNREGISTERED', executionStepId: 'x1', locatorId: 'loc1' });
  expect(received.map((event) => event.kind)).toEqual([
    'workflow_started', 'step_decision_started', 'step_decision_finished',
    'step_decision_started', 'step_decision_finished',
  ]);
  expect(received.slice(1).map((event) => event.context?.originStepId)).toEqual([
    'event_step_1_1', 'event_step_1_1', 'event_step_2', 'event_step_2',
  ]);
  expect(JSON.stringify(received)).not.toContain('MODEL_SUPPLIED_SECOND');
});

test('P4-1A invalid step registration cannot be replaced with attacker-chosen IDs', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin(context);
  producer.registerOriginSteps([{ id: 'duplicate' }, { id: 'duplicate' }]);
  producer.registerOriginSteps([{ id: 'attacker' }]);
  producer.emit('step_decision_started', {}, { explorationAttemptId: 'explore-1', originStepId: 'attacker' });
  expect(received.map((event) => event.kind)).toEqual(['workflow_started']);
});

test('P4-1A begin rejects a supplied origin ID before any workflow event', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin({ ...context, originStepId: 'MODEL_AUTHORED_ID' } as never);
  producer.registerOriginSteps([{ id: 'MODEL_AUTHORED_ID' }]);
  producer.emit('step_decision_started', {}, { explorationAttemptId: 'explore-1', originStepId: 'MODEL_AUTHORED_ID' });
  expect(received).toEqual([]);
});

test('P4-1A producer reserves truncation and terminal frames without exceeding wire budgets', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin(context);
  for (let index = 0; index < 300; index++) producer.emit('interpretation_started', {});
  producer.finish({ protocolVersion: '1', kind: 'bridge_error', code: 'WORKFLOW_FAILED', cleanup: 'unverified' });
  expect(received).toHaveLength(256);
  expect(received.at(-2)).toMatchObject({ sequence: 255, kind: 'stream_truncated', data: { cause: 'event_limit' } });
  expect(received.at(-1)).toMatchObject({ sequence: 256, kind: 'terminal' });
  const sizes = received.map((event) => Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8'));
  expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_EVENT_FRAME_BYTES);
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(MAX_EVENT_STREAM_BYTES);
});

test('P4-1A observer failure cannot change the workflow result or throw from producer', () => {
  const producer = new LiveEventProducer(randomUUID(), () => { throw new Error('observer failed'); });
  expect(() => producer.begin(context)).not.toThrow();
  expect(() => producer.emit('interpretation_started', {})).not.toThrow();
  expect(() => producer.finish({ protocolVersion: '1', kind: 'bridge_error',
    code: 'WORKFLOW_FAILED', cleanup: 'not_started' })).not.toThrow();
});

test('P4-1A schema denies missing, unrelated, or unreviewed correlation and data', () => {
  const received: LiveEvent[] = [];
  const producer = new LiveEventProducer(randomUUID(), (event) => { received.push(event); });
  producer.begin(context);
  const base = received[0]!;
  expect(LiveEventSchema.safeParse({ ...base, kind: 'exploration_started' }).success).toBe(false);
  expect(LiveEventSchema.safeParse({ ...base,
    context: { ...base.context, mcpCallId: 'mcp-1' } }).success).toBe(false);
  expect(LiveEventSchema.safeParse({ ...base,
    data: { rawProviderOutput: 'do-not-display' } }).success).toBe(false);
  expect(LiveEventSchema.safeParse({ ...base, eventStreamVersion: '2' }).success).toBe(false);
});
