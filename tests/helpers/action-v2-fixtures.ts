import type {ActionGoalV2,ActionObligationV2,ActionSourceSegmentV2,TestSpecV6V2} from '../../app/domain/index.js';
type Piece = readonly [string, ActionSourceSegmentV2['classification']];
export function action(pieces: readonly Piece[], obligations: ActionObligationV2[], anchors: ActionGoalV2['anchors'] = []): ActionGoalV2 {
  let end = 0;
  return { id: 's1', sourceStepId: 's1', type: 'action_goal', goalVersion: '2',
    sourceText: pieces.map(([text]) => text).join(''), sourceInstructionSpan: { start: 0, end: pieces.reduce((n, [text]) => n + text.length, 0) },
    obligations, anchors, sourceAccounting: pieces.map(([authoredText, classification], index) => {
      const start = end; end += authoredText.length;
      const base = { id: `p${index}`, sourceSpan: { start, end }, authoredText };
      return classification === 'unresolved' ? { ...base, classification, obligationIds: [], reason: 'unclassified_material' } :
        { ...base, classification, obligationIds: obligations.filter((item) => item.sourceSegmentIds.includes(base.id)).map((item) => item.id) };
    }) };
}
export const name = (id: string, sourceSegmentIds: string[], authoredText: string): ActionObligationV2 => ({
  id, kind: 'constraint', constraint: 'name', subject: { kind: 'target' }, polarity: 'positive', sourceSegmentIds, authoredText,
});
const effect = (word: ActionObligationV2 & { kind: 'effect' }) => word;
export function activate(verb = 'Tap', target = 'Save'): ActionGoalV2 {
  return action([[verb, 'effect'], [' ', 'neutral'], [target, 'target'], ['.', 'neutral']], [
    effect({ id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] }), name('n', ['p2'], target),
    ...(verb === 'Click' ? [{ id: 'o', kind: 'operation' as const, operation: 'click' as const, sourceSegmentIds: ['p0'] }] : []),
  ]);
}
export function choose(connector?: string, leading = false): ActionGoalV2 {
  if (!connector) return action([['Select', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: ['p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: ['p2'] },
  ]);
  const pieces: Piece[] = leading ? [['In the ', 'context'], ['Country', 'target'], [' ', 'context'], ['dropdown', 'target'],
    [', ', 'neutral'], ['choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], ['.', 'neutral']] :
    [['Choose', 'effect'], [' ', 'neutral'], ['Option 1', 'argument'], [` ${connector} the `, 'context'],
      ['Country', 'target'], [' ', 'context'], ['dropdown', 'target'], ['.', 'neutral']];
  const contextIds = leading ? ['p0', 'p1', 'p2', 'p3'] : ['p3', 'p4', 'p5', 'p6'];
  return action(pieces, [
    { id: 'e', kind: 'effect', effect: 'choose', sourceSegmentIds: [leading ? 'p5' : 'p0'] },
    { id: 'a', kind: 'argument', purpose: 'choice', authoredText: 'Option 1', sourceSegmentIds: [leading ? 'p7' : 'p2'] },
    name('n', [leading ? 'p1' : 'p4'], 'Country'),
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive',
      sourceSegmentIds: [leading ? 'p3' : 'p6'], authoredText: 'dropdown' },
    { id: 'c', kind: 'constraint', constraint: 'context', subject: { kind: 'target' }, polarity: 'positive',
      sourceSegmentIds: contextIds, authoredText: contextIds.map((id) => pieces[Number(id.slice(1))]![0]).join('') },
  ]);
}
export function relation(): ActionGoalV2 {
  return action([['Click', 'effect'], [' the ', 'neutral'], ['button', 'target'], [' ', 'neutral'],
    ['next to ', 'relationship'], ['Email', 'relationship'], ['.', 'neutral']], [
    { id: 'e', kind: 'effect', effect: 'activate', sourceSegmentIds: ['p0'] },
    { id: 'o', kind: 'operation', operation: 'click', sourceSegmentIds: ['p0'] },
    { id: 'r', kind: 'constraint', constraint: 'role', subject: { kind: 'target' }, polarity: 'positive', sourceSegmentIds: ['p2'], authoredText: 'button' },
    { id: 'l', kind: 'relationship', subject: { kind: 'target' }, anchorId: 'email', polarity: 'positive', sourceSegmentIds: ['p4', 'p5'], authoredText: 'next to Email' },
  ], [{ id: 'email', sourceSegmentIds: ['p5'], authoredText: 'Email' }]);
}
export function spec(goal: ActionGoalV2): TestSpecV6V2 {
  return { schemaVersion: '6', sourceContractVersion: '2', testSpecId: 'test', sourceInstruction: goal.sourceText,
    executionProfileRef: { id: 'desktop', version: '1' }, startState: { url: 'about:blank' }, steps: [goal],
    instructionAccounting: [{ classification: 'clause', stepId: goal.id, sourceSpan: goal.sourceInstructionSpan, authoredText: goal.sourceText }] };
}
export function rename(specInput: TestSpecV6V2): TestSpecV6V2 {
  const copy = structuredClone(specInput);
  const steps = new Map(copy.steps.map((step) => [step.id, `renamed_${step.id}`]));
  for (const step of copy.steps) {
    const oldId = step.id; step.id = steps.get(oldId)!;
    if (step.type !== 'action_goal') continue;
    step.sourceStepId = step.id;
    const ids = new Map([...step.sourceAccounting, ...step.obligations, ...step.anchors].map((item) => [item.id, `x_${item.id}`]));
    for (const segment of step.sourceAccounting) { segment.id = ids.get(segment.id)!; segment.obligationIds = segment.obligationIds.map((id) => ids.get(id)!).reverse(); }
    for (const anchor of step.anchors) { anchor.id = ids.get(anchor.id)!; anchor.sourceSegmentIds = anchor.sourceSegmentIds.map((id) => ids.get(id)!); }
    for (const item of step.obligations) {
      item.id = ids.get(item.id)!; item.sourceSegmentIds = item.sourceSegmentIds.map((id) => ids.get(id)!);
      if (item.kind === 'relationship') item.anchorId = ids.get(item.anchorId)!;
      if (item.kind === 'constraint' && item.subject.kind === 'anchor') item.subject.anchorId = ids.get(item.subject.anchorId)!;
      if (item.kind === 'reference') item.antecedentStepId = steps.get(item.antecedentStepId)!;
      if (item.kind === 'prerequisite') item.dependsOnStepId = steps.get(item.dependsOnStepId)!;
      if (item.kind === 'contrast') item.obligationIds = item.obligationIds.map((id) => ids.get(id)!).reverse();
    }
    step.obligations.reverse(); step.anchors.reverse();
  }
  for (const segment of copy.instructionAccounting) if (segment.classification === 'clause') segment.stepId = steps.get(segment.stepId)!;
  return copy;
}

