import { z } from 'zod';
import { ContractValidationError } from '../domain/validate.js';
import { TestSpecV6V2Schema } from '../domain/test-spec-v6-v2.js';
import { exactSourceSpan, validateActionGoalV2 } from '../domain/action-goal-v2.js';
import { validateNativeOptionVerificationGoalV2 } from '../domain/native-option-verification-goal.js';
import { ForwardActionGoalV5Schema, UnspannedNativeVerificationV4Schema } from './deferred-action-v2-wire.js';
import { verificationGoalFidelity } from '../domain/verification-goal.js';
import { DeferredInterpretationStructuralV1Schema, STRUCTURAL_VALIDATOR_CODES,
  type DeferredInterpretationStructuralV1 } from '../domain/deferred-interpretation-structural.js';

type Phase = DeferredInterpretationStructuralV1['phase'];
type Field = DeferredInterpretationStructuralV1['path']['field'];
const fields = new Set<Field>(['response', 'steps', 'instructionAccounting', 'sourceInstructionSpan',
  'sourceAccounting', 'sourceSpan', 'obligations', 'anchors', 'claim', 'goalVersion',
  'verificationVersion', 'sourceContractVersion', 'schemaVersion']);
const versionFields = new Set(['goalVersion', 'verificationVersion', 'sourceContractVersion', 'schemaVersion']);
const knownReasons = new Set<string>(STRUCTURAL_VALIDATOR_CODES);
const record = (value: DeferredInterpretationStructuralV1): DeferredInterpretationStructuralV1 =>
  DeferredInterpretationStructuralV1Schema.parse(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const boundedIndex = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;

/** Only Zod's stable issue code and a closed structural path survive. Never persist issue messages or values. */
export function diagnoseZodStructure(error: unknown, phase: Phase, component: 'wire_normalization' | 'response_shape' | 'test_spec',
  raw?: unknown): DeferredInterpretationStructuralV1 {
  if (!(error instanceof z.ZodError) || !error.issues.length) return record({ diagnosticVersion: '1', phase,
    component, issueCode: 'INVALID_JSON', violationCategory: 'wire_shape', path: { field: 'response' } });
  const original = error.issues[0]!;
  const originalStepKey = original.path.findIndex((part) => part === 'steps' || part === 'clauses');
  const stepIndex = originalStepKey >= 0 ? boundedIndex(original.path[originalStepKey + 1], 99) : undefined;
  const root = object(raw), response = component === 'wire_normalization' ? object(root?.response) : root;
  const step = stepIndex !== undefined ? (response?.steps ?? response?.clauses) : undefined;
  const stepValue = Array.isArray(step) ? step[stepIndex!] : undefined;
  const stepType = ['navigate', 'action_goal', 'verification_goal'].includes(object(stepValue)?.type as string) ?
    object(stepValue)!.type as 'navigate' | 'action_goal' | 'verification_goal' : undefined;
  const focused = stepType === 'action_goal' ? ForwardActionGoalV5Schema.safeParse(stepValue) :
    stepType === 'verification_goal' && object(stepValue)?.verificationVersion !== undefined ?
      UnspannedNativeVerificationV4Schema.safeParse(stepValue) : undefined;
  const focusIssue = focused && !focused.success ? focused.error.issues[0] : undefined;
  const issue = focusIssue ?? original;
  const path = focusIssue && stepIndex !== undefined ? ['steps', stepIndex, ...focusIssue.path] : original.path;
  const field = [...path].reverse().find((part): part is Field => typeof part === 'string' && fields.has(part as Field)) ?? 'other';
  const stepKey = path.findIndex((part) => part === 'steps' || part === 'clauses');
  const itemIndex = boundedIndex(path.find((part, i) => typeof part === 'number' && i !== stepKey + 1), 300);
  const unknownField = issue.code === 'unrecognized_keys';
  const unknownVersion = versionFields.has(field) && issue.code === 'invalid_value';
  const issueCode = unknownField ? 'UNKNOWN_FIELD' : unknownVersion ? 'UNKNOWN_VERSION' :
    issue.code === 'invalid_type' ? 'INVALID_TYPE' : issue.code === 'too_big' || issue.code === 'too_small' ? 'INVALID_BOUND' : 'INVALID_VALUE';
  const violationCategory = unknownField ? 'unknown_field' : unknownVersion ? 'unknown_version' :
    issueCode === 'INVALID_TYPE' ? 'type' : issueCode === 'INVALID_BOUND' ? 'bound' : 'wire_shape';
  return record({ diagnosticVersion: '1', phase, component, issueCode, violationCategory,
    path: { field, ...(stepIndex !== undefined ? { stepIndex } : {}), ...(stepType ? { stepType } : {}),
      ...(itemIndex !== undefined ? { itemIndex } : {}) } });
}

/** Attribution is read-only and runs only after the existing validator has rejected the draft. */
export function diagnoseSourceStructure(error: unknown, phase: Phase, raw: unknown): DeferredInterpretationStructuralV1 {
  const match = error instanceof ContractValidationError ? /^INVALID_SOURCE_REPRESENTATION: ([A-Z_]+)$/.exec(error.message) : null;
  const reason = match && knownReasons.has(match[1]!) ? match[1]! : undefined;
  if (!reason) return error instanceof z.ZodError ? diagnoseZodStructure(error, phase, 'test_spec', raw) :
    record({ diagnosticVersion: '1', phase, component: 'test_spec', issueCode: 'OTHER_STRUCTURAL',
      violationCategory: 'graph', path: { field: 'other' } });
  const parsed = TestSpecV6V2Schema.safeParse(raw);
  let stepIndex: number | undefined, stepType: 'navigate' | 'action_goal' | 'verification_goal' | undefined;
  let field: Field = 'other'; let itemIndex: number | undefined;
  let component: DeferredInterpretationStructuralV1['component'] = 'test_spec';
  let instructionSpanFailed = false;
  if (parsed.success && reason === 'SPAN_OR_LITERAL_MISMATCH') {
    for (const [i, segment] of parsed.data.instructionAccounting.entries()) {
      try { exactSourceSpan(parsed.data.sourceInstruction, segment.sourceSpan, segment.authoredText); }
      catch { itemIndex = i; instructionSpanFailed = true; break; }
    }
  }
  if (reason.includes('INSTRUCTION') || reason === 'CLAUSE_OWNERSHIP_OR_ORDER' || reason === 'DUPLICATE_STEP_ID') {
    component = 'source_accounting'; field = 'instructionAccounting';
    if (parsed.success) {
      let end = 0;
      for (const [i, segment] of parsed.data.instructionAccounting.entries()) {
        try { exactSourceSpan(parsed.data.sourceInstruction, segment.sourceSpan, segment.authoredText); }
        catch { itemIndex = i; break; }
        if (segment.sourceSpan.start !== end) { itemIndex = i; break; }
        end = segment.sourceSpan.end;
      }
    }
  } else if (parsed.success && !instructionSpanFailed) {
    for (const [index, step] of parsed.data.steps.entries()) {
      try {
        exactSourceSpan(parsed.data.sourceInstruction, step.sourceInstructionSpan, step.sourceText);
        if (step.type === 'action_goal') validateActionGoalV2(step, parsed.data.sourceInstruction, parsed.data.steps.slice(0, index));
        if (step.type === 'verification_goal') {
          const previous = parsed.data.steps.slice(0, index).map((prior) => prior.id);
          if ('verificationVersion' in step) validateNativeOptionVerificationGoalV2(step, parsed.data.sourceInstruction, previous);
          else if (verificationGoalFidelity(step, parsed.data.sourceInstruction, previous)) throw error;
        }
      } catch {
        stepIndex = index; stepType = step.type; break;
      }
    }
  }
  let authoredArgumentMismatch = false;
  if (parsed.success && stepIndex !== undefined && reason === 'OBLIGATION_NOT_AUTHORED') {
    const goal = parsed.data.steps[stepIndex];
    if (goal?.type === 'action_goal') {
      const segments = new Map(goal.sourceAccounting.map((segment) => [segment.id, segment.authoredText]));
      for (const [i, obligation] of goal.obligations.entries()) {
        if ('authoredText' in obligation && obligation.authoredText !== obligation.sourceSegmentIds.map(id => segments.get(id) ?? '').join('')) {
          itemIndex = i; authoredArgumentMismatch = obligation.kind === 'argument'; break;
        }
      }
    }
  }
  if (reason === 'SPAN_OR_LITERAL_MISMATCH') {
    component = instructionSpanFailed ? 'source_accounting' : 'span_provenance';
    field = instructionSpanFailed ? 'instructionAccounting' : 'sourceSpan';
  }
  else if (stepType === 'verification_goal' || reason.includes('VERIFICATION') || reason.includes('NATIVE')) {
    component = 'verification_goal'; field = 'claim';
  } else if (stepType === 'action_goal' || reason.startsWith('ACTION_') || reason.includes('OBLIGATION') || reason.includes('ANCHOR') ||
    reason.includes('ARGUMENT') || reason.includes('OWNERSHIP') || reason.includes('PROVENANCE')) {
    component = 'action_goal'; field = reason.includes('ANCHOR') ? 'anchors' : reason.includes('SEGMENT') || reason.includes('CLAUSE') ?
      'sourceAccounting' : 'obligations';
  }
  const issueCode: DeferredInterpretationStructuralV1['issueCode'] = instructionSpanFailed ? 'SOURCE_ACCOUNTING_INVALID' :
    reason === 'SPAN_OR_LITERAL_MISMATCH' ? 'SPAN_OR_LITERAL_MISMATCH' :
    component === 'source_accounting' ? 'SOURCE_ACCOUNTING_INVALID' : component === 'verification_goal' ? 'VERIFICATION_SOURCE_INVALID' :
    reason.includes('OWNERSHIP') || reason.includes('OWNER') || reason.includes('ANCHOR') ? 'ACTION_OWNERSHIP_INVALID' :
    reason.includes('PROVENANCE') || reason.includes('SEGMENT') || reason.includes('CLAUSE') ? 'ACTION_PROVENANCE_INVALID' :
    authoredArgumentMismatch || reason.includes('ARGUMENT') || reason.includes('EFFECT') || reason.includes('OPERATION') ? 'ACTION_ARGUMENT_INVALID' :
    reason.includes('LINKAGE') ? 'ACTION_LINKAGE_INVALID' : component === 'action_goal' ? 'ACTION_GRAPH_INVALID' : 'OTHER_STRUCTURAL';
  const violationCategory: DeferredInterpretationStructuralV1['violationCategory'] = component === 'source_accounting' ? 'source_accounting' :
    component === 'verification_goal' ? 'verification' : component === 'span_provenance' ? 'span_provenance' :
    issueCode === 'ACTION_OWNERSHIP_INVALID' ? 'ownership' : issueCode === 'ACTION_ARGUMENT_INVALID' ? 'argument' : 'graph';
  return record({ diagnosticVersion: '1', phase, component, issueCode,
    validatorCode: z.enum(STRUCTURAL_VALIDATOR_CODES).parse(reason), violationCategory,
    path: { field, ...(stepIndex !== undefined ? { stepIndex } : {}), ...(stepType ? { stepType } : {}),
      ...(itemIndex !== undefined ? { itemIndex } : {}) } });
}

export function diagnoseAdmissionStructure(): DeferredInterpretationStructuralV1 {
  return record({ diagnosticVersion: '1', phase: 'admission', component: 'semantic_admission',
    issueCode: 'SEMANTIC_ADMISSION_STRUCTURAL', violationCategory: 'admission', path: { field: 'other' } });
}

export function diagnoseDecisionStructure(error: unknown, phase: Phase): DeferredInterpretationStructuralV1 {
  const exactSpan = error instanceof ContractValidationError &&
    error.message === 'INVALID_SOURCE_REPRESENTATION: SPAN_OR_LITERAL_MISMATCH';
  return record({ diagnosticVersion: '1', phase, component: 'source_accounting',
    issueCode: exactSpan ? 'SPAN_OR_LITERAL_MISMATCH' : 'SOURCE_ACCOUNTING_INVALID',
    ...(exactSpan ? { validatorCode: 'SPAN_OR_LITERAL_MISMATCH' as const } : {}),
    violationCategory: exactSpan ? 'span_provenance' : 'source_accounting',
    path: { field: 'instructionAccounting' } });
}
