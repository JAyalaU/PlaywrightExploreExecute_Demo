import { expect, test } from '@playwright/test';
import {
  createOpenAIResponsesClient,
  INTERPRETATION_RESPONSE_FORMAT,
  STEP_DECISION_RESPONSE_FORMAT,
  type OpenAIResponseRequest,
} from '../app/interpretation/index.js';
import type { OpenAIResponseDiagnostic } from '../app/interpretation/openai-responses.js';
import { AGENTIC_INTERPRETATION_RESPONSE_FORMAT } from '../app/interpretation/openai-wire.js';
import { AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT } from '../app/interpretation/verification-wire.js';

const wireOutput = JSON.stringify({ response: { kind: 'ambiguous', reason: 'unclear' } });
const completed = (text = wireOutput): Response => new Response(JSON.stringify({
  status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text }] }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

function request(format: OpenAIResponseRequest['format'] = INTERPRETATION_RESPONSE_FORMAT,
  signal = new AbortController().signal): OpenAIResponseRequest {
  return { systemInstruction: 'Follow the closed response schema.', input: 'Select Save.', format, signal };
}

test('P2-1B sends one stateless strict Responses call with external credentials and approved defaults', async () => {
  const secret = 'test-secret-never-record';
  let callCount = 0;
  const client = createOpenAIResponsesClient({
    apiKey: () => secret,
    fetchImpl: (async (url, init) => {
      callCount++;
      expect(url).toBe('https://api.openai.com/v1/responses');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${secret}`);
      expect(init?.signal).toBe(signal);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        model: 'gpt-5.6-terra', reasoning: { effort: 'medium' },
        instructions: 'Follow the closed response schema.', input: 'Select Save.',
        text: { format: INTERPRETATION_RESPONSE_FORMAT }, store: false,
        tools: [], tool_choice: 'none', max_output_tokens: 16_384, truncation: 'disabled',
      });
      expect(JSON.stringify(body)).not.toContain(secret);
      return completed();
    }) as typeof fetch,
  });
  const signal = new AbortController().signal;
  expect(await client.complete(request(INTERPRETATION_RESPONSE_FORMAT, signal))).toEqual({ kind: 'completed', output: wireOutput });
  expect(callCount).toBe(1);
});

test('P2-1B allows configured model, effort and output cap without changing schema or authority', async () => {
  const client = createOpenAIResponsesClient({
    apiKey: () => 'secret', model: 'gpt-5.6-sol', reasoningEffort: 'high', maxOutputTokens: 2_048,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('gpt-5.6-sol');
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.max_output_tokens).toBe(2_048);
      expect(body.text).toEqual({ format: STEP_DECISION_RESPONSE_FORMAT });
      expect(body.tools).toEqual([]);
      expect(body.tool_choice).toBe('none');
      return completed(JSON.stringify({ response: { kind: 'find', text: 'Save' } }));
    }) as typeof fetch,
  });
  expect((await client.complete(request(STEP_DECISION_RESPONSE_FORMAT))).kind).toBe('completed');
});

test('goal-directed interpretation and verification use only their reviewed structured formats', async () => {
  const formats = [AGENTIC_INTERPRETATION_RESPONSE_FORMAT,
    AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT] as const;
  const seen: unknown[] = [];
  const client = createOpenAIResponsesClient({ apiKey: () => 'test-secret',
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push((body.text as { format: unknown }).format);
      expect(body.tools).toEqual([]);
      expect(body.tool_choice).toBe('none');
      return completed();
    }) as typeof fetch });
  for (const format of formats) {
    expect(await client.complete(request(format))).toEqual({ kind: 'completed', output: wireOutput });
  }
  expect(seen).toEqual(formats);
});

test('goal-directed interpretation failures retain their interpretation diagnostic stage', async () => {
  const events: OpenAIResponseDiagnostic[] = [];
  const client = createOpenAIResponsesClient({ apiKey: () => 'test-secret',
    diagnostic: (event) => events.push(event),
    fetchImpl: (async () => new Response('', { status: 429 })) as typeof fetch });
  expect(await client.complete(request(AGENTIC_INTERPRETATION_RESPONSE_FORMAT)))
    .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stage: 'interpretation', code: 'PROVIDER_ERROR',
    source: 'http_status', httpStatus: 429 });
});

test('P2-1B propagates cancellation and resolves a hung transport as a stable timeout', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const client = createOpenAIResponsesClient({
    apiKey: () => 'secret',
    fetchImpl: ((_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
  });
  const pending = client.complete(request(INTERPRETATION_RESPONSE_FORMAT, controller.signal));
  await Promise.resolve();
  expect(observedSignal).toBe(controller.signal);
  controller.abort();
  expect(await pending).toEqual({ kind: 'failure', code: 'PROVIDER_TIMEOUT' });
  expect(await client.complete(request(INTERPRETATION_RESPONSE_FORMAT, controller.signal)))
    .toEqual({ kind: 'failure', code: 'PROVIDER_TIMEOUT' });
});

test('P2-1B returns sanitized failures for refusal, incomplete, missing, tool, malformed, and HTTP responses', async () => {
  const samples: Array<[Response, string]> = [
    [new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'private details' }] }] }), { status: 200 }), 'PROVIDER_REFUSAL'],
    [new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), { status: 200 }), 'PROVIDER_INCOMPLETE'],
    [new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 }), 'PROVIDER_OUTPUT_INVALID'],
    [new Response(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'browser_click' }] }), { status: 200 }), 'PROVIDER_OUTPUT_INVALID'],
    [completed('not JSON'), 'PROVIDER_OUTPUT_INVALID'],
    [new Response('sensitive provider error body', { status: 429 }), 'PROVIDER_ERROR'],
  ];
  for (const [response, code] of samples) {
    let calls = 0;
    const client = createOpenAIResponsesClient({ apiKey: () => 'secret',
      fetchImpl: (async () => { calls++; return response; }) as typeof fetch });
    expect(await client.complete(request())).toEqual({ kind: 'failure', code });
    expect(calls).toBe(1);
  }
});

test('P2-1B bounds input, output text, and response bytes before application use', async () => {
  let calls = 0;
  const client = createOpenAIResponsesClient({ apiKey: () => 'secret', maxOutputChars: 40,
    fetchImpl: (async () => { calls++; return completed(JSON.stringify({ response: { kind: 'find', text: 'x'.repeat(50) } })); }) as typeof fetch });
  expect(await client.complete(request())).toEqual({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  expect(await client.complete({ ...request(), input: 'x'.repeat(32_769) }))
    .toEqual({ kind: 'failure', code: 'PROVIDER_INPUT_INVALID' });
  expect(calls).toBe(1);
  const oversized = createOpenAIResponsesClient({ apiKey: () => 'secret',
    fetchImpl: (async () => new Response('x'.repeat(262_145), { status: 200 })) as typeof fetch });
  expect(await oversized.complete(request())).toEqual({ kind: 'failure', code: 'PROVIDER_RESPONSE_TOO_LARGE' });
});

test('P2-1B does not transmit without a credential or accepted format', async () => {
  let calls = 0;
  const client = createOpenAIResponsesClient({ apiKey: () => undefined,
    fetchImpl: (async () => { calls++; return completed(); }) as typeof fetch });
  expect(await client.complete(request())).toEqual({ kind: 'failure', code: 'PROVIDER_CONFIGURATION_ERROR' });
  expect(calls).toBe(0);
  expect(await client.complete({ ...request(), format: { type: 'json_schema', name: 'unapproved' } as never }))
    .toEqual({ kind: 'failure', code: 'PROVIDER_INPUT_INVALID' });
  expect(() => createOpenAIResponsesClient({ apiKey: () => 'secret', reasoningEffort: 'unsupported' as never })).toThrow();
});

test('opt-in provider diagnostics distinguish HTTP rejection without exposing response content', async () => {
  const events: OpenAIResponseDiagnostic[] = [];
  const secret = 'never-emit-this-secret';
  const client = createOpenAIResponsesClient({ apiKey: () => secret, diagnostic: (event) => events.push(event),
    fetchImpl: (async () => new Response(`private body ${secret}`, { status: 401,
      headers: { 'x-request-id': 'req_1234567890abcdef', 'x-private': secret } })) as typeof fetch });
  expect(await client.complete(request())).toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'provider_failure', stage: 'interpretation',
    code: 'PROVIDER_ERROR', source: 'http_status', httpStatus: 401 });
  expect(events[0]?.callId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain('req_1234567890abcdef');
});

test('provider diagnostics classify a transport exception with a closed code and ignore sink failures', async () => {
  const events: OpenAIResponseDiagnostic[] = [];
  const client = createOpenAIResponsesClient({ apiKey: () => 'secret',
    diagnostic: (event) => events.push(event),
    fetchImpl: (async () => { throw new TypeError('private endpoint text', { cause: { code: 'EACCES' } }); }) as typeof fetch });
  expect(await client.complete(request(STEP_DECISION_RESPONSE_FORMAT)))
    .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
  expect(events[0]).toMatchObject({ stage: 'step_decision', code: 'PROVIDER_ERROR',
    source: 'transport_exception', transportCode: 'EACCES' });
  expect(JSON.stringify(events)).not.toContain('private endpoint text');

  const ignored = createOpenAIResponsesClient({ apiKey: () => 'secret',
    diagnostic: () => { throw new Error('logging failed'); },
    fetchImpl: (async () => new Response('private body', { status: 429,
      headers: { 'x-request-id': 'private header with spaces' } })) as typeof fetch });
  expect(await ignored.complete(request())).toEqual({ kind: 'failure', code: 'PROVIDER_ERROR' });
});

test('provider diagnostics do not emit on a successful structured response', async () => {
  const events: OpenAIResponseDiagnostic[] = [];
  const client = createOpenAIResponsesClient({ apiKey: () => 'secret',
    diagnostic: (event) => events.push(event),
    fetchImpl: (async () => completed()) as typeof fetch });
  expect((await client.complete(request())).kind).toBe('completed');
  expect(events).toEqual([]);
});
