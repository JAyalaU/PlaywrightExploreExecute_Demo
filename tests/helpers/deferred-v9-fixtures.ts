import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { ActionCandidateGroundingSessionV1 } from '../../app/exploration/action-candidate-grounding.js';
import { McpExplorationSession } from '../../app/exploration/mcp.js';
import { ProtectedContextFactory, ProfileCatalog } from '../../app/profile/index.js';
import { admitActionSemanticsV2,NATIVE_OPTION_ADMISSION_VERSIONS_V2 } from '../../app/domain/action-semantic-admission.js';
import type { GroundingCorrespondenceV1 } from '../../app/domain/action-grounding-strategy.js';
import type { ActionGoalV2, TestSpecV6V2 } from '../../app/domain/index.js';
import { executeActionGoalGroundingV1 } from '../../app/interpretation/action-grounding-execution-controller.js';
import { SuccessfulTraceAssemblerV5 } from '../../app/exploration/trace-assembly-v5.js';
import { SuccessfulTraceV5Store, type TrustedSuccessfulTraceReadbackV5 } from '../../app/evidence/trace-store-v5.js';
import { action, choose } from './action-v2-fixtures.js';
import { compileDeferredSuccessfulTraceV5 } from '../../app/exploration/deferred-trace-compiler-v4.js';

export const select = '<select><option value="">Choose</option><option value="runtime-1">Option 1</option></select>';
export const fill = () => action([['Enter', 'effect'], [' ', 'neutral'], ['exact text', 'argument'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'enter_text', sourceSegmentIds: ['p0'] },
  { id: 'a', kind: 'argument', purpose: 'entered_text', authoredText: 'exact text', sourceSegmentIds: ['p2'] },
]);
export const check = (role: 'checkbox' | 'radio') => action([['Click', 'effect'], [' the ', 'neutral'], [role, 'target'], ['.', 'neutral']], [
  { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
  { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
  { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', authoredText: role, sourceSegmentIds: ['p2'] },
]);
export const verification = (id = 'verify'): TestSpecV6V2['steps'][number] => ({ id, type: 'verification_goal',
  sourceText: 'Confirm the textbox is visible.', instruction: 'Confirm the textbox is visible.',
  subject: { role: 'textbox' }, intent: { kind: 'property', property: 'visible', expected: true },
  sourceInstructionSpan: { start: 0, end: 31 } });

export async function harness(html: string, goalsInput: TestSpecV6V2['steps'] | ((url: string) => TestSpecV6V2['steps']) = [choose()]) {
  let currentHtml = html;
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(currentHtml); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `http://127.0.0.1:${address.port}/`;
  const goals = typeof goalsInput === 'function' ? goalsInput(url) : goalsInput;
  let end = 0;
  const steps = structuredClone(goals).map((g, index) => {
    if (index) end++;
    g.sourceInstructionSpan = { start: end, end: end + g.sourceText.length }; end += g.sourceText.length;
    return g;
  });
  const draft: TestSpecV6V2 = { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'trace-v5-fixture',
    sourceInstruction: steps.map((g) => g.sourceText).join(' '), executionProfileRef: { id: 'desktop', version: '1' },
    startState: { url }, steps, instructionAccounting: steps.flatMap((g, i) => [
      ...(i ? [{ classification: 'neutral' as const, sourceSpan: { start: g.sourceInstructionSpan.start - 1, end: g.sourceInstructionSpan.start }, authoredText: ' ' }] : []),
      { classification: 'clause' as const, stepId: g.id, sourceSpan: g.sourceInstructionSpan, authoredText: g.sourceText },
    ]) };
  const versions = { goalContractVersion: '2' as const, primaryExtractionVersion: 'mock_primary', independentExtractionVersion: 'mock_independent',
    primaryPromptVersion: 'mock_primary', independentPromptVersion: 'mock_independent' };
  const { schemaVersion: _schema, sourceContractVersion: _contract, steps: _steps, instructionAccounting: _accounting, ...metadata } = draft;
  const admission = admitActionSemanticsV2(metadata, draft, structuredClone(draft),steps.some(s=>'verificationVersion'in s)?NATIVE_OPTION_ADMISSION_VERSIONS_V2:versions);
  const factory = new ProtectedContextFactory(new ProfileCatalog([{
    id: 'desktop', version: '1', browser: 'chromium', viewport: { width: 900, height: 600 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 3000, navigationMs: 5000, waits: { default: 3000 } }, networkPolicyRef: { id: 'local', version: '1' },
  }], [{ id: 'local', version: '1', destinations: [{ host: '127.0.0.1', ports: [address.port], addresses: ['127.0.0.1'] }] }]));
  const session = await McpExplorationSession.open(factory, draft.executionProfileRef, factory.catalog.resolve(draft.executionProfileRef), 'wp3a-attempt');
  await session.navigate(url);
  const runtime = new ActionCandidateGroundingSessionV1(session, admission, 'wp3a-attempt');
  const root = await mkdtemp(path.join(tmpdir(), 'trace-v5-'));
  return { admission, runtime, session, url, root, factory, setHtml: (value: string) => { currentHtml = value; }, page: session.browserSession.context.pages()[0]!,
    close: async () => { await session.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true }); } };
}
type Run = Awaited<ReturnType<typeof harness>>;
export function correspondence(goal: ActionGoalV2): GroundingCorrespondenceV1 {
  return goal.obligations.map((obligation) => {
    if (obligation.kind === 'effect' || obligation.kind === 'operation') return { obligation, realization: { kind: obligation.kind } };
    if (obligation.kind === 'argument') return { obligation, realization: { kind: 'literal' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'role') return { obligation,
      realization: obligation.authoredText === 'dropdown' ? { kind: 'role_semantic', role: 'combobox' } :
        { kind: 'role_exact', role: obligation.authoredText as 'checkbox' | 'radio' | 'textbox' } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'name') return { obligation,
      realization: { kind: 'name_exact', name: obligation.authoredText } };
    if (obligation.kind === 'constraint' && obligation.constraint === 'context') {
      const country = obligation.sourceSegmentIds.map((id) => goal.sourceAccounting.find((s) => s.id === id))
        .find((segment) => segment?.authoredText.includes('Country'));
      if (!country) throw new Error('Missing Country context fixture');
      const start = country.sourceSpan.start + country.authoredText.indexOf('Country');
      return { obligation, realization: { kind: 'label', text: 'Country', sourceSegmentIds: [country.id],
        sourceSpan: { start, end: start + 'Country'.length } } };
    }
    return { obligation, realization: { kind: 'pending' } };
  });
}
export async function execute(run: Run, id = 's1') {
  const sourceGoal = run.admission.spec.steps.find((g) => g.id === id);
  if (sourceGoal?.type !== 'action_goal') throw new Error('Missing source action');
  const goal = structuredClone(sourceGoal) as ActionGoalV2, entries = correspondence(goal);
  const effect = goal.obligations.find((o) => o.kind === 'effect');
  const operation = effect?.kind === 'effect' && effect.effect === 'choose' ? 'select_option' :
    effect?.kind === 'effect' && effect.effect === 'enter_text' ? 'fill' : 'click';
  return executeActionGoalGroundingV1({ admission: run.admission, runtime: run.runtime, goalId: id,
    model: { complete: async () => JSON.stringify({ decisionVersion: '5', kind: 'ground', goalId: id, operation, correspondence: entries }) },
    independentModel: { extract: async () => JSON.stringify({ mappingExtractionVersion: '1', goalId: id, correspondence: entries }) } });
}
async function success(run: Run, builder: SuccessfulTraceAssemblerV5) {
  const outcome = await execute(run);
  expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
  if (outcome.status !== 'succeeded') throw new Error('No successful witness');
  builder.appendActionGroundingWitness(outcome.witness); return outcome;
}
async function artifact(run: Run) {
  const builder = await SuccessfulTraceAssemblerV5.create(run);
  const outcome = await success(run, builder);
  return { assembled: await builder.finalize(), outcome };
}


export async function input(run: Run) {
  const { assembled } = await artifact(run);
  return new SuccessfulTraceV5Store(run.root).writeSuccessfulExplorationV5(assembled);
}
export async function compile(run: Run, readback: TrustedSuccessfulTraceReadbackV5) {
  await run.session.close();
  return compileDeferredSuccessfulTraceV5(run.factory, readback);
}
