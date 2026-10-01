import { AgenticVerificationDecisionV4Schema } from './verification-strategy.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false } as const);
const string = { type: 'string' } as const;
const literal = (value: string) => ({ type: 'string', enum: [value] } as const);
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const query = object({ role: { type: 'string', enum: ['button', 'link', 'dialog', 'row', 'cell',
  'textbox', 'checkbox', 'radio', 'heading', 'region', 'menu', 'menuitem', 'tab', 'combobox',
  'listbox', 'option', 'switch'] }, name: { type: ['string', 'null'] }, frame: ref('frame'),
within: { anyOf: [{ type: 'array', items: ref('scope') }, { type: 'null' }] } });
const comparison = (kind: string, fields: Record<string, unknown>) => object({ kind: literal(kind), ...fields });
export const AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT = {
  type: 'json_schema', name: 'agentic_verification_decision_v4', strict: true,
  schema: { ...object({ response: { anyOf: [
    object({ decisionVersion: literal('4'), kind: literal('observe'), request: ref('request') }),
    object({ decisionVersion: literal('4'), kind: literal('conclude'),
      conclusion: { type: 'string', enum: ['satisfied', 'unsatisfied', 'unresolved', 'unsupported'] },
      comparison: { anyOf: [ref('comparison'), { type: 'null' }] } }),
  ] } }), $defs: {
    frame: { anyOf: [object({ kind: literal('main') }), object({ kind: literal('nested'),
      anchors: { type: 'array', items: { anyOf: [
        object({ kind: literal('title'), value: string, exact: { type: 'boolean', enum: [true] } }),
        object({ kind: literal('testId'), value: string, exact: { type: 'boolean', enum: [true] } }),
      ] } } })] },
    scope: { anyOf: [
      ...(['dialog', 'menu', 'region'] as const).map((kind) => object({ kind: literal(kind), name: string })),
      object({ kind: literal('row'), cellName: string }),
    ] }, query,
    request: { anyOf: [
      object({ kind: literal('semantic_query'), query: ref('query') }),
      object({ kind: literal('target_property'), query: ref('query'), property: { type: 'string',
        enum: ['semantic', 'text', 'value', 'visible', 'enabled', 'checked', 'expanded', 'selected'] } }),
      object({ kind: literal('current_url') }), object({ kind: literal('semantic_snapshot') }),
    ] },
    comparison: { anyOf: [
      comparison('count', { observationId: string, operator: { type: 'string',
        enum: ['equal', 'greater_than', 'at_least', 'at_most'] }, expected: { type: 'integer' } }),
      comparison('boolean', { observationId: string, property: { type: 'string',
        enum: ['visible', 'enabled', 'checked', 'expanded', 'selected'] }, expected: { type: 'boolean' } }),
      comparison('string', { observationId: string, property: { type: 'string', enum: ['text', 'value', 'url'] },
        operator: { type: 'string', enum: ['equal', 'contains', 'url_prefix'] }, expected: string }),
      comparison('transition', { earlierObservationId: string, laterObservationId: string,
        operator: { type: 'string', enum: ['appears', 'disappears'] } }),
    ] },
  } },
} as const;

/** Wire nulls are the provider's representation of absent optional fields. */
export function normalizeAgenticVerificationDecisionWire(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid envelope');
  const response = (input as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid response');
  const decision = structuredClone(response as Record<string, unknown>);
  if (decision.kind === 'conclude' && decision.comparison === null) delete decision.comparison;
  if (decision.kind === 'observe' && decision.request && typeof decision.request === 'object') {
    const request = decision.request as Record<string, unknown>;
    if (request.query && typeof request.query === 'object') {
      const q = request.query as Record<string, unknown>;
      if (q.name === null) delete q.name;
      if (q.within === null) delete q.within;
    }
  }
  return JSON.stringify(AgenticVerificationDecisionV4Schema.parse(decision));
}
