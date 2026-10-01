import http from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { CurrentStateExploration, McpExplorationSession, TrustedObservationSessionV1 } from '../app/exploration/index.js';
import { GoalDirectedVerificationControllerV1, parseSuccessfulVerificationStrategyV1,
  type AgenticVerificationModelV4,
  type VerificationDecisionContextV4 } from '../app/interpretation/verification-strategy.js';
import { normalizeAgenticVerificationDecisionWire } from '../app/interpretation/verification-wire.js';
import { ProfileCatalog, ProtectedContextFactory } from '../app/profile/index.js';

async function setup(html: string, clauses: string[], orderedSteps?: ({ sourceText: string } & Record<string, unknown>)[]) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html'); response.end(html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `http://127.0.0.1:${address.port}/`;
  const authoredClauses = clauses.map((clause) => clause.replace('{URL}', url));
  const resolvedSteps = orderedSteps?.map((step) => ({ ...step,
    sourceText: step.sourceText.replace('{URL}', url),
    ...(step.url === '{URL}' ? { url } : {}),
  }));
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'verification-desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 },
    locale: 'en-US', timeoutPolicy: { actionMs: 5000, navigationMs: 5000, waits: { default: 3000 } },
    networkPolicyRef: { id: 'verification-policy', version: '1' },
  }], [{ id: 'verification-policy', version: '1', destinations: [{ host: '127.0.0.1',
    ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const source = { schemaVersion: '4', testSpecId: 'test-goal-strategy',
    sourceInstruction: resolvedSteps ? resolvedSteps.map((step) => step.sourceText).join(' ') :
      `${authoredClauses.join(' ')} Click the "Add Element" button. Click the "Close" button.`,
    executionProfileRef: { id: 'verification-desktop', version: '1' }, startState: { url },
    steps: resolvedSteps ?? [...authoredClauses.map((clause, index) => ({ id: `s${index + 1}`, type: 'verification_goal',
      sourceText: clause, instruction: clause })),
      { id: 'action-add', type: 'click', sourceText: 'Click the "Add Element" button.',
        target: { description: 'Add Element button' } },
      { id: 'action-close', type: 'click', sourceText: 'Click the "Close" button.',
        target: { description: 'Close button' } }] };
  const session = await McpExplorationSession.open(factory, source.executionProfileRef,
    factory.catalog.resolve(source.executionProfileRef), 'explore-verification');
  await session.navigate(url);
  const current = new CurrentStateExploration(session, source, 'explore-verification');
  const observations = new TrustedObservationSessionV1(session, current);
  return { session, current, observations, url,
    close: async () => { await session.close(); server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done())); } };
}
const goal = (id: string, clause: string, subject?: object, intent?: object) => ({
  id, type: 'verification_goal', sourceText: clause, instruction: clause, ...(subject ? { subject } : {}),
  ...(intent ? { intent } : {}),
});
const query = (role: string, name: string) => ({ kind: 'semantic_query', query: {
  role, name, frame: { kind: 'main' },
} });
const property = (role: string, name: string, prop: string) => ({ kind: 'target_property',
  query: { role, name, frame: { kind: 'main' } }, property: prop });
const observe = (request: object) => ({ decisionVersion: '4', kind: 'observe', request });
const conclude = (conclusion: string, comparison?: object) => ({ decisionVersion: '4', kind: 'conclude',
  conclusion, ...(comparison ? { comparison } : {}) });
function scripted(steps: ((context: VerificationDecisionContextV4) => object)[]): AgenticVerificationModelV4 {
  let index = 0;
  return { complete: async ({ context }) => JSON.stringify(steps[index++]?.(context) ?? conclude('unresolved')) };
}
const last = (context: VerificationDecisionContextV4) => context.observations.at(-1)!.observationId;

test('complete count establishes absence, presence, cardinality and evaluated false without QA verdict', async () => {
  const run = await setup('<button style="display:none">Delete</button><button>Delete</button><button>Delete</button>',
    ['Confirm a button with the text "Delete" does not exist.', 'Confirm a button with the text "Delete" exists.',
      'Verify there are exactly three Delete button elements.']);
  try {
    const subject = { role: 'button', accessibleName: 'Delete' };
    const count = (operator: string, expected: number, outcome: string) =>
      (ctx: VerificationDecisionContextV4) => conclude(outcome,
        { kind: 'count', observationId: last(ctx), operator, expected });
    const cases = [
      { clause: 'Confirm a button with the text "Delete" does not exist.', intent: { kind: 'presence', expected: 'absent' },
        operator: 'equal', expected: 0, outcome: 'unsatisfied' },
      { clause: 'Confirm a button with the text "Delete" exists.', intent: { kind: 'presence', expected: 'present' },
        operator: 'greater_than', expected: 0, outcome: 'satisfied' },
      { clause: 'Verify there are exactly three Delete button elements.', intent: { kind: 'cardinality', comparison: 'equal', count: 3 },
        operator: 'equal', expected: 3, outcome: 'satisfied' },
    ];
    for (const [i, item] of cases.entries()) {
      const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current,
        scripted([() => observe(query('button', 'Delete')), count(item.operator, item.expected, item.outcome)]));
      const outcome = await controller.evaluate(goal(`s${i + 1}`, item.clause, subject, item.intent), i);
      expect(outcome.conclusion).toBe(item.outcome);
      expect(outcome.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 3, complete: true });
      expect(controller.successfulStrategies).toHaveLength(1);
      expect(outcome).not.toHaveProperty('qaVerdict');
    }
  } finally { await run.close(); }
});

test('hidden presence differs from visibility; unique properties, text, value and URL are typed', async () => {
  const clauses = ['Confirm a button with the text "Delete" exists.', 'Verify the Save button is disabled.',
    'Verify heading text "Hello".', 'Verify textbox Name value "Alice".', 'Verify URL {URL}',
    'Verify the Delete button is visible.'];
  const run = await setup('<button style="display:none">Delete</button><button disabled>Save</button>' +
    '<p role="heading">Hello</p><label>Name<input value="Alice"></label>', clauses);
  try {
    const cases: { g: object; request: object; comparison: (id: string) => object }[] = [
      { g: goal('s1', clauses[0]!, { role: 'button', accessibleName: 'Delete' }, { kind: 'presence', expected: 'present' }),
        request: query('button', 'Delete'), comparison: (id) => ({ kind: 'count', observationId: id, operator: 'greater_than', expected: 0 }) },
      { g: goal('s2', clauses[1]!, { role: 'button', accessibleName: 'Save' },
        { kind: 'property', property: 'enabled', expected: false }),
        request: property('button', 'Save', 'enabled'), comparison: (id) => ({ kind: 'boolean', observationId: id,
          property: 'enabled', expected: false }) },
      { g: goal('s3', clauses[2]!, { role: 'heading', accessibleName: 'Hello' }), request: property('heading', 'Hello', 'text'),
        comparison: (id) => ({ kind: 'string', observationId: id, property: 'text', operator: 'equal', expected: 'Hello' }) },
      { g: goal('s4', clauses[3]!, { role: 'textbox', accessibleName: 'Name' }), request: property('textbox', 'Name', 'value'),
        comparison: (id) => ({ kind: 'string', observationId: id, property: 'value', operator: 'equal', expected: 'Alice' }) },
      { g: goal('s5', `Verify URL ${run.url}`), request: { kind: 'current_url' },
        comparison: (id) => ({ kind: 'string', observationId: id, property: 'url', operator: 'equal', expected: run.url }) },
    ];
    for (const [i, item] of cases.entries()) {
      const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
        () => observe(item.request), (ctx) => conclude('satisfied', item.comparison(last(ctx))),
      ]));
      const evaluated = await controller.evaluate(item.g, i);
      expect(evaluated, `case ${i}`).toMatchObject({ conclusion: 'satisfied' });
    }
    const visibility = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(property('button', 'Delete', 'visible')),
      (ctx) => conclude('unsatisfied', { kind: 'boolean', observationId: last(ctx), property: 'visible', expected: true }),
    ]));
    expect((await visibility.evaluate(goal('s6', 'Verify the Delete button is visible.',
      { role: 'button', accessibleName: 'Delete' }, { kind: 'property', property: 'visible', expected: true }), 5)).conclusion)
      .toBe('unsatisfied');
  } finally { await run.close(); }
});

test('zero-match Add/Remove evidence expires after reviewed action; fresh presence succeeds', async () => {
  const absent = 'Confirm a button with the text "Delete" does not exist.';
  const present = 'Confirm a button with the text "Delete" exists.';
  const run = await setup('<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<button>Delete</button>\')">Add Element</button>',
    [absent, present]);
  try {
    const model = scripted([
      () => observe(query('button', 'Delete')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'equal', expected: 0 }),
      () => observe(query('button', 'Delete')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'greater_than', expected: 0 }),
    ]);
    const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, model);
    const first = await controller.evaluate(goal('s1', absent, { role: 'button', accessibleName: 'Delete' },
      { kind: 'presence', expected: 'absent' }), 0);
    expect(first.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 0 });
    expect(parseSuccessfulVerificationStrategyV1(first.strategy)).toMatchObject({ goalStepId: 's1' });
    expect(() => parseSuccessfulVerificationStrategyV1({ ...first.strategy, evaluated: false })).toThrow();
    const view = await run.current.observe();
    const ref = /button "Add Element" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    expect(ref).toBeTruthy();
    const action = await run.current.act(await run.current.bind('action-add', 'click', ref!));
    controller.noteSuccessfulAction(action);
    expect(await run.observations.currentEvidence({ ...first.strategy?.observations[0] })).toBeUndefined();
    const second = await controller.evaluate(goal('s2', present, { role: 'button', accessibleName: 'Delete' },
      { kind: 'presence', expected: 'present' }), 1);
    expect(second.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 1 });
    expect(second.strategy?.observations[0]?.stateEpoch).toBeGreaterThan(first.strategy?.observations[0]?.stateEpoch ?? 0);
    expect(controller.successfulStrategies).toHaveLength(2);
  } finally { await run.close(); }
});

test('ordered Add/Remove action and verification goals yield three private strategies', async () => {
  const add = 'Confirm the Add Element button exists.';
  const absent = 'Confirm a button with the text "Delete" does not exist.';
  const present = 'Confirm a button with the text "Delete" exists.';
  const steps = [
    { id: 'go', type: 'navigate', sourceText: 'Go to {URL}.', url: '{URL}' },
    { id: 'link', type: 'click', sourceText: 'Click Add/Remove Elements link.',
      target: { description: 'Add/Remove Elements link' } },
    goal('add-goal', add, { role: 'button', accessibleName: 'Add Element' }, { kind: 'presence', expected: 'present' }),
    goal('absent-goal', absent, { role: 'button', accessibleName: 'Delete' }, { kind: 'presence', expected: 'absent' }),
    { id: 'add-action', type: 'click', sourceText: 'Click the Add Element button.',
      target: { description: 'Add Element button' } },
    goal('present-goal', present, { role: 'button', accessibleName: 'Delete' }, { kind: 'presence', expected: 'present' }),
  ];
  const run = await setup('<a href="#elements">Add/Remove Elements</a>' +
    '<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<button>Delete</button>\')">Add Element</button>',
    [add, absent, present], steps);
  try {
    // The protected session is the same one used by the released current-state action binding.
    await run.session.navigate(run.url); run.current.invalidate();
    let view = await run.current.observe();
    const linkRef = /link "Add\/Remove Elements" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    expect(linkRef).toBeTruthy();
    await run.current.act(await run.current.bind('link', 'click', linkRef!));
    const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(query('button', 'Add Element')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'greater_than', expected: 0 }),
      () => observe(query('button', 'Delete')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'equal', expected: 0 }),
      () => observe(query('button', 'Delete')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'greater_than', expected: 0 }),
    ]));
    const addResult = await controller.evaluate(steps[2], 2);
    const absentResult = await controller.evaluate(steps[3], 3);
    expect(addResult.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 1 });
    expect(absentResult.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 0, complete: true });
    view = await run.current.observe();
    const addRef = /button "Add Element" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    const action = await run.current.act(await run.current.bind('add-action', 'click', addRef!));
    controller.noteSuccessfulAction(action);
    const after = await controller.evaluate(steps[5], 5);
    expect(after.strategy?.observations[0]?.result).toMatchObject({ kind: 'matches', count: 1 });
    expect(after.strategy?.observations[0]?.stateEpoch).toBeGreaterThan(
      absentResult.strategy?.observations[0]?.stateEpoch ?? 0);
    expect(controller.successfulStrategies.map((entry) => entry.goalStepId)).toEqual([
      'add-goal', 'absent-goal', 'present-goal',
    ]);
  } finally { await run.close(); }
});

test('bare claims, forged IDs, snapshot proof, query errors and repeat requests remain unresolved', async () => {
  const clause = 'Confirm a button with the text "Delete" does not exist.';
  const run = await setup('<button>Save</button>', [clause]);
  const g = goal('s1', clause, { role: 'button', accessibleName: 'Delete' }, { kind: 'presence', expected: 'absent' });
  try {
    const cases = [
      [() => conclude('satisfied'), 'INTENT_NOT_PRESERVED'],
      [() => conclude('satisfied', { kind: 'count', observationId: 'observation-forged', operator: 'equal', expected: 0 }),
        'EVIDENCE_INELIGIBLE'],
      [() => observe({ kind: 'semantic_snapshot' }),
        (ctx: VerificationDecisionContextV4) => conclude('satisfied', { kind: 'count', observationId: last(ctx),
          operator: 'equal', expected: 0 })],
      [() => observe(query('button', 'Delete')), () => observe(query('button', 'Delete'))],
      [() => observe({ kind: 'semantic_query', query: { role: 'button', name: 'Delete',
        frame: { kind: 'nested', anchors: [{ kind: 'title', value: 'missing', exact: true }] } } }),
      (ctx: VerificationDecisionContextV4) => conclude('satisfied', { kind: 'count', observationId: last(ctx),
        operator: 'equal', expected: 0 })],
    ] as ((context: VerificationDecisionContextV4) => object)[][];
    for (const steps of cases) {
      const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted(steps));
      expect((await controller.evaluate(g, 0)).conclusion).toBe('unresolved');
      expect(controller.successfulStrategies).toHaveLength(0);
    }
  } finally { await run.close(); }
});

test('temporal disappearance requires earlier grounded presence and later absence across action', async () => {
  const earlier = 'Confirm the Modal dialog exists.';
  const temporal = 'Make sure the modal disappears.';
  const run = await setup('<div role="dialog" aria-label="Modal">Hi</div><button onclick="document.querySelector(\'[role=dialog]\').remove()">Close</button>',
    [earlier, temporal]);
  try {
    const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(query('dialog', 'Modal')),
      (ctx) => conclude('satisfied', { kind: 'count', observationId: last(ctx), operator: 'greater_than', expected: 0 }),
      () => observe(query('dialog', 'Modal')),
      (ctx) => conclude('satisfied', { kind: 'transition', earlierObservationId: controller.successfulStrategies[0]!.observationIds[0],
        laterObservationId: last(ctx), operator: 'disappears' }),
    ]));
    expect((await controller.evaluate(goal('s1', earlier, { role: 'dialog', accessibleName: 'Modal' },
      { kind: 'presence', expected: 'present' }), 0)).conclusion).toBe('satisfied');
    const view = await run.current.observe();
    const ref = /button "Close" \[ref=([A-Za-z][A-Za-z0-9_-]*)\]/.exec(view.snapshot)?.[1];
    const action = await run.current.act(await run.current.bind('action-close', 'click', ref!));
    controller.noteSuccessfulAction(action);
    const transition = await controller.evaluate(goal('s2', temporal, { accessibleName: 'Modal' },
      { kind: 'temporal', transition: 'disappears' }), 1);
    expect(transition.reason).toBeUndefined();
    expect(transition.conclusion).toBe('satisfied');
    const noHistory = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(query('dialog', 'Modal')),
      (ctx) => conclude('satisfied', { kind: 'transition', earlierObservationId: last(ctx),
        laterObservationId: last(ctx), operator: 'disappears' }),
    ]));
    expect((await noHistory.evaluate(goal('s2', temporal, { accessibleName: 'Modal' },
      { kind: 'temporal', transition: 'disappears' }), 1)).conclusion).toBe('unresolved');
  } finally { await run.close(); }
});

test('unreviewed visual relationship is unsupported', async () => {
  const clause = 'Check that Alice appears above Bob.';
  const run = await setup('<p>Alice</p><p>Bob</p>', [clause]);
  try {
    const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current,
      scripted([() => conclude('unsupported')]));
    expect((await controller.evaluate(goal('s1', clause, undefined,
      { kind: 'relationship', relation: 'above', other: 'Bob' }), 0)).conclusion).toBe('unsupported');
    expect(controller.successfulStrategies).toHaveLength(0);
  } finally { await run.close(); }
});

test('ambiguous property, stale fact and contradictory claim cannot enter successful journal', async () => {
  const clause = 'Verify the Save button is enabled.';
  const run = await setup('<button>Save</button><button>Save</button>', [clause]);
  const g = goal('s1', clause, { role: 'button', accessibleName: 'Save' },
    { kind: 'property', property: 'enabled', expected: true });
  try {
    const ambiguous = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(property('button', 'Save', 'enabled')),
      (ctx) => conclude('satisfied', { kind: 'boolean', observationId: last(ctx), property: 'enabled', expected: true }),
    ]));
    expect((await ambiguous.evaluate(g, 0)).conclusion).toBe('unresolved');
    expect(ambiguous.successfulStrategies).toHaveLength(0);
    const page = run.session.browserSession.context.pages()[0]!;
    await page.evaluate(() => document.querySelectorAll('button')[1]!.remove());
    let calls = 0;
    const staleModel: AgenticVerificationModelV4 = { complete: async ({ context }) => {
      calls++;
      if (calls === 1) return JSON.stringify(observe(property('button', 'Save', 'enabled')));
      await page.evaluate(() => document.body.setAttribute('data-state', 'changed'));
      return JSON.stringify(conclude('satisfied', { kind: 'boolean', observationId: last(context),
        property: 'enabled', expected: true }));
    } };
    const stale = new GoalDirectedVerificationControllerV1(run.observations, run.current, staleModel);
    expect(await stale.evaluate(g, 0)).toMatchObject({ conclusion: 'unresolved', reason: 'EVIDENCE_STALE' });
    expect(stale.successfulStrategies).toHaveLength(0);
    const contradiction = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(property('button', 'Save', 'enabled')),
      (ctx) => conclude('unsatisfied', { kind: 'boolean', observationId: last(ctx),
        property: 'enabled', expected: true }),
    ]));
    expect(await contradiction.evaluate(g, 0)).toMatchObject({ conclusion: 'unresolved',
      reason: 'CLAIM_CONTRADICTS_FACT' });
  } finally { await run.close(); }
});

test('unhinted property combines reviewed primitives; wire rejects selector injection', async () => {
  const clause = 'Verify the Save button is disabled.';
  const run = await setup('<button disabled>Save</button>', [clause]);
  try {
    const controller = new GoalDirectedVerificationControllerV1(run.observations, run.current, scripted([
      () => observe(property('button', 'Save', 'enabled')),
      (ctx) => conclude('satisfied', { kind: 'boolean', observationId: last(ctx), property: 'enabled', expected: false }),
    ]));
    expect((await controller.evaluate(goal('s1', clause), 0)).conclusion).toBe('satisfied');
    const wire = { response: { decisionVersion: '4', kind: 'observe', request: {
      kind: 'semantic_query', query: { role: 'button', name: 'Save', frame: { kind: 'main' }, within: null },
    } } };
    expect(JSON.parse(normalizeAgenticVerificationDecisionWire(wire))).toMatchObject({
      decisionVersion: '4', kind: 'observe', request: { kind: 'semantic_query' },
    });
    expect(() => normalizeAgenticVerificationDecisionWire({ response: { ...wire.response,
      request: { ...wire.response.request, selector: '#save' },
    } })).toThrow();
  } finally { await run.close(); }
});
