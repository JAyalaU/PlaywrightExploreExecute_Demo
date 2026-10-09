import { randomUUID } from 'node:crypto';
import { SEMANTIC_INTENT_PRIMARY_V3_FORMAT, SEMANTIC_INTENT_FIDELITY_V3_FORMAT } from './semantic-intent-v3-wire.js';
import { liveProviderDebugEnabled, recordLiveProviderError } from './provider-live-debug.js';
import type { SemanticPrimaryOutputCorrelationV1, SemanticPrimaryOutputDiagnosticV1,
  SemanticPrimaryOutputPredicateV1 } from
  './semantic-primary-output-diagnostic-v1.js';

type ResponseFormat = typeof SEMANTIC_INTENT_PRIMARY_V3_FORMAT | typeof SEMANTIC_INTENT_FIDELITY_V3_FORMAT;
export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAIResponsesConfig {
  /** Resolved outside TestSpecs, model input, and ordinary evidence. */
  apiKey: () => string | undefined;
  model?: string;
  reasoningEffort?: OpenAIReasoningEffort;
  maxOutputTokens?: number;
  maxOutputChars?: number;
  /** Replace only for isolated transport tests. Production always uses the fixed OpenAI endpoint. */
  fetchImpl?: typeof fetch;
  /** Opt-in local diagnostics; never receives prompts, credentials, or response bodies. */
  diagnostic?: (event: OpenAIResponseDiagnostic) => void;
}

export interface OpenAIResponseRequest {
  systemInstruction: string;
  input: string;
  format: ResponseFormat;
  signal: AbortSignal;
}

export type OpenAIResponseFailureCode =
  | 'PROVIDER_CONFIGURATION_ERROR'
  | 'PROVIDER_INPUT_INVALID'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_REFUSAL'
  | 'PROVIDER_INCOMPLETE'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'PROVIDER_RESPONSE_TOO_LARGE';

export type OpenAIResponseOutcome =
  | { kind: 'completed'; output: string; semanticPrimaryCorrelation?: SemanticPrimaryOutputCorrelationV1 }
  | { kind: 'failure'; code: OpenAIResponseFailureCode;
      /** Restricted transport fact for completed malformed structured output. */
      completedMalformedOutput?: boolean;
      providerResponseState?: 'completed' | 'incomplete' | 'unavailable';
      semanticPrimaryDiagnostic?: SemanticPrimaryOutputDiagnosticV1 };

export interface OpenAIResponseDiagnostic {
  kind: 'provider_failure';
  callId: string;
  stage: 'interpretation';
  code: OpenAIResponseFailureCode;
  source: 'configuration' | 'input' | 'http_status' | 'provider_response' |
    'response_contract' | 'response_body' | 'transport_exception' | 'timeout';
  httpStatus?: number;
  transportCode?: 'EACCES' | 'ECONNREFUSED' | 'ECONNRESET' | 'ENOTFOUND' |
    'ETIMEDOUT' | 'CERT_HAS_EXPIRED' | 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  elapsedMs: number;
}

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_INSTRUCTION_CHARS = 8_192;
const MAX_INPUT_CHARS = 32_768;
const MAX_BODY_BYTES = 262_144;

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function safeTransportCode(error: unknown): OpenAIResponseDiagnostic['transportCode'] {
  const cause = error instanceof Error ? record(error.cause) : undefined;
  const code = cause?.code;
  return code === 'EACCES' || code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
    code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ? code : undefined;
}

async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('ABORTED');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readBounded(response: Response, onInvalidJson?: () => void): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    onInvalidJson?.();
    return undefined;
  }
}

function extract(response: unknown, maxOutputChars: number, diagnostic?:
  (predicate: SemanticPrimaryOutputPredicateV1, phase: SemanticPrimaryOutputDiagnosticV1['phase'],
    structuredOutputPresent?: boolean, refusalPresent?: boolean) => SemanticPrimaryOutputDiagnosticV1,
  invalidBodyJson = false): OpenAIResponseOutcome {
  const invalid = (predicate: SemanticPrimaryOutputPredicateV1,
    phase: SemanticPrimaryOutputDiagnosticV1['phase'], completedMalformedOutput = true,
    structuredOutputPresent = false, refusalPresent = false): OpenAIResponseOutcome => ({
      kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID',
      ...(completedMalformedOutput ? { completedMalformedOutput: true } : {}),
      ...(diagnostic ? { semanticPrimaryDiagnostic: diagnostic(predicate, phase,
        structuredOutputPresent, refusalPresent) } : {}),
    });
  const body = record(response);
  if (!body) return invalid(invalidBodyJson ? 'JSON_PARSE_FAILED' : 'RESPONSE_BODY_INVALID',
    'response_body', false);
  if (body.status !== 'completed' || body.error != null || body.incomplete_details != null) {
    return { kind: 'failure', code: body.status === 'incomplete' ? 'PROVIDER_INCOMPLETE' : 'PROVIDER_ERROR' };
  }
  if (!Array.isArray(body.output)) return invalid('STRUCTURED_OUTPUT_MISSING', 'response_envelope');
  const messages = body.output.filter((item: unknown) => record(item)?.type === 'message');
  if (messages.length !== 1 || body.output.some((item: unknown) => !['message', 'reasoning'].includes(String(record(item)?.type)))) {
    return invalid('STRUCTURED_OUTPUT_MISSING', 'response_envelope');
  }
  const message = record(messages[0]);
  if (message?.status !== 'completed' || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return invalid('OUTPUT_MESSAGE_SHAPE_INVALID', 'response_envelope');
  }
  if (message.content.some((part: unknown) => record(part)?.type === 'refusal')) {
    return { kind: 'failure', code: 'PROVIDER_REFUSAL' };
  }
  if (message.content.length !== 1) return invalid('OUTPUT_CONTENT_SHAPE_INVALID', 'output_text');
  const part = record(message.content[0]);
  if (part?.type !== 'output_text' || typeof part.text !== 'string' || !part.text.trim()) {
    return invalid('STRUCTURED_OUTPUT_MISSING', 'output_text');
  }
  if (part.text.length > maxOutputChars) return { kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' };
  try {
    const parsed = JSON.parse(part.text) as unknown;
    const structured = record(parsed);
    if (!structured || !('response' in structured)) {
      return invalid('RESPONSE_FORMAT_MISMATCH', 'output_text', false, true);
    }
  } catch {
    return invalid('JSON_PARSE_FAILED', 'output_text', true, true);
  }
  return { kind: 'completed', output: part.text };
}

/** One stateless Responses request. M7 owns deadlines, retries, and application validation. */
export function createOpenAIResponsesClient(config: OpenAIResponsesConfig) {
  const model = config.model ?? 'gpt-5.6-terra';
  const reasoningEffort = config.reasoningEffort ?? 'medium';
  const maxOutputTokens = config.maxOutputTokens ?? 16_384;
  const maxOutputChars = config.maxOutputChars ?? 65_536;
  if (!/^[A-Za-z0-9._-]+$/.test(model) ||
      !(['none', 'low', 'medium', 'high', 'xhigh', 'max'] as readonly string[]).includes(reasoningEffort) ||
      !positiveInteger(maxOutputTokens) ||
      !positiveInteger(maxOutputChars) || maxOutputChars > MAX_BODY_BYTES) {
    throw new Error('Invalid OpenAI Responses configuration');
  }
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async complete(request: OpenAIResponseRequest): Promise<OpenAIResponseOutcome> {
      const started = Date.now();
      const callId = randomUUID();
      const structuredSourceFormat = request.format === SEMANTIC_INTENT_PRIMARY_V3_FORMAT ||
        request.format === SEMANTIC_INTENT_FIDELITY_V3_FORMAT;
      const stage = 'interpretation' as const;
      const semanticPrimary = request.format === SEMANTIC_INTENT_PRIMARY_V3_FORMAT;
      const primaryDiagnostic = (body: unknown, predicate: SemanticPrimaryOutputPredicateV1,
        phase: SemanticPrimaryOutputDiagnosticV1['phase'], structuredOutputPresent = false,
        refusalPresent = false): SemanticPrimaryOutputDiagnosticV1 => {
        const item = record(body);
        const status = item?.status;
        const reason = record(item?.incomplete_details)?.reason;
        const providerCode = record(item?.error)?.code;
        const responseId = item?.id;
        return { phase, predicate, stepIndex: null, fieldFamily: 'response',
          responseStatus: status === 'completed' || status === 'incomplete' ? status :
            status === undefined ? 'unavailable' : 'other',
          structuredOutputPresent, refusalPresent,
          incompleteClass: reason === 'max_output_tokens' || reason === 'content_filter' ? reason :
            status === 'incomplete' ? 'other' : null,
          providerCallId: callId,
          providerResponseId: typeof responseId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(responseId) ?
            responseId : null,
          model, providerErrorCode: typeof providerCode === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(providerCode) ? providerCode : null };
      };
      const fail = (code: OpenAIResponseFailureCode, source: OpenAIResponseDiagnostic['source'],
        response?: Response, transportCode?: OpenAIResponseDiagnostic['transportCode'],
        completedMalformedOutput = false,
        providerResponseState: 'completed' | 'incomplete' | 'unavailable' = 'unavailable',
        semanticPrimaryDiagnostic?: SemanticPrimaryOutputDiagnosticV1): OpenAIResponseOutcome => {
        try {
          config.diagnostic?.({ kind: 'provider_failure', callId, stage, code, source,
            ...(response ? { httpStatus: response.status } : {}),
            ...(transportCode ? { transportCode } : {}),
            elapsedMs: Math.max(0, Date.now() - started) });
        } catch { /* Diagnostics never change the model outcome. */ }
        return { kind: 'failure', code,
          ...(semanticPrimary && semanticPrimaryDiagnostic ? { semanticPrimaryDiagnostic } : {}),
          ...(structuredSourceFormat ? { providerResponseState,
            ...(completedMalformedOutput ? { completedMalformedOutput: true } : {}) } : {}) };
      };
      if (request.signal.aborted) return fail('PROVIDER_TIMEOUT', 'timeout');
      if (!request.systemInstruction.trim() || request.systemInstruction.length > MAX_INSTRUCTION_CHARS ||
          !request.input.trim() || request.input.length > MAX_INPUT_CHARS ||
          (request.format !== SEMANTIC_INTENT_PRIMARY_V3_FORMAT &&
            request.format !== SEMANTIC_INTENT_FIDELITY_V3_FORMAT)) {
        return fail('PROVIDER_INPUT_INVALID', 'input');
      }
      let key: string | undefined;
      try { key = config.apiKey(); } catch { /* Keep credential-provider diagnostics private. */ }
      if (!key?.trim()) return fail('PROVIDER_CONFIGURATION_ERROR', 'configuration');
      try {
        const response = await withAbort(request.signal, () => fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, reasoning: { effort: reasoningEffort }, instructions: request.systemInstruction,
            input: request.input, text: { format: request.format },
            store: false, tools: [], tool_choice: 'none',
            max_output_tokens: maxOutputTokens, truncation: 'disabled',
          }),
          signal: request.signal,
        }));
        if (!response.ok) {
          if (liveProviderDebugEnabled()) {
            let body: unknown;
            try { body = await withAbort(request.signal, () => readBounded(response)); }
            catch { /* A malformed, oversized, or unavailable body has no safe error envelope. */ }
            const parsed = record(body);
            const status = parsed?.status;
            recordLiveProviderError({ source: 'http_status', responseFormat: request.format.name,
              model, elapsedMs: Date.now() - started, httpStatus: response.status,
              providerResponseState: status === 'completed' ? 'completed' :
                status === 'incomplete' ? 'incomplete' : 'unavailable',
              providerError: parsed?.error, apiKey: key });
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
          return fail('PROVIDER_ERROR', 'http_status', response);
        }
        let invalidBodyJson = false;
        const body = await withAbort(request.signal, () => readBounded(response,
          () => { invalidBodyJson = true; }));
        const outcome = extract(body, maxOutputChars, semanticPrimary ?
          (predicate, phase, structured, refusal) => primaryDiagnostic(body, predicate, phase,
            structured, refusal) : undefined, invalidBodyJson);
        if (outcome.kind === 'failure') {
          const status = record(body)?.status;
          const providerResponseState = status === 'completed' ? 'completed' :
            status === 'incomplete' ? 'incomplete' : 'unavailable';
          const source = outcome.code === 'PROVIDER_ERROR' || outcome.code === 'PROVIDER_INCOMPLETE'
            ? 'provider_response' : outcome.code === 'PROVIDER_RESPONSE_TOO_LARGE'
              ? 'response_body' : 'response_contract';
          if (outcome.code === 'PROVIDER_ERROR')
            recordLiveProviderError({ source: 'provider_response', responseFormat: request.format.name,
              model, elapsedMs: Date.now() - started, httpStatus: response.status,
              providerResponseState, providerError: record(body)?.error, apiKey: key });
          const special = semanticPrimary && (outcome.code === 'PROVIDER_REFUSAL' ||
            outcome.code === 'PROVIDER_INCOMPLETE') ? primaryDiagnostic(body,
              outcome.code === 'PROVIDER_REFUSAL' ? 'PROVIDER_REFUSAL' : 'RESPONSE_INCOMPLETE',
              'response_envelope', Array.isArray(record(body)?.output),
              outcome.code === 'PROVIDER_REFUSAL') : undefined;
          return fail(outcome.code, source, response, undefined, outcome.completedMalformedOutput === true,
            providerResponseState, outcome.semanticPrimaryDiagnostic ?? special);
        }
        if (!semanticPrimary) return outcome;
        const responseId = record(body)?.id;
        return { ...outcome, semanticPrimaryCorrelation: { providerCallId: callId,
          providerResponseId: typeof responseId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(responseId) ?
            responseId : null, model } };
      } catch (error) {
        if (request.signal.aborted) return fail('PROVIDER_TIMEOUT', 'timeout');
        if (!(error instanceof Error && error.message === 'RESPONSE_TOO_LARGE'))
          recordLiveProviderError({ source: 'transport_exception', responseFormat: request.format.name,
            model, elapsedMs: Date.now() - started, providerResponseState: 'unavailable', apiKey: key });
        return error instanceof Error && error.message === 'RESPONSE_TOO_LARGE'
          ? fail('PROVIDER_RESPONSE_TOO_LARGE', 'response_body')
          : fail('PROVIDER_ERROR', 'transport_exception', undefined, safeTransportCode(error));
      }
    },
  };
}
