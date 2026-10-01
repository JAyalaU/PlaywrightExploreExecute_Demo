import { z } from 'zod';

/** Exact validator rule names, reviewed here so exception text cannot become persisted data. */
export const STRUCTURAL_VALIDATOR_CODES = [
  'SPAN_OR_LITERAL_MISMATCH', 'DUPLICATE_STEP_ID', 'INCOMPLETE_OR_OVERLAPPING_INSTRUCTION_PARTITION',
  'CLAUSE_OWNERSHIP_OR_ORDER', 'INCOMPLETE_INSTRUCTION_ACCOUNTING', 'INVALID_NAVIGATION_SOURCE',
  'AMBIGUOUS_NAVIGATION_CLAUSE', 'ACTION_LINKAGE_MISMATCH', 'DUPLICATE_SEGMENT_ID',
  'DUPLICATE_OBLIGATION_ID', 'DUPLICATE_ANCHOR_ID', 'INCOMPLETE_OR_OVERLAPPING_CLAUSE_PARTITION',
  'DUPLICATE_SEGMENT_OWNER', 'ILLEGAL_SEGMENT_OWNER', 'INCOMPLETE_CLAUSE_PARTITION',
  'DUPLICATE_PROVENANCE_REFERENCE', 'UNKNOWN_OR_UNORDERED_PROVENANCE', 'NONCONTIGUOUS_ARGUMENT_PROVENANCE',
  'ANCHOR_NOT_AUTHORED', 'ILLEGAL_ANCHOR_PROVENANCE', 'UNUSED_ANCHOR', 'OBLIGATION_NOT_AUTHORED',
  'MISSING_RECIPROCAL_OWNERSHIP', 'UNKNOWN_CONSTRAINT_ANCHOR', 'UNKNOWN_RELATIONSHIP_ANCHOR',
  'TARGET_ANCHOR_OWNERSHIP_OVERLAP', 'INVALID_BACKWARD_ACTION_REFERENCE', 'DUPLICATE_CONTRAST_ENDPOINT',
  'INVALID_CONTRAST_ENDPOINT', 'EFFECT_OR_OPERATION_CARDINALITY', 'ARGUMENT_EFFECT_MISMATCH',
  'OPERATION_EFFECT_MISMATCH', 'CONTRADICTORY_NORMALIZED_CONSTRAINTS',
  'TRANSFORMED_NATIVE_VERIFICATION_CLAUSE', 'INVALID_NATIVE_VERIFICATION_DEPENDENCY',
  'DUPLICATE_NATIVE_CONTROL_CONSTRAINT', 'DUPLICATE_NATIVE_CONSTRAINT_OCCURRENCE',
  'CONTRADICTORY_NATIVE_CONTROL_CONSTRAINT', 'OVERLAPPING_OR_UNORDERED_NATIVE_CONTROL_CONSTRAINTS',
  'UNREVIEWED_NATIVE_CHOICE_ROLE', 'NATIVE_OPTION_CONTROL_OWNERSHIP_OVERLAP',
  'SOURCE_CLAUSE_NOT_AUTHORED', 'TRANSFORMED_VERIFICATION_CLAUSE', 'INVALID_STEP_DEPENDENCY',
  'AMBIGUOUS_VERIFICATION_INTENT', 'ROLE_HINT_NOT_AUTHORED', 'SUBJECT_HINT_NOT_AUTHORED',
  'ROLE_NAME_HINT_AMBIGUOUS', 'SCOPE_HINT_NOT_AUTHORED', 'AMBIGUOUS_SCOPE_HINT',
  'POLARITY_CONTRADICTION', 'PROPERTY_HINT_NOT_AUTHORED', 'COUNT_HINT_NOT_AUTHORED',
  'COUNT_COMPARISON_NOT_AUTHORED', 'RELATIONSHIP_HINT_NOT_AUTHORED', 'TEMPORAL_HINT_NOT_AUTHORED',
  'TEMPORAL_INTENT_LOST',
] as const;

/** Payload-free diagnostic. It is authenticated private accounting, never an admission capability. */
export const DeferredInterpretationStructuralV1Schema = z.strictObject({
  diagnosticVersion: z.literal('1'),
  phase: z.enum(['primary', 'independent', 'admission']),
  component: z.enum(['wire_normalization', 'response_shape', 'test_spec', 'source_accounting',
    'span_provenance', 'action_goal', 'verification_goal', 'semantic_admission']),
  issueCode: z.enum(['INVALID_JSON', 'UNKNOWN_FIELD', 'UNKNOWN_VERSION', 'INVALID_TYPE',
    'INVALID_VALUE', 'INVALID_BOUND', 'SPAN_OR_LITERAL_MISMATCH', 'SOURCE_ACCOUNTING_INVALID',
    'ACTION_LINKAGE_INVALID', 'ACTION_OWNERSHIP_INVALID', 'ACTION_PROVENANCE_INVALID',
    'ACTION_GRAPH_INVALID', 'ACTION_ARGUMENT_INVALID', 'VERIFICATION_SOURCE_INVALID',
    'SEMANTIC_ADMISSION_STRUCTURAL', 'OTHER_STRUCTURAL']),
  validatorCode: z.enum(STRUCTURAL_VALIDATOR_CODES).optional(),
  violationCategory: z.enum(['wire_shape', 'unknown_field', 'unknown_version', 'type', 'bound',
    'source_accounting', 'span_provenance', 'ownership', 'graph', 'argument', 'verification', 'admission']),
  path: z.strictObject({
    stepIndex: z.number().int().nonnegative().max(99).optional(),
    stepType: z.enum(['navigate', 'action_goal', 'verification_goal']).optional(),
    field: z.enum(['response', 'steps', 'instructionAccounting', 'sourceInstructionSpan',
      'sourceAccounting', 'sourceSpan', 'obligations', 'anchors', 'claim', 'goalVersion',
      'verificationVersion', 'sourceContractVersion', 'schemaVersion', 'other']),
    itemIndex: z.number().int().nonnegative().max(300).optional(),
  }),
  expectedCategory: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'missing', 'enum']).optional(),
  observedCategory: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'missing']).optional(),
});
export type DeferredInterpretationStructuralV1 = z.infer<typeof DeferredInterpretationStructuralV1Schema>;
