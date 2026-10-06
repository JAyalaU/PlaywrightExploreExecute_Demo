import {
  INTERPRETATION_RESPONSE_FORMAT,
  AGENTIC_INTERPRETATION_RESPONSE_FORMAT,
  STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT,
  STEP_DECISION_RESPONSE_FORMAT,
  AGENTIC_DECISION_RESPONSE_FORMAT,
} from './openai-wire.js';
import { randomUUID } from 'node:crypto';
import { AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT } from './verification-wire.js';
import { DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT } from './deferred-action-wire.js';
import { ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT, LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT, PREVIOUS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  PREVIOUS_OFFSETLESS_ACTION_V2_PRIMARY_RESPONSE_FORMAT,
  PREVIOUS_OFFSETLESS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  PREVIOUS_CANONICAL_ACTION_V2_PRIMARY_RESPONSE_FORMAT,
  PREVIOUS_CANONICAL_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT } from './deferred-action-v2-wire.js';
import { POC_PRIMARY_RESPONSE_FORMAT, POC_FIDELITY_RESPONSE_FORMAT } from './deferred-action-poc-wire.js';
import { SEMANTIC_INTENT_PRIMARY_V3_FORMAT, SEMANTIC_INTENT_FIDELITY_V3_FORMAT } from './semantic-intent-v3-wire.js';
import { ACTION_GROUNDING_RESPONSE_FORMAT, ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT } from './action-grounding-wire.js';
import { NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT } from './native-option-verification-wire.js';
import { liveProviderDebugEnabled, recordLiveProviderError } from './deferred-action-v2-live-debug.js';

type ResponseFormat = typeof INTERPRETATION_RESPONSE_FORMAT | typeof AGENTIC_INTERPRETATION_RESPONSE_FORMAT |
  typeof STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT | typeof STEP_DECISION_RESPONSE_FORMAT |
  typeof AGENTIC_DECISION_RESPONSE_FORMAT | typeof AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT |
  typeof DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT | typeof ACTION_V2_PRIMARY_RESPONSE_FORMAT |
  typeof PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT |
  typeof SEMANTIC_INTENT_PRIMARY_V3_FORMAT | typeof SEMANTIC_INTENT_FIDELITY_V3_FORMAT |
  typeof ACTION_GROUNDING_RESPONSE_FORMAT | typeof NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT;
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
  | { kind: 'completed'; output: string }
  | { kind: 'failure'; code: OpenAIResponseFailureCode;
      /** Restricted transport fact. Only a completed malformed model response permits the deferred retry. */
      completedMalformedOutput?: boolean;
      providerResponseState?: 'completed' | 'incomplete' | 'unavailable' };

export interface OpenAIResponseDiagnostic {
  kind: 'provider_failure';
  callId: string;
  stage: 'interpretation' | 'step_decision' | 'agentic_decision' | 'agentic_verification';
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

async function readBounded(response: Response): Promise<unknown> {
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
    return undefined;
  }
}

function extract(response: unknown, maxOutputChars: number): OpenAIResponseOutcome {
  const body = record(response);
  if (!body) return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID' };
  if (body.status !== 'completed' || body.error != null || body.incomplete_details != null) {
    return { kind: 'failure', code: body.status === 'incomplete' ? 'PROVIDER_INCOMPLETE' : 'PROVIDER_ERROR' };
  }
  if (!Array.isArray(body.output)) return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
  const messages = body.output.filter((item: unknown) => record(item)?.type === 'message');
  if (messages.length !== 1 || body.output.some((item: unknown) => !['message', 'reasoning'].includes(String(record(item)?.type)))) {
    return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
  }
  const message = record(messages[0]);
  if (message?.status !== 'completed' || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
  }
  if (message.content.some((part: unknown) => record(part)?.type === 'refusal')) {
    return { kind: 'failure', code: 'PROVIDER_REFUSAL' };
  }
  if (message.content.length !== 1) return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
  const part = record(message.content[0]);
  if (part?.type !== 'output_text' || typeof part.text !== 'string' || !part.text.trim()) {
    return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
  }
  if (part.text.length > maxOutputChars) return { kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' };
  try {
    const parsed = JSON.parse(part.text) as unknown;
    const structured = record(parsed);
    if (!structured || !('response' in structured)) {
      return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID' };
    }
  } catch {
    return { kind: 'failure', code: 'PROVIDER_OUTPUT_INVALID', completedMalformedOutput: true };
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
      const deferredSourceFormat = request.format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === POC_PRIMARY_RESPONSE_FORMAT || request.format === POC_FIDELITY_RESPONSE_FORMAT ||
        request.format === SEMANTIC_INTENT_PRIMARY_V3_FORMAT || request.format === SEMANTIC_INTENT_FIDELITY_V3_FORMAT;
      const stage = request.format === INTERPRETATION_RESPONSE_FORMAT ||
        request.format === AGENTIC_INTERPRETATION_RESPONSE_FORMAT ||
        request.format === STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT ||
        request.format === DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT ||
        request.format === LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_OFFSETLESS_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_OFFSETLESS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_CANONICAL_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_CANONICAL_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === POC_PRIMARY_RESPONSE_FORMAT || request.format === POC_FIDELITY_RESPONSE_FORMAT ||
        request.format === SEMANTIC_INTENT_PRIMARY_V3_FORMAT || request.format === SEMANTIC_INTENT_FIDELITY_V3_FORMAT ? 'interpretation' :
        request.format === AGENTIC_DECISION_RESPONSE_FORMAT || request.format === ACTION_GROUNDING_RESPONSE_FORMAT ||
          request.format === ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT ? 'agentic_decision' :
          request.format === AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT ||
            request.format === NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT ? 'agentic_verification' : 'step_decision';
      const fail = (code: OpenAIResponseFailureCode, source: OpenAIResponseDiagnostic['source'],
        response?: Response, transportCode?: OpenAIResponseDiagnostic['transportCode'],
        completedMalformedOutput = false,
        providerResponseState: 'completed' | 'incomplete' | 'unavailable' = 'unavailable'): OpenAIResponseOutcome => {
        try {
          config.diagnostic?.({ kind: 'provider_failure', callId, stage, code, source,
            ...(response ? { httpStatus: response.status } : {}),
            ...(transportCode ? { transportCode } : {}),
            elapsedMs: Math.max(0, Date.now() - started) });
        } catch { /* Diagnostics never change the model outcome. */ }
        return { kind: 'failure', code,
          ...(deferredSourceFormat ? { providerResponseState,
            ...(completedMalformedOutput ? { completedMalformedOutput: true } : {}) } : {}) };
      };
      if (request.signal.aborted) return fail('PROVIDER_TIMEOUT', 'timeout');
      // Only the new reviewed source formats carry both verbatim source contracts.
      const instructionLimit = request.format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_OFFSETLESS_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_OFFSETLESS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ||
        request.format === PREVIOUS_CANONICAL_ACTION_V2_PRIMARY_RESPONSE_FORMAT ||
        request.format === PREVIOUS_CANONICAL_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT ? 12_288 : MAX_INSTRUCTION_CHARS;
      if (!request.systemInstruction.trim() || request.systemInstruction.length > instructionLimit ||
          !request.input.trim() || request.input.length > MAX_INPUT_CHARS ||
          (request.format !== INTERPRETATION_RESPONSE_FORMAT &&
            request.format !== AGENTIC_INTERPRETATION_RESPONSE_FORMAT &&
            request.format !== STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT &&
            request.format !== DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT &&
            request.format !== LEGACY_ACTION_V2_PRIMARY_RESPONSE_FORMAT &&
            request.format !== LEGACY_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_ACTION_V2_PRIMARY_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_OFFSETLESS_ACTION_V2_PRIMARY_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_OFFSETLESS_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_CANONICAL_ACTION_V2_PRIMARY_RESPONSE_FORMAT &&
            request.format !== PREVIOUS_CANONICAL_ACTION_V2_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== ACTION_V2_PRIMARY_RESPONSE_FORMAT &&
            request.format !== ACTION_V2_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== POC_PRIMARY_RESPONSE_FORMAT &&
            request.format !== POC_FIDELITY_RESPONSE_FORMAT &&
            request.format !== SEMANTIC_INTENT_PRIMARY_V3_FORMAT &&
            request.format !== SEMANTIC_INTENT_FIDELITY_V3_FORMAT &&
            request.format !== ACTION_GROUNDING_RESPONSE_FORMAT &&
            request.format !== ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT &&
            request.format !== STEP_DECISION_RESPONSE_FORMAT &&
            request.format !== AGENTIC_DECISION_RESPONSE_FORMAT &&
            request.format !== NATIVE_OPTION_VERIFICATION_RESPONSE_FORMAT &&
            request.format !== AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT)) {
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
        const body = await withAbort(request.signal, () => readBounded(response));
        const outcome = extract(body, maxOutputChars);
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
          return fail(outcome.code, source, response, undefined, outcome.completedMalformedOutput === true,
            providerResponseState);
        }
        return outcome;
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
