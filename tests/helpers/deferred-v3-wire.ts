import type { TestSpecV6V2 } from '../../app/domain/test-spec-v6-v2.js';
import type { NativeOptionVerificationGoalV2 } from '../../app/domain/native-option-verification-goal.js';

type Step = TestSpecV6V2['steps'][number];
type Span = { start: number; end: number };
/** Fixture conversion only. Production derives all spans from text, never from these stored test fixtures. */
function nativeClaimAccounting(step: NativeOptionVerificationGoalV2) {
  const source = step.sourceText;
  const claims: { span: Span; classification: 'option' | 'control'; controlIndex: number | null }[] = [
    { span: step.claim.optionSourceSpan, classification: 'option', controlIndex: null },
    ...step.claim.controlConstraints.map((item, controlIndex) =>
      ({ span: item.sourceSpan, classification: 'control' as const, controlIndex })),
  ];
  claims.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const partition: { classification: 'option' | 'control' | 'neutral'; authoredText: string; controlIndex: number | null }[] = [];
  let cursor = 0;
  for (const item of claims) {
    if (item.span.start > cursor) partition.push({ classification: 'neutral',
      authoredText: source.slice(cursor, item.span.start), controlIndex: null });
    if (item.span.start < cursor) continue; // malformed overlap remains a missing owner in the wire
    partition.push({ classification: item.classification,
      authoredText: source.slice(item.span.start, item.span.end), controlIndex: item.controlIndex });
    cursor = item.span.end;
  }
  if (cursor < source.length) partition.push({ classification: 'neutral', authoredText: source.slice(cursor), controlIndex: null });
  return partition;
}
export function unspannedStepV3(step: Step): unknown {
  const { sourceInstructionSpan: _instructionSpan, ...base } = step;
  if (step.type === 'action_goal') return { ...base, sourceAccounting: step.sourceAccounting.map(
    ({ sourceSpan: _span, ...segment }) => segment) };
  if (step.type !== 'verification_goal') return base;
  if ('verificationVersion' in step) {
    const { optionSourceSpan: _optionSpan, controlConstraints, ...claim } = step.claim;
    return { ...base, dependsOnStepId: step.dependsOnStepId ?? null, claim: { ...claim,
      controlConstraints: controlConstraints.map(({ sourceSpan: _span, ...item }) => item),
      claimAccounting: nativeClaimAccounting(step) } };
  }
  const subject = step.subject ? { role: step.subject.role ?? null,
    accessibleName: step.subject.accessibleName ?? null, scope: step.subject.scope ?? null } : null;
  return { ...base, subject, intent: step.intent ?? null, dependsOnStepId: step.dependsOnStepId ?? null };
}
/** Historical V4 provider conversion; canonical fixtures retain exact trusted strings. */
export function unspannedStepV4(step: Step): unknown {
  const base = unspannedStepV3(step) as Record<string, unknown>;
  const { sourceText: _sourceText, ...untexted } = base;
  if (step.type === 'action_goal') {
    return { ...untexted,
      obligations: (untexted.obligations as Record<string, unknown>[]).map(({ authoredText: _text, ...obligation }) => obligation),
      anchors: (untexted.anchors as Record<string, unknown>[]).map(({ authoredText: _text, ...anchor }) => anchor) };
  }
  if (step.type !== 'verification_goal') return untexted;
  const { instruction: _instruction, ...verification } = untexted;
  if (!('verificationVersion' in step)) return verification;
  const { optionLabel: _optionLabel, controlConstraints, ...claim } = verification.claim as Record<string, unknown>;
  return { ...verification, claim: { ...claim,
    controlConstraints: (controlConstraints as Record<string, unknown>[]).map(({ text: _text, ...constraint }) => constraint) } };
}
export function unspannedWireV3(spec: TestSpecV6V2, kind: 'primary' | 'independent'): unknown {
  const instructionAccounting = spec.instructionAccounting.map(({ sourceSpan: _span, ...item }) => item);
  const steps = spec.steps.map(unspannedStepV3);
  return { response: kind === 'primary' ? { kind: 'extraction', steps, instructionAccounting } :
    { kind: 'source_extraction', clauses: steps, instructionAccounting } };
}
export function unspannedWireV4(spec: TestSpecV6V2, kind: 'primary' | 'independent'): unknown {
  const instructionAccounting = spec.instructionAccounting.map(({ sourceSpan: _span, ...item }) => item);
  const steps = spec.steps.map(unspannedStepV4);
  return { response: kind === 'primary' ? { kind: 'extraction', steps, instructionAccounting } :
    { kind: 'source_extraction', clauses: steps, instructionAccounting } };
}
export function unspannedStep(step: Step): unknown {
  const base = unspannedStepV4(step) as Record<string, unknown>;
  if (step.type !== 'action_goal') return base;
  const { sourceStepId: _sourceStepId, ...goal } = base;
  return { ...goal, sourceAccounting: (goal.sourceAccounting as Record<string, unknown>[]).map(
    ({ obligationIds: _owners, ...segment }) => segment) };
}
export function forwardInstructionAccounting(accounting: TestSpecV6V2['instructionAccounting']): unknown[] {
  return accounting.map((item) => {
    const { sourceSpan: _span, ...segment } = item;
    if (segment.classification !== 'clause') return segment;
    const { stepId: _stepId, ...clause } = segment;
    return clause;
  });
}
export function unspannedWire(spec: TestSpecV6V2, kind: 'primary' | 'independent'): unknown {
  const instructionAccounting = forwardInstructionAccounting(spec.instructionAccounting);
  const steps = spec.steps.map(unspannedStep);
  return { response: kind === 'primary' ? { kind: 'extraction', steps, instructionAccounting } :
    { kind: 'source_extraction', clauses: steps, instructionAccounting } };
}
export function unspannedDecision(source: string, response: {
  kind: 'authored_ambiguity' | 'unresolved'; reasonCode: string;
  sourceEvidence: readonly { sourceSpan: Span; authoredText: string }[];
}): unknown {
  const sourcePartition: { classification: 'evidence' | 'neutral'; authoredText: string }[] = [];
  let cursor = 0;
  for (const item of response.sourceEvidence) {
    if (item.sourceSpan.start > cursor) sourcePartition.push({ classification: 'neutral',
      authoredText: source.slice(cursor, item.sourceSpan.start) });
    sourcePartition.push({ classification: 'evidence', authoredText: item.authoredText });
    cursor = item.sourceSpan.end;
  }
  if (cursor < source.length) sourcePartition.push({ classification: 'neutral', authoredText: source.slice(cursor) });
  return { response: { kind: response.kind, reasonCode: response.reasonCode, sourcePartition } };
}
