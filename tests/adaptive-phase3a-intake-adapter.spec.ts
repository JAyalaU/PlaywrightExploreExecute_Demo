import { expect, test } from '@playwright/test';
import { AgentProposalV1Schema, authoredDigest, type ObservationV1, type RequirementLedgerV1,
  type TaskEnvelopeV1 } from '../app/adaptive/contracts.js';
import { OpenAIAdaptiveReasoningModel } from '../app/adaptive/openai-reasoning.js';
import { validateRequirementIntake } from '../app/adaptive/requirement-acceptance.js';
import type { ReasoningContextV1, ReasoningModel, VerificationFeedbackV1 } from '../app/adaptive/interfaces.js';
import { adaptivePhase3aDiagnosticsEnabled, diagnosticReasoningModel,
  projectHeldoutDiagnostics } from
  './support/adaptive-phase3a-diagnostic-projection.js';

const instruction = 'Open Activity and verify the path is /activity.';
const task: TaskEnvelopeV1 = { version: '1', taskId: 'intake_adapter',
  authoredInstruction: instruction, authoredDigest: authoredDigest(instruction),
  startUrl: 'http://localhost:9000/', approvalRef: 'approved',
  operatorConstraints: { allowedOrigins: ['http://localhost:9000'], prohibitedEffects: [],
    confirmationRequiredEffects: [], allowedOperations: ['click'],
    budgets: { maxActions: 3, maxObservations: 5, maxScreenshots: 0 } } };
const observation: ObservationV1 = { version: '1', observationId: 'initial',
  sessionId: 'session', pageId: 'page', documentRevision: 'revision', coordinateFrameId: 'frame',
  url: task.startUrl, observedAt: '2026-10-07T00:00:00.000Z',
  viewport: { width: 800, height: 600, scale: 1 },
  accessibility: { snapshotRef: 'snapshot', summary: '- link "Activity"' },
  dom: { factsRef: 'facts', summary: 'Activity', complete: true,
    elements: [{ ref: 'e0', role: 'link', name: 'Activity', enabled: true }] } };
const phrases = ['Open Activity', 'verify the path is /activity'];
const ledger: RequirementLedgerV1 = { version: '1', taskId: task.taskId,
  authoredDigest: task.authoredDigest,
  authoredGoals: phrases.map((requirement, index) => ({ goalId: `g${index}`,
    kind: index === 0 ? 'required_action' : 'assertion', requirement,
    sourceSpan: { start: instruction.indexOf(requirement),
      end: instruction.indexOf(requirement) + requirement.length },
    interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })),
  inferredPrerequisites: [], unresolvedQuestions: [] };
const intake = { ledger, acceptancePlan: { version: '1', taskId: task.taskId,
  authoredDigest: task.authoredDigest, sourceObservationId: observation.observationId,
  goals: ledger.authoredGoals.map(goal => ({ goalId: goal.goalId, kind: goal.kind,
    sourceSpan: goal.sourceSpan, requirement: goal.requirement, status: 'hypothesis',
    predicates: [{ kind: 'url', comparison: 'path_equals', value: '/activity' }],
    ...(goal.kind === 'required_action' ? { action: { operation: 'click', afterGoalIds: [] } } : {}) })) } };
const context = (signal?: AbortSignal): Parameters<ReasoningModel['interpretRequirements']>[0] => ({
  original: { taskId: task.taskId, authoredInstruction: task.authoredInstruction,
    authoredDigest: task.authoredDigest, startUrl: task.startUrl },
  observation, remainingRefinements: 2, ...(signal ? { signal } : {}) });
const response = (output: unknown) => new Response(JSON.stringify({ id: 'mock_response', object: 'response',
  status: 'completed', model: 'mock-model', output: [{ id: 'mock_message', type: 'message',
    role: 'assistant', status: 'completed', content: [{ type: 'output_text',
      text: JSON.stringify(output), annotations: [] }] }] }),
{ status: 200, headers: { 'content-type': 'application/json' } });

async function providerIntake(candidate: unknown, sourceTask = task,
  sourceObservation = observation) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(candidate); };
  try {
    const model = new OpenAIAdaptiveReasoningModel('mock-secret', 'mock-model');
    const parsed = await model.interpretRequirements({
      original: { taskId: sourceTask.taskId,
        authoredInstruction: sourceTask.authoredInstruction,
        authoredDigest: sourceTask.authoredDigest, startUrl: sourceTask.startUrl },
      observation: sourceObservation, remainingRefinements: 2 });
    expect(calls).toBe(1);
    return validateRequirementIntake(sourceTask, sourceObservation, parsed, [sourceObservation]);
  } finally { globalThis.fetch = originalFetch; }
}

function securityIntake() {
  const authoredInstruction = 'Open Profile, then open Security, then enable Login alerts, and verify Login alerts are enabled.';
  const sourceTask: TaskEnvelopeV1 = { ...task, taskId: 'security_intake',
    authoredInstruction, authoredDigest: authoredDigest(authoredInstruction),
    operatorConstraints: { ...task.operatorConstraints, allowedOperations: ['click', 'check'] } };
  const sourceObservation: ObservationV1 = { ...observation,
    accessibility: { ...observation.accessibility, summary: '- button "Profile"' },
    dom: { ...observation.dom, summary: 'Profile menu is closed',
      elements: [{ ref: 'e0', role: 'button', name: 'Profile', enabled: true }] } };
  const clauses = ['Open Profile', 'then open Security', 'then enable Login alerts',
    'verify Login alerts are enabled'];
  const kinds = ['required_action', 'required_action', 'required_action', 'assertion'] as const;
  const securityLedger: RequirementLedgerV1 = { version: '1', taskId: sourceTask.taskId,
    authoredDigest: sourceTask.authoredDigest,
    authoredGoals: clauses.map((requirement, index) => ({ goalId: `s${index}`,
      kind: kinds[index]!, requirement,
      sourceSpan: { start: authoredInstruction.indexOf(requirement),
        end: authoredInstruction.indexOf(requirement) + requirement.length },
      interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })),
    inferredPrerequisites: [], unresolvedQuestions: [] };
  const predicates = [
    [{ kind: 'element' as const, role: 'link', name: 'Security',
      property: 'exists' as const, equals: true }],
    [{ kind: 'url' as const, comparison: 'path_equals' as const, value: '/security' }],
    [{ kind: 'element' as const, role: 'checkbox', name: 'Login alerts',
      property: 'checked' as const, equals: true }],
    [{ kind: 'element' as const, role: 'checkbox', name: 'Login alerts',
      property: 'checked' as const, equals: true }],
  ];
  const candidate = { ledger: securityLedger, acceptancePlan: { version: '1' as const,
    taskId: sourceTask.taskId, authoredDigest: sourceTask.authoredDigest,
    sourceObservationId: sourceObservation.observationId,
    goals: securityLedger.authoredGoals.map((goal, index) => ({ goalId: goal.goalId,
      kind: goal.kind, requirement: goal.requirement, sourceSpan: goal.sourceSpan,
      status: 'hypothesis' as const, predicates: predicates[index]!,
      ...(index < 3 ? { action: { operation: index === 2 ? 'check' as const : 'click' as const,
        afterGoalIds: index === 0 ? [] : [`s${index - 1}`] } } : {}) })) } };
  return { sourceTask, sourceObservation, candidate };
}

test('intake request and local parser share authoredGoals schema', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const wireIntake = structuredClone(intake) as Record<string, any>;
  for (const goal of wireIntake.acceptancePlan.goals) {
    if (!('action' in goal)) goal.action = null;
    goal.constraint = null;
  }
  const outputs = [wireIntake, { ...intake, ledger: { ...ledger, authoredGoals: undefined,
    goals: ledger.authoredGoals } }, { ...intake, ledger: { ...ledger, taskId: null } }];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response(outputs.shift());
  };
  try {
    const model = new OpenAIAdaptiveReasoningModel('mock-secret', 'mock-model');
    expect(await model.interpretRequirements(context())).toEqual(intake);
    await expect(model.interpretRequirements(context())).rejects.toThrow();
    await expect(model.interpretRequirements(context())).rejects.toThrow();
  } finally { globalThis.fetch = originalFetch; }
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    const format = (request.text as { format: { type: string; name: string;
      strict: boolean; schema: unknown } }).format;
    expect(format.type).toBe('json_schema');
    expect(format.name).toBe('adaptive_requirement_intake_v1');
    expect(format.strict).toBe(true);
    const schema = format.schema as { properties: { ledger: { properties: Record<string, unknown> },
      acceptancePlan: { properties: { goals: { items: { required: string[];
        properties: Record<string, unknown> } } } } } };
    expect(Object.keys(schema.properties.ledger.properties)).toContain('authoredGoals');
    expect(Object.keys(schema.properties.ledger.properties)).not.toContain('goals');
    expect(schema.properties.acceptancePlan.properties.goals.items.required).toContain('action');
    expect(schema.properties.acceptancePlan.properties.goals.items.required).toContain('constraint');
    expect(schema.properties.acceptancePlan.properties.goals.items.properties.action)
      .toMatchObject({ anyOf: expect.arrayContaining([{ type: 'null' }]) });
    const inspect = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(inspect); return; }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      for (const unsupported of ['allOf', 'not', 'dependentRequired', 'dependentSchemas',
        'if', 'then', 'else', 'minLength', 'maxLength', 'pattern', 'format', 'minimum',
        'maximum', 'minItems', 'maxItems']) expect(record).not.toHaveProperty(unsupported);
      if (record.type === 'object') {
        expect(record.additionalProperties).toBe(false);
        expect(record.required).toEqual(Object.keys(record.properties as Record<string, unknown>));
      }
      Object.values(record).forEach(inspect);
    };
    inspect(format.schema);
    expect(String(request.instructions)).toContain('ledger\'s goal array key is exactly authoredGoals');
    expect(request.store).toBe(false);
  }
});

test('mocked provider Activity and Security intakes preserve authored spans and action order', async () => {
  const activity = await providerIntake(intake);
  expect(activity.ledger.authoredGoals.map(goal =>
    task.authoredInstruction.slice(goal.sourceSpan.start, goal.sourceSpan.end)))
    .toEqual(phrases);
  expect(activity.acceptancePlan.goals.map(goal => goal.kind))
    .toEqual(['required_action', 'assertion']);

  const { sourceTask, sourceObservation, candidate } = securityIntake();
  const security = await providerIntake(candidate, sourceTask, sourceObservation);
  expect(security.ledger.authoredGoals.map(goal =>
    sourceTask.authoredInstruction.slice(goal.sourceSpan.start, goal.sourceSpan.end)))
    .toEqual(candidate.ledger.authoredGoals.map(goal => goal.requirement));
  expect(security.acceptancePlan.goals.map(goal => goal.action?.afterGoalIds))
    .toEqual([[], ['s0'], ['s1'], undefined]);
  expect(security.acceptancePlan.goals.map(goal => goal.action?.operation))
    .toEqual(['click', 'click', 'check', undefined]);
});

test('mocked provider intake rejects omitted, invented, misclassified, and unsupported obligations', async () => {
  const { sourceTask, sourceObservation, candidate } = securityIntake();
  const omitted = structuredClone(candidate);
  omitted.ledger.authoredGoals.pop();
  omitted.acceptancePlan.goals.pop();
  await expect(providerIntake(omitted, sourceTask, sourceObservation))
    .rejects.toThrow('REQUIREMENT_INTAKE_INVALID');

  const invented = structuredClone(candidate);
  invented.ledger.authoredGoals.push({ ...invented.ledger.authoredGoals[0]!, goalId: 'invented' });
  invented.acceptancePlan.goals.push({ ...invented.acceptancePlan.goals[0]!, goalId: 'invented' });
  await expect(providerIntake(invented, sourceTask, sourceObservation))
    .rejects.toThrow('REQUIREMENT_INTAKE_INVALID');

  const wrongSpan = structuredClone(candidate);
  wrongSpan.ledger.authoredGoals[0]!.sourceSpan.end--;
  wrongSpan.acceptancePlan.goals[0]!.sourceSpan.end--;
  await expect(providerIntake(wrongSpan, sourceTask, sourceObservation))
    .rejects.toThrow('INVALID_REQUIREMENT_LEDGER');

  const wrongOrder = structuredClone(candidate);
  wrongOrder.acceptancePlan.goals[1]!.action!.afterGoalIds = [];
  await expect(providerIntake(wrongOrder, sourceTask, sourceObservation))
    .rejects.toThrow('REQUIREMENT_INTAKE_INVALID');

  const unsupported = structuredClone(candidate) as Record<string, any>;
  unsupported.acceptancePlan.goals[0].predicates = [{ kind: 'script', value: 'true' }];
  await expect(providerIntake(unsupported, sourceTask, sourceObservation)).rejects.toThrow();

  const malformedPath = structuredClone(candidate);
  malformedPath.acceptancePlan.goals[1]!.predicates = [
    { kind: 'url', comparison: 'path_equals', value: 'security' }];
  await expect(providerIntake(malformedPath, sourceTask, sourceObservation))
    .rejects.toThrow('ACCEPTANCE_PREDICATE_INVALID');

  const prohibitedInstruction = 'Open Activity, and do not click Delete account.';
  const prohibitedTask: TaskEnvelopeV1 = { ...task,
    authoredInstruction: prohibitedInstruction,
    authoredDigest: authoredDigest(prohibitedInstruction) };
  const clauses = ['Open Activity', 'do not click Delete account'];
  const prohibitedLedger: RequirementLedgerV1 = { ...ledger,
    authoredDigest: prohibitedTask.authoredDigest,
    authoredGoals: clauses.map((requirement, index) => ({ goalId: `p${index}`,
      kind: index === 0 ? 'required_action' : 'outcome', requirement,
      sourceSpan: { start: prohibitedInstruction.indexOf(requirement),
        end: prohibitedInstruction.indexOf(requirement) + requirement.length },
      interpretationStatus: 'literal', fulfillment: 'pending', evidenceRefs: [] })) };
  const misclassified = { ledger: prohibitedLedger, acceptancePlan: {
    version: '1', taskId: prohibitedTask.taskId,
    authoredDigest: prohibitedTask.authoredDigest,
    sourceObservationId: observation.observationId,
    goals: prohibitedLedger.authoredGoals.map((goal, index) => ({
      goalId: goal.goalId, kind: goal.kind, sourceSpan: goal.sourceSpan,
      requirement: goal.requirement, status: 'hypothesis',
      predicates: index === 0
        ? [{ kind: 'url', comparison: 'path_equals', value: '/activity' }]
        : [{ kind: 'element', role: 'button', name: 'Delete account',
          property: 'exists', equals: true }],
      ...(index === 0 ? { action: { operation: 'click', afterGoalIds: [] } } : {}) })) } };
  await expect(providerIntake(misclassified, prohibitedTask, observation))
    .rejects.toThrow('REQUIREMENT_INTAKE_INVALID');
});

test('provider response after virtual 20 seconds succeeds inside the trusted 45-second timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let virtualNow = 0, calls = 0, aborted = false;
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  const timers = new Map<object, { due: number; callback: () => void }>();
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number,
    ...args: any[]) => {
    if ((delay ?? 0) < 20_000) return originalSetTimeout(callback, delay, ...args);
    const handle = {};
    timers.set(handle, { due: virtualNow + delay!, callback: () => callback(...args) });
    return handle as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: NodeJS.Timeout) => {
    if (!timers.delete(handle)) originalClearTimeout(handle);
  }) as typeof clearTimeout;
  globalThis.fetch = async (_url, init) => {
    calls++;
    fetchStarted();
    init?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise<Response>(resolve => {
      setTimeout(() => resolve(response(intake)), 20_001);
    });
  };
  try {
    const model = new OpenAIAdaptiveReasoningModel('mock-secret', 'mock-model');
    const pending = model.interpretRequirements(context());
    await started;
    expect([...timers.values()].map(timer => timer.due)).toEqual([45_000, 20_001]);
    virtualNow = 20_001;
    for (const [handle, timer] of [...timers]) {
      if (timer.due <= virtualNow) { timers.delete(handle); timer.callback(); }
    }
    const parsed = await pending;
    expect(validateRequirementIntake(task, observation, parsed, [observation]).ledger)
      .toEqual(ledger);
    expect(calls).toBe(1);
    expect(aborted).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('per-request timeout aborts one provider call and has its own stop reason', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0, aborted = false;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true; reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  };
  try {
    const model = new OpenAIAdaptiveReasoningModel('mock-secret', 'mock-model', 30);
    await expect(model.interpretRequirements(context())).rejects.toThrow('MODEL_REQUEST_TIMEOUT');
  } finally { globalThis.fetch = originalFetch; }
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
});

test('external cancellation propagates to provider and differs from timeout', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0, aborted = false;
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true; reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  };
  try {
    const model = new OpenAIAdaptiveReasoningModel('mock-secret', 'mock-model', 5_000);
    await expect(model.interpretRequirements(context(controller.signal)))
      .rejects.toThrow('MODEL_REQUEST_ABORTED');
  } finally { globalThis.fetch = originalFetch; }
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
});

test('opt-in diagnostic separates proposal schema rejection from intake and records feedback delivery', async () => {
  const validated = validateRequirementIntake(task, observation, intake, [observation]);
  const model: ReasoningModel = {
    async interpretRequirements() { return validated; },
    async propose() { return AgentProposalV1Schema.parse({ version: '1', proposalId: 'badproposal',
      kind: 'verify', observationId: observation.observationId, goalId: 'g1',
      predicate: { kind: 'url', comparison: 'path_equals', value: '/activity' } }); },
  };
  const diagnostic = diagnosticReasoningModel(model);
  await diagnostic.model.interpretRequirements(context());
  const feedback: VerificationFeedbackV1 = { proposalId: 'priorcheck', goalId: 'g1',
    observationId: 'aftercheck', predicateIdentity: 'url:hash', observedResult: 'false',
    matchesAcceptance: true, missingActionEvidence: true, missingOrderingEvidence: false,
    newEvidence: true, progressBefore: { coverage: 'verified_false', explicitlyVerified: false },
    progressAfter: { coverage: 'verified_false', explicitlyVerified: false }, reason: 'observed_false' };
  const proposalContext: ReasoningContextV1 = { original: context().original, ledger, observation,
    validatedHistory: [], unresolvedGoalIds: ['g1'], availableOperations: ['verify'],
    maxContextCharacters: 24_000, verificationFeedback: [feedback] };
  await expect(diagnostic.model.propose(proposalContext)).rejects.toThrow();
  const projection = projectHeldoutDiagnostics({ outcome: 'BLOCKED',
    stopReason: 'SECRET raw Zod provider text', calls: diagnostic.calls,
    diagnostics: { requirements: [{ goalId: 'g0', kind: 'required_action', status: 'grounded',
      predicates: [{ identity: 'url:hash', state: 'false' }] }],
    proposals: [], actions: [], verifications: [feedback],
    firstTerminalFailure: 'SECRET raw Zod provider text' } });
  expect(projection.terminalCategory).toBe('proposal_schema_rejected');
  expect(diagnostic.calls.map(call => [call.stage, call.outcome, call.feedbackCount]))
    .toEqual([['intake', 'returned', 0], ['proposal', 'schema_rejected', 1]]);
  expect(diagnostic.calls[1]?.feedbackProposalIds).toEqual(['priorcheck']);
  expect(diagnostic.calls[1]?.issues.length).toBeGreaterThan(0);
  expect(projection.requiredActionReceipts).toEqual([{ goalId: 'g0', actionRecorded: false }]);
  expect(JSON.stringify(projection)).not.toContain('SECRET');
  expect(projection.diagnostics?.verifications[0]?.reason).toBe('observed_false');
  expect(projection.diagnostics?.verifications[0]?.newEvidence).toBe(true);
});

test('opt-in diagnostic separates intake rejection and recorded action without claiming proof', async () => {
  const badModel: ReasoningModel = {
    async interpretRequirements() { return AgentProposalV1Schema.parse({ kind: 'verify' }) as never; },
    async propose() { throw new Error('not called'); },
  };
  const diagnostic = diagnosticReasoningModel(badModel);
  await expect(diagnostic.model.interpretRequirements(context())).rejects.toThrow();
  const projection = projectHeldoutDiagnostics({ outcome: 'BLOCKED', calls: diagnostic.calls,
    diagnostics: { requirements: [{ goalId: 'g0', kind: 'required_action', status: 'grounded',
      predicates: [{ identity: 'url:hash', state: 'true' }] }], proposals: [],
    actions: [{ goalId: 'g0', operation: 'click', effect: 'url_changed' }],
    verifications: [], firstTerminalFailure: 'private provider error' } });
  expect(projection.terminalCategory).toBe('intake_schema_rejected');
  expect(projection.requiredActionReceipts).toEqual([{ goalId: 'g0', actionRecorded: true }]);
  expect(JSON.stringify(projection)).not.toContain('private provider error');
});

test('opt-in action receipts distinguish omission from unproved action without inventing a cause', () => {
  const feedback: VerificationFeedbackV1 = { proposalId: 'check1', goalId: 'g1',
    observationId: 'aftercheck', predicateIdentity: 'url:hash', observedResult: 'true',
    matchesAcceptance: true, missingActionEvidence: true, missingOrderingEvidence: false,
    newEvidence: false, progressBefore: { coverage: 'verified_true', explicitlyVerified: true },
    progressAfter: { coverage: 'verified_true', explicitlyVerified: true },
    reason: 'action_evidence_missing' };
  const base = { requirements: [{ goalId: 'g0', kind: 'required_action' as const,
    status: 'grounded' as const, predicates: [{ identity: 'url:hash', state: 'true' as const }] }],
    proposals: [], verifications: [feedback] };
  const omitted = projectHeldoutDiagnostics({ outcome: 'BLOCKED', calls: [],
    diagnostics: { ...base, actions: [] } });
  const unproved = projectHeldoutDiagnostics({ outcome: 'BLOCKED', calls: [],
    diagnostics: { ...base, actions: [{ goalId: 'g0', operation: 'click',
      effect: 'url_changed' }] } });
  expect(omitted.requiredActionReceipts).toEqual([{ goalId: 'g0', actionRecorded: false }]);
  expect(unproved.requiredActionReceipts).toEqual([{ goalId: 'g0', actionRecorded: true }]);
  expect(omitted.diagnostics?.verifications[0]?.reason)
    .toBe(unproved.diagnostics?.verifications[0]?.reason);
});

test('diagnostic mode needs a separate explicit environment opt-in', () => {
  expect(adaptivePhase3aDiagnosticsEnabled(undefined)).toBe(false);
  expect(adaptivePhase3aDiagnosticsEnabled('0')).toBe(false);
  expect(adaptivePhase3aDiagnosticsEnabled('true')).toBe(false);
  expect(adaptivePhase3aDiagnosticsEnabled('1')).toBe(true);
});

test('opt-in diagnostic distinguishes refinement rejection from initial intake rejection', async () => {
  const validated = validateRequirementIntake(task, observation, intake, [observation]);
  const model: ReasoningModel = {
    async interpretRequirements(current) {
      if (current.previous) return AgentProposalV1Schema.parse({ kind: 'verify' }) as never;
      return validated;
    },
    async propose() { throw new Error('not called'); },
  };
  const diagnostic = diagnosticReasoningModel(model);
  await diagnostic.model.interpretRequirements(context());
  await expect(diagnostic.model.interpretRequirements({ ...context(), previous: validated }))
    .rejects.toThrow();
  const projection = projectHeldoutDiagnostics({ outcome: 'BLOCKED', calls: diagnostic.calls });
  expect(diagnostic.calls.map(call => [call.stage, call.outcome]))
    .toEqual([['intake', 'returned'], ['refinement', 'schema_rejected']]);
  expect(projection.terminalCategory).toBe('refinement_schema_rejected');
});

test('opt-in diagnostic identifies controller rejection after initial intake or refinement', () => {
  const returnedIntake = { stage: 'intake' as const, observationId: 'initial',
    outcome: 'returned' as const, feedbackCount: 0, feedbackProposalIds: [], issues: [] };
  const diagnostics = { requirements: [], proposals: [], actions: [], verifications: [],
    firstTerminalFailure: 'private raw error' };
  const initial = projectHeldoutDiagnostics({ outcome: 'BLOCKED',
    stopReason: 'ACCEPTANCE_NOT_GROUNDED', calls: [returnedIntake], diagnostics });
  expect(initial.terminalCategory).toBe('intake_validation_rejected');
  expect(initial.validationCode).toBe('ACCEPTANCE_NOT_GROUNDED');
  expect(initial.diagnostics?.firstTerminalFailure).toBe('intake_validation_rejected');
  const refinement = projectHeldoutDiagnostics({ outcome: 'BLOCKED',
    stopReason: 'GROUNDED_ACCEPTANCE_CHANGED',
    calls: [returnedIntake, { ...returnedIntake, stage: 'refinement',
      observationId: 'afteraction' }], diagnostics });
  expect(refinement.terminalCategory).toBe('refinement_validation_rejected');
  expect(refinement.validationCode).toBe('GROUNDED_ACCEPTANCE_CHANGED');
  expect(refinement.diagnostics?.firstTerminalFailure).toBe('refinement_validation_rejected');
  expect(JSON.stringify({ initial, refinement })).not.toContain('private raw error');
});

test('opt-in projection retains mismatch, observed false and repeated-ineffective distinctions', () => {
  const base: VerificationFeedbackV1 = { proposalId: 'check1', goalId: 'g1',
    observationId: 'observed1', predicateIdentity: 'url:hash', observedResult: 'false',
    matchesAcceptance: true, missingActionEvidence: false, missingOrderingEvidence: false,
    newEvidence: true, progressBefore: { coverage: 'verified_false', explicitlyVerified: false },
    progressAfter: { coverage: 'verified_false', explicitlyVerified: false }, reason: 'observed_false' };
  const projection = projectHeldoutDiagnostics({ outcome: 'BLOCKED',
    stopReason: 'REPEATED_INEFFECTIVE_VERIFICATION', calls: [], diagnostics: {
      requirements: [], proposals: [], actions: [], verifications: [base,
        { ...base, proposalId: 'check2', matchesAcceptance: false,
          observedResult: 'true', reason: 'predicate_mismatch' },
        { ...base, proposalId: 'check3', newEvidence: false,
          reason: 'repeated_observation' }],
      firstTerminalFailure: 'REPEATED_INEFFECTIVE_VERIFICATION' } });
  expect(projection.terminalCategory).toBe('REPEATED_INEFFECTIVE_VERIFICATION');
  expect(projection.diagnostics?.verifications.map(item =>
    [item.observedResult, item.matchesAcceptance, item.newEvidence, item.reason]))
    .toEqual([['false', true, true, 'observed_false'],
      ['true', false, true, 'predicate_mismatch'],
      ['false', true, false, 'repeated_observation']]);
});
