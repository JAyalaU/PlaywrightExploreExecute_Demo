import { z } from 'zod';
import { parseTestSpecV6V2, type ActionGoalV2, type ActionSourceSegmentV2,
  type ActionObligationV2, type TestSpecV6V2, type TrustedSemanticSourceV2 } from '../domain/index.js';
import { PocSemanticStepSchema, type PocPrimaryResponse } from './deferred-action-poc-wire.js';

type SemanticStep = z.infer<typeof PocSemanticStepSchema>;
type ObligationBody = ActionObligationV2 extends infer T ? T extends ActionObligationV2 ?
  Omit<T, 'id' | 'sourceSegmentIds'> : never : never;
const span = (source: string) => ({ start: 0, end: source.length });

function actionGoal(step: Extract<SemanticStep, { type: 'action_goal' }>, sourceInstruction: string): ActionGoalV2 {
  const sourceAccounting: ActionSourceSegmentV2[] = [];
  const obligations: ActionObligationV2[] = [];
  let offset = 0, nextSegment = 1, nextObligation = 1;
  const atom = (value: string, classification: 'effect' | 'argument' | 'target' | 'context' | 'prerequisite') => {
    if (offset) { sourceAccounting.push({ id: `g${nextSegment++}`, classification: 'neutral',
      authoredText: ' ', sourceSpan: { start: offset, end: offset + 1 }, obligationIds: [] }); offset++; }
    const id = `g${nextSegment++}`;
    sourceAccounting.push({ id, classification, authoredText: value,
      sourceSpan: { start: offset, end: offset + value.length }, obligationIds: [] });
    offset += value.length;
    return id;
  };
  const own = (segmentId: string, obligation: ObligationBody) => {
    const id = `o${nextObligation++}`;
    obligations.push({ ...obligation, id, sourceSegmentIds: [segmentId] } as ActionObligationV2);
    const segment = sourceAccounting.find((item) => item.id === segmentId)!;
    if (segment.classification !== 'neutral' && segment.classification !== 'unresolved') segment.obligationIds.push(id);
  };
  const verb = step.explicitOperation && step.explicitOperation !== 'unsupported' ? step.explicitOperation :
    step.effect === 'activate' ? 'click' : step.effect === 'enter_text' ? 'fill' : 'select_option';
  const effectSegment = atom(verb, 'effect');
  own(effectSegment, { kind: 'effect', effect: step.effect });
  if (step.explicitOperation === 'unsupported') own(effectSegment, { kind: 'unsupported_operation' });
  else if (step.explicitOperation) own(effectSegment, { kind: 'operation', operation: step.explicitOperation });
  for (const constraint of step.targetConstraints) {
    const classification = constraint.kind === 'context' ? 'context' : 'target';
    const segmentId = atom(constraint.value, classification);
    own(segmentId, { kind: 'constraint', constraint: constraint.kind, subject: { kind: 'target' },
      polarity: constraint.polarity, authoredText: constraint.value });
  }
  if (step.argument) {
    const segmentId = atom(step.argument.value, 'argument');
    own(segmentId, { kind: 'argument', purpose: step.argument.purpose, authoredText: step.argument.value });
  }
  if (step.dependsOnStepId) {
    const segmentId = atom(step.dependsOnStepId, 'prerequisite');
    own(segmentId, { kind: 'prerequisite', dependsOnStepId: step.dependsOnStepId, authoredText: step.dependsOnStepId });
  }
  return { id: step.id, type: 'action_goal', goalVersion: '2', sourceMode: 'semantic_poc',
    sourceStepId: step.id, sourceText: sourceAccounting.map((item) => item.authoredText).join(''),
    sourceInstructionSpan: span(sourceInstruction), sourceAccounting, anchors: [], obligations };
}

function normalizeStep(step: SemanticStep, sourceInstruction: string): TestSpecV6V2['steps'][number] {
  const sourceInstructionSpan = span(sourceInstruction);
  if (step.type === 'navigate') return { id: step.id, type: 'navigate', url: step.url,
    sourceText: `Go to ${step.url}`, sourceInstructionSpan };
  if (step.type === 'action_goal') return actionGoal(step, sourceInstruction);
  if (step.verificationVersion === null) return { id: step.id, type: 'verification_goal',
    sourceText: step.instruction, instruction: step.instruction, sourceInstructionSpan,
    ...(step.subject === null ? {} : { subject: step.subject }),
    ...(step.intent === null ? {} : { intent: step.intent }),
    ...(step.dependsOnStepId === null ? {} : { dependsOnStepId: step.dependsOnStepId }) };
  const optionPrefix = 'Verify ';
  const predicate = step.expectedSelected ? ' is selected' : ' is not selected';
  let sourceText = `${optionPrefix}${step.optionLabel}${predicate}`;
  const optionSourceSpan = { start: optionPrefix.length, end: optionPrefix.length + step.optionLabel.length };
  const controlConstraints = step.controlConstraints.map((constraint) => {
    sourceText += ' on ';
    const sourceSpan = { start: sourceText.length, end: sourceText.length + constraint.text.length };
    sourceText += constraint.text;
    return { ...constraint, sourceSpan };
  });
  return { id: step.id, type: 'verification_goal', verificationVersion: '2', sourceText,
    instruction: sourceText, sourceInstructionSpan,
    ...(step.dependsOnStepId === null ? {} : { dependsOnStepId: step.dependsOnStepId }),
    claim: { kind: 'native_owned_option_selected', optionLabel: step.optionLabel,
      optionSourceSpan, expectedSelected: step.expectedSelected, controlConstraints } };
}

/** Trusted derivation of the downstream graph. No provider source spans or duplicate source copy. */
export function normalizePocSemanticExtraction(source: TrustedSemanticSourceV2,
  response: Extract<PocPrimaryResponse, { kind: 'extraction' }>): TestSpecV6V2 {
  const spec = { ...source, schemaVersion: '6' as const, sourceContractVersion: '2' as const,
    semanticMode: 'poc_v1' as const, steps: response.steps.map((step) => normalizeStep(step, source.sourceInstruction)),
    instructionAccounting: [] };
  return parseTestSpecV6V2(spec);
}

/** Deliberately omit generated source bookkeeping and all private provider fields. */
export function pocReviewerProjection(spec: TestSpecV6V2): unknown {
  const target = (constraints: { kind: 'role' | 'name' | 'context' | 'uniqueness'; value: string;
    polarity: 'positive' | 'negative' }[]) => ({
    controlTypeOrRole: constraints.filter((item) => item.kind === 'role').map(({ value, polarity }) => ({ value, polarity })),
    exactAccessibleNameOrText: constraints.filter((item) => item.kind === 'name').map(({ value, polarity }) => ({ value, polarity })),
    context: constraints.filter((item) => item.kind === 'context').map(({ value, polarity }) => ({ value, polarity })),
    uniqueness: constraints.filter((item) => item.kind === 'uniqueness').map(({ value, polarity }) => ({ value, polarity })),
  });
  return { steps: spec.steps.map((step) => step.type === 'navigate' ? { id: step.id, type: step.type, url: step.url } :
    step.type === 'verification_goal' ? 'verificationVersion' in step ?
      { id: step.id, type: step.type, verificationVersion: '2', optionLabel: step.claim.optionLabel,
        expectedSelected: step.claim.expectedSelected,
        ownerControl: {
          controlTypeOrRole: step.claim.controlConstraints.filter((item) => item.kind === 'role').map((item) => item.text),
          exactAccessibleName: step.claim.controlConstraints.filter((item) => item.kind === 'name').map((item) => item.text),
          explicitLabel: step.claim.controlConstraints.filter((item) => item.kind === 'label').map((item) => item.text),
        },
        dependsOnStepId: step.dependsOnStepId ?? null } :
      { id: step.id, type: step.type, instruction: step.instruction, subject: step.subject ?? null,
        intent: step.intent ?? null, dependsOnStepId: step.dependsOnStepId ?? null } :
    { id: step.id, type: step.type,
      effect: step.obligations.find((item) => item.kind === 'effect')?.effect,
      operation: (() => { const item = step.obligations.find((value) => value.kind === 'operation' || value.kind === 'unsupported_operation');
        return item?.kind === 'operation' ? item.operation : item?.kind === 'unsupported_operation' ? 'unsupported' : null; })(),
      argument: (() => { const item = step.obligations.find((value) => value.kind === 'argument');
        return item?.kind === 'argument' ? { purpose: item.purpose, value: item.authoredText } : null; })(),
      target: target(step.obligations.flatMap((item) => item.kind === 'constraint' && item.subject.kind === 'target' ?
        [{ kind: item.constraint, value: item.authoredText, polarity: item.polarity }] : [])),
      dependsOnStepId: (() => { const item = step.obligations.find((value) => value.kind === 'prerequisite');
        return item?.kind === 'prerequisite' ? item.dependsOnStepId : null; })() }) };
}
