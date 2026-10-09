import { ZodError } from 'zod';

export type SemanticPrimaryOutputPredicateV1 =
  'RESPONSE_BODY_INVALID' | 'STRUCTURED_OUTPUT_MISSING' | 'OUTPUT_MESSAGE_SHAPE_INVALID' |
  'OUTPUT_CONTENT_SHAPE_INVALID' | 'PROVIDER_REFUSAL' | 'RESPONSE_INCOMPLETE' |
  'JSON_PARSE_FAILED' | 'RESPONSE_FORMAT_MISMATCH' | 'WIRE_SCHEMA_REQUIRED_FIELD_MISSING' |
  'WIRE_SCHEMA_TYPE_MISMATCH' | 'WIRE_SCHEMA_ENUM_INVALID' | 'WIRE_SCHEMA_SHAPE_INVALID' |
  'OTHER_PRIMARY_OUTPUT_INVALID';

export type SemanticPrimaryOutputDiagnosticV1 = Readonly<{
  phase: 'response_body' | 'response_envelope' | 'output_text' | 'wire_json' | 'wire_schema';
  predicate: SemanticPrimaryOutputPredicateV1;
  stepIndex: number | null;
  fieldFamily: 'response' | 'steps' | 'step_identity' | 'target' | 'relation' |
    'action' | 'verification' | 'dependency' | 'other';
  responseStatus: 'completed' | 'incomplete' | 'other' | 'unavailable';
  structuredOutputPresent: boolean;
  refusalPresent: boolean;
  incompleteClass: 'max_output_tokens' | 'content_filter' | 'other' | null;
  providerCallId: string | null;
  providerResponseId: string | null;
  model: string | null;
  providerErrorCode: string | null;
}>;

export type SemanticPrimaryOutputCorrelationV1 = Pick<SemanticPrimaryOutputDiagnosticV1,
  'providerCallId' | 'providerResponseId' | 'model'>;

export function semanticPrimaryWireFailureDiagnosticV1(error: unknown,
  correlation?: SemanticPrimaryOutputCorrelationV1, input?: unknown): SemanticPrimaryOutputDiagnosticV1 {
  const detail = error instanceof SyntaxError ? { phase: 'wire_json' as const,
    predicate: 'JSON_PARSE_FAILED' as const, stepIndex: null, fieldFamily: 'response' as const } :
    semanticPrimaryWireSchemaDiagnosticV1(error, input);
  return { ...detail, responseStatus: 'completed', structuredOutputPresent: true,
    refusalPresent: false, incompleteClass: null, providerCallId: correlation?.providerCallId ?? null,
    providerResponseId: correlation?.providerResponseId ?? null, model: correlation?.model ?? null,
    providerErrorCode: null };
}

export function semanticPrimaryWireSchemaDiagnosticV1(error: unknown, input?: unknown): Pick<SemanticPrimaryOutputDiagnosticV1,
  'phase' | 'predicate' | 'stepIndex' | 'fieldFamily'> {
  if (!(error instanceof ZodError)) return { phase: 'wire_schema', predicate: 'OTHER_PRIMARY_OUTPUT_INVALID',
    stepIndex: null, fieldFamily: 'other' };
  const issue = error.issues[0];
  const path = issue?.path ?? [];
  const stepAt = path.findIndex(part => part === 'steps');
  const stepIndex = stepAt >= 0 && typeof path[stepAt + 1] === 'number' ? path[stepAt + 1] as number : null;
  const fields = path.map(String);
  let parent: unknown = input;
  for (const part of path.slice(0, -1)) parent = parent !== null && typeof parent === 'object' ?
    (parent as Record<string | number, unknown>)[part as string | number] : undefined;
  const last = path.at(-1);
  const present = last !== undefined && parent !== null && typeof parent === 'object' &&
    Object.hasOwn(parent, last);
  const fieldFamily: SemanticPrimaryOutputDiagnosticV1['fieldFamily'] =
    fields.includes('target') || fields.includes('subject') ?
      fields.includes('relation') || fields.includes('relatedStepId') ? 'relation' : 'target' :
      fields.includes('dependsOnStepId') ? 'dependency' :
        fields.includes('desiredEffect') || fields.includes('value') || fields.includes('checkedState') ? 'action' :
          fields.includes('observable') || fields.includes('comparator') || fields.includes('expected') ?
            'verification' : fields.includes('id') ? 'step_identity' :
              fields.includes('steps') ? 'steps' : 'response';
  const predicate: SemanticPrimaryOutputPredicateV1 = issue?.code === 'invalid_value' ||
    (fields.includes('kind') && issue?.code === 'invalid_union') ?
    'WIRE_SCHEMA_ENUM_INVALID' : issue?.code === 'invalid_type' ?
      !present ? 'WIRE_SCHEMA_REQUIRED_FIELD_MISSING' : 'WIRE_SCHEMA_TYPE_MISMATCH' :
        'WIRE_SCHEMA_SHAPE_INVALID';
  return { phase: 'wire_schema', predicate, stepIndex, fieldFamily };
}
