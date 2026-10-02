import { admitPocSemanticFidelityV2, buildActionObligationHandoffV2, SemanticAdmissionError,
  TrustedSemanticSourceV2Schema, type TestSpecV6V2, type TrustedSemanticAdmissionV2 } from '../domain/index.js';
import { DeferredInterpretationTimingV1Schema, type DeferredInterpretationTimingV1 } from '../domain/deferred-interpretation-timing.js';
import type { DeferredInterpretationStructuralV1 } from '../domain/deferred-interpretation-structural.js';
import type { InterpretationRequest } from './interpret.js';
import { ModelCompletionFailure } from './model-failure.js';
import { ActionSemanticInterpretationStopV2Schema, DEFERRED_INTERPRETATION_DEADLINE_POLICY,
  type ActionSemanticInterpretationStopV2 } from './deferred-action-v2-interpret.js';
import { PocFidelityWireSchema, PocPrimaryWireSchema, type PocFidelityVerdict } from './deferred-action-poc-wire.js';
import { normalizePocSemanticExtraction, pocReviewerProjection } from './deferred-action-poc-normalize.js';
import { liveProviderDebugEnabled, recordLiveAdmission } from './deferred-action-v2-live-debug.js';

export const POC_PRIMARY_SYSTEM_INSTRUCTION = [
  'Extract the user instruction into the closed semantic step schema. Return only the requested JSON.',
  'Actions are intended mutations. Verification goals are observations/assertions even when phrased imperatively.',
  'Represent navigation URLs, target role/name/context, entered text, option labels, dependencies, and polarity exactly when explicit.',
  'Keep target control type or role, accessible name/text/label, and surrounding context distinct. Generic UI nouns such as dropdown, link, button, textbox/input, checkbox, radio button, and menu identify a control category; they do not by themselves assert an exact accessible name.',
  'Emit an exact name constraint only when the instruction actually identifies the target by name, text, or label (for example, a link with text "Dropdown", a button named "Save", or a field labeled "Country"). Preserve authored context separately; never turn a control-category noun into a name.',
  'For native selected-option verification, controlConstraints constrain the owner control only when that verification assertion itself identifies the owner; do not copy a prior action target into the assertion. Use dependsOnStepId for a stated dependency. An assertion such as "Verify that Option 1 is selected" has no owner constraint.',
  'Native verification role constraints use the reviewed runtime roles combobox or listbox only when the assertion explicitly identifies that control type. Never put the source noun dropdown in a native verification role or exact name. The preceding selection action may retain its authored dropdown role.',
  'Use verificationVersion 2 for native selected-option checks. Use an ordinary verification instruction for other observations, including resulting URLs.',
  'Do not copy source spans, source partitions, list numbering, punctuation or whitespace merely for bookkeeping.',
  'Never invent browser state, accessible names, executable selectors, or actions. Return unresolved when material meaning cannot be represented.',
].join('\n');
export const POC_FIDELITY_SYSTEM_INSTRUCTION = [
  'You are a fresh semantic fidelity reviewer. Compare only the original instruction and the supplied normalized structured TestSpec.',
  'Return faithful with no issues only when every action and assertion is represented, ordering/dependencies and explicit targets are preserved,',
  'URLs, option names, entered values, labels, and negations are materially unchanged, and no material extra action/assertion was invented.',
  'Compare target control type/role, exact accessible name/text/label, and context separately. An invented exact name or label is a material narrowing, including when a generic control noun is copied as a name. Dropping an authored name or label, or materially broadening or narrowing a target, is also not faithful.',
  'Apply this check to both action targets and native selected-option verification owner constraints. Do not infer a name from browser state.',
  'A selected-option assertion that refers to the preceding selection can preserve that relationship with dependsOnStepId. If the assertion itself states no owner name, label, or role, an empty ownerControl constraint set is faithful; do not require a duplicate of the preceding action target. Check that the referenced selection and option label agree.',
  'Ignore punctuation, whitespace, list numbering/bullets, capitalization where not material, harmless paraphrases, and formatting differences.',
  'Return not_faithful with one to eight bounded diagnostic issues for any material omission, addition, changed value, polarity, or order.',
  'Do not infer browser state. Do not approve merely because the output is syntactically valid.',
].join('\n');

type Model = { complete(input: { systemInstruction: string; userInstruction: string; signal: AbortSignal;
  onProviderCompleted?: (state?: 'completed' | 'incomplete' | 'unavailable') => void;
  onStructuralIssue?: (issue: DeferredInterpretationStructuralV1) => void }): Promise<string> };
export interface PocSemanticModels { primary: Model; reviewer: Model }
type Rejection = { kind: 'rejected'; stop: ActionSemanticInterpretationStopV2; timing?: DeferredInterpretationTimingV1;
  sourceInstruction: string; fidelityIssues?: PocFidelityVerdict['issues'];
  structuralDiagnostic?: DeferredInterpretationStructuralV1 };
export type PocSemanticOutcome = { kind: 'accepted'; admission: TrustedSemanticAdmissionV2;
  testSpec: TrustedSemanticAdmissionV2['spec']; handoff: ReturnType<typeof buildActionObligationHandoffV2>;
  timing: DeferredInterpretationTimingV1 } | Rejection;
const measured = (n: number) => Math.min(86_400_000, Math.max(0, Math.floor(n)));

function stop(sourceInstruction: string, stage: 'primary' | 'independent' | 'admission',
  code: ActionSemanticInterpretationStopV2['code'], category: ActionSemanticInterpretationStopV2['category'],
  timing?: DeferredInterpretationTimingV1, fidelityIssues?: PocFidelityVerdict['issues'],
  structuralDiagnostic?: DeferredInterpretationStructuralV1): Rejection {
  const explanation = category === 'omission_fidelity' ? 'The semantic fidelity review found a material mismatch.' :
    category === 'structural' ? 'The structured extraction is invalid.' :
    category === 'unresolved' ? 'Material instruction meaning is unresolved.' :
    category === 'provider' ? 'The required model call could not complete.' :
    category === 'environment' ? 'The interpretation environment stopped.' :
    category === 'authored_ambiguity' ? 'The instruction contains material ambiguity.' :
    'The extracted operation or constraint is unsupported.';
  return { kind: 'rejected', sourceInstruction,
    stop: ActionSemanticInterpretationStopV2Schema.parse({ stopVersion: '2', stage, category, code,
      retryable: ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_INCOMPLETE', 'EXTRACTION_DEADLINE'].includes(code),
      explanation, ...(category === 'omission_fidelity' ? { detail: 'OBLIGATION_SET_MISMATCH' } : {}) }),
    ...(timing ? { timing } : {}), ...(fidelityIssues ? { fidelityIssues } : {}),
    ...(structuralDiagnostic ? { structuralDiagnostic } : {}) };
}

/** Cheap exact-literal safeguards complement, rather than replace, the semantic reviewer. */
export function pocMaterialLiteralMismatch(source: string, spec: TestSpecV6V2): boolean {
  const urls = [...source.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]!.replace(/[.,;!?]+$/, ''));
  const authoredChoices = [...source.matchAll(/\b(?:select|choose)\s+(Option\s+\d+)\b/gi)].map((match) => match[1]!);
  const authoredEnteredValues = [...source.matchAll(/\b(?:enter|fill|type)\s+(?:the\s+)?(?:text\s+)?["']([^"'\r\n]{1,512})["']/gi)]
    .map((match) => match[1]!);
  const semantic = spec.steps.flatMap((step) => step.type === 'navigate' ? [step.url] :
    step.type === 'action_goal' ? step.obligations.flatMap((item) => 'authoredText' in item ? [item.authoredText] : []) :
    'verificationVersion' in step ? [step.claim.optionLabel, ...step.claim.controlConstraints.map((item) => item.text)] :
      [step.instruction, step.subject?.accessibleName ?? '']);
  const extractedChoices = spec.steps.filter((step) => step.type === 'action_goal').flatMap((step) =>
    step.obligations.flatMap((item) => item.kind === 'argument' && item.purpose === 'choice' ? [item.authoredText] : []));
  const extractedEnteredValues = spec.steps.filter((step) => step.type === 'action_goal').flatMap((step) =>
    step.obligations.flatMap((item) => item.kind === 'argument' && item.purpose === 'entered_text' ? [item.authoredText] : []));
  return [...new Set(urls)].some((value) => !semantic.some((item) => item.includes(value))) ||
    authoredChoices.some((value, index) =>
      value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ') !==
      extractedChoices[index]?.toLocaleLowerCase('en-US').replace(/\s+/g, ' ')) ||
    authoredEnteredValues.some((value, index) => extractedEnteredValues[index] !== value);
}

/** The sole active PoC issuer path. The second call sees no primary reasoning or browser state. */
export async function interpretDeferredActionTaskPoc(request: InterpretationRequest, models: PocSemanticModels,
  options: { perCallTimeoutMs?: number; totalTimeoutMs?: number; maxResponseChars?: number; signal?: AbortSignal } = {}): Promise<PocSemanticOutcome> {
  let source;
  try { source = TrustedSemanticSourceV2Schema.parse(request); }
  catch { return stop(typeof request.sourceInstruction === 'string' ? request.sourceInstruction : '', 'primary',
    'INVALID_SOURCE_REPRESENTATION', 'structural'); }
  const perCall = options.perCallTimeoutMs ?? DEFERRED_INTERPRETATION_DEADLINE_POLICY.perCallMs;
  const shared = options.totalTimeoutMs ?? DEFERRED_INTERPRETATION_DEADLINE_POLICY.sharedMs;
  const maxChars = options.maxResponseChars ?? 65_536;
  if (!Number.isSafeInteger(perCall) || perCall < 1 || perCall > 240_000 ||
      !Number.isSafeInteger(shared) || shared < 1 || shared > 900_000 ||
      !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 262_144)
    throw new Error('Invalid extraction bounds');
  const started = performance.now(), deadline = started + shared;
  const phases: DeferredInterpretationTimingV1['phases'] = [];
  const attempts: NonNullable<DeferredInterpretationTimingV1['attempts']> = [];
  let stage: 'primary' | 'independent' | 'admission' = 'primary';
  let phaseStart = started, allowed = Math.min(perCall, shared), remainingAtStart = shared;
  let completed = false, origin: DeferredInterpretationTimingV1['deadlineOrigin'] = 'none';
  let structuralDiagnostic: DeferredInterpretationStructuralV1 | undefined;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const row = () => ({ phase: stage, elapsedMs: measured(performance.now() - phaseStart), allowedMs: allowed,
    remainingAtStartMs: remainingAtStart, providerCompletedBeforeBoundary: completed, deadlineOrigin: origin });
  const timing = () => { const last = row(); return DeferredInterpretationTimingV1Schema.parse({ diagnosticVersion: '1',
    phase: stage, phaseElapsedMs: last.elapsedMs, totalElapsedMs: measured(performance.now() - started),
    perCallLimitMs: perCall, sharedLimitMs: shared, remainingMs: Math.min(shared, remaining()),
    providerCompletedBeforeBoundary: completed, deadlineOrigin: origin, phases: [...phases, last], attempts }); };
  const begin = (next: typeof stage) => { phases.push(row()); stage = next; phaseStart = performance.now();
    remainingAtStart = Math.min(shared, remaining()); allowed = Math.min(perCall, remainingAtStart);
    completed = false; origin = 'none'; };
  const run = async (model: Model, systemInstruction: string, userInstruction: string, phase: 'primary' | 'independent') => {
    let last: unknown;
    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      if (options.signal?.aborted) { origin = 'cancellation'; throw new Error('INTERPRETATION_CANCELLED'); }
      const attemptStart = performance.now(), left = remaining(), cap = Math.min(perCall, left);
      if (cap < 1) { origin = 'shared'; throw new Error('EXTRACTION_DEADLINE'); }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectCancellation: ((reason?: unknown) => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
      const onAbort = () => { controller.abort(); rejectCancellation?.(new Error('INTERPRETATION_CANCELLED')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      let providerState: 'completed' | 'incomplete' | 'unavailable' = 'unavailable';
      structuralDiagnostic = undefined;
      try {
        const output = await Promise.race([model.complete({ systemInstruction, userInstruction, signal: controller.signal,
          onProviderCompleted: (state) => { providerState = state ?? 'unavailable'; completed = true; },
          onStructuralIssue: (issue) => { structuralDiagnostic = issue; } }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('EXTRACTION_DEADLINE')); }, cap); }),
          cancelled]);
        if (options.signal?.aborted) { origin = 'cancellation'; throw new Error('INTERPRETATION_CANCELLED'); }
        if (typeof output !== 'string' || output.length > maxChars) throw new Error('INVALID_SOURCE_REPRESENTATION');
        let parsed: unknown;
        try { parsed = JSON.parse(output) as unknown; }
        catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); }
        const result = phase === 'primary' ? PocPrimaryWireSchema.parse(parsed) : PocFidelityWireSchema.parse(parsed);
        attempts.push({ phase, attempt: ordinal as 1 | 2, elapsedMs: measured(performance.now() - attemptStart),
          allowedMs: cap, remainingAtStartMs: left, providerCompletedBeforeBoundary: completed,
          providerResponseState: providerState, outcome: 'valid_extraction' });
        return result;
      } catch (error) {
        last = error;
        if (error instanceof Error && error.message === 'INTERPRETATION_CANCELLED') origin = 'cancellation';
        if (error instanceof Error && error.message === 'EXTRACTION_DEADLINE') origin = left <= perCall ? 'shared' : 'per_call';
        const malformed = error instanceof ModelCompletionFailure && error.completedMalformedOutput;
        attempts.push({ phase, attempt: ordinal as 1 | 2, elapsedMs: measured(performance.now() - attemptStart),
          allowedMs: cap, remainingAtStartMs: left, providerCompletedBeforeBoundary: completed,
          providerResponseState: providerState, outcome: malformed ? 'invalid_wire' :
            error instanceof Error && error.message === 'EXTRACTION_DEADLINE' ? 'deadline' :
              error instanceof Error && error.message === 'INTERPRETATION_CANCELLED' ? 'cancelled' :
                error instanceof ModelCompletionFailure && !structuralDiagnostic ? 'provider_stop' : 'invalid_structure' });
        if (!(malformed && ordinal === 1 && remaining() >= (phase === 'primary' ? 3 : 1) * perCall)) break;
      } finally { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
    }
    throw last;
  };
  let outcome: PocSemanticOutcome;
  try {
    const primary = PocPrimaryWireSchema.parse(await run(models.primary, POC_PRIMARY_SYSTEM_INSTRUCTION,
      source.sourceInstruction, 'primary'));
    if (primary.response.kind !== 'extraction') {
      outcome = stop(source.sourceInstruction, 'primary', primary.response.kind === 'unresolved' ?
        'SEMANTIC_INTERPRETATION_UNRESOLVED' : 'AUTHORED_AMBIGUITY',
      primary.response.kind === 'unresolved' ? 'unresolved' : 'authored_ambiguity', timing());
    } else {
      const spec = normalizePocSemanticExtraction(source, primary.response);
      begin('independent');
      const reviewerInput = JSON.stringify({ originalInstruction: source.sourceInstruction,
        testSpec: pocReviewerProjection(spec) });
      const reviewer = PocFidelityWireSchema.parse(await run(models.reviewer, POC_FIDELITY_SYSTEM_INSTRUCTION,
        reviewerInput, 'independent'));
      const verdict = reviewer.response;
      if (verdict.verdict === 'faithful' && verdict.issues.length ||
          verdict.verdict === 'not_faithful' && !verdict.issues.length)
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID');
      begin('admission');
      if (verdict.verdict !== 'faithful' || verdict.issues.length)
        outcome = stop(source.sourceInstruction, stage, 'SEMANTIC_FIDELITY_MISMATCH', 'omission_fidelity', timing(), verdict.issues);
      else if (pocMaterialLiteralMismatch(source.sourceInstruction, spec))
        outcome = stop(source.sourceInstruction, stage, 'SEMANTIC_FIDELITY_MISMATCH', 'omission_fidelity', timing(),
          [{ kind: 'changed_literal', sourceStep: null, summary: 'An explicit authored literal is missing or changed.' }]);
      else {
        const admission = admitPocSemanticFidelityV2(source, spec, verdict);
        outcome = { kind: 'accepted', admission, testSpec: admission.spec,
          handoff: buildActionObligationHandoffV2(admission), timing: timing() };
      }
    }
  } catch (error) {
    const code = error instanceof ModelCompletionFailure ? error.code :
      error instanceof SemanticAdmissionError ? error.code :
        error instanceof Error && error.message === 'INTERPRETATION_CANCELLED' ? 'INTERPRETATION_CANCELLED' :
          error instanceof Error && error.message === 'EXTRACTION_DEADLINE' ? 'EXTRACTION_DEADLINE' :
            (stage as 'primary' | 'independent' | 'admission') === 'independent' ? 'PROVIDER_OUTPUT_INVALID' : 'INVALID_SOURCE_REPRESENTATION';
    const category = error instanceof SemanticAdmissionError ? code === 'SEMANTIC_FIDELITY_MISMATCH' ? 'omission_fidelity' :
      code === 'UNSUPPORTED_AUTHORED_OPERATION' ? 'unsupported_operation' :
        code === 'UNSUPPORTED_AUTHORED_CONSTRAINT' ? 'unsupported_constraint' : 'structural' :
      code === 'INTERPRETATION_CANCELLED' || code === 'EXTRACTION_DEADLINE' ? 'environment' :
        (stage as 'primary' | 'independent' | 'admission') === 'independent' ? 'provider' :
          error instanceof ModelCompletionFailure ? code === 'PROVIDER_OUTPUT_INVALID' || code === 'PROVIDER_RESPONSE_TOO_LARGE' ?
            'structural' : 'provider' : 'structural';
    outcome = stop(source.sourceInstruction, stage, code, category, timing(), undefined, structuralDiagnostic);
  }
  if (liveProviderDebugEnabled()) recordLiveAdmission({ testSpecId: source.testSpecId,
    finalKind: outcome.kind, ...(outcome.kind === 'rejected' ? { stage: outcome.stop.stage,
      rejectionCategory: outcome.stop.category, rejectionCode: outcome.stop.code } : {}),
    knownContributingPhases: outcome.kind === 'rejected' && outcome.stop.stage !== 'admission' ?
      [outcome.stop.stage] : outcome.kind === 'rejected' ? ['primary', 'independent'] : [] });
  return outcome;
}
