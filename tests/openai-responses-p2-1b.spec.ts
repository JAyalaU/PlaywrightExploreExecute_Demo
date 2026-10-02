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
import { POC_FIDELITY_RESPONSE_FORMAT, POC_PRIMARY_RESPONSE_FORMAT } from '../app/interpretation/deferred-action-poc-wire.js';
import { createOpenAIPocSemanticModels } from '../app/interpretation/deferred-action-poc-adapters.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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

const liveDebugRoot = resolve('artifacts', 'live-debug');

async function withLiveDebugFlags<T>(live: string | undefined, debug: string | undefined,
  run: () => Promise<T>): Promise<T> {
  const previousLive = process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS;
  const previousDebug = process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG;
  if (live === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS;
  else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS = live;
  if (debug === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG;
  else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG = debug;
  try { return await run(); }
  finally {
    if (previousLive === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS;
    else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS = previousLive;
    if (previousDebug === undefined) delete process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG;
    else process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG = previousDebug;
  }
}

function ownedProviderErrorArtifacts(model: string): string[] {
  if (!existsSync(liveDebugRoot)) return [];
  return readdirSync(liveDebugRoot).map((name) => resolve(liveDebugRoot, name)).filter((path) => {
    if (!path.startsWith(`${liveDebugRoot}${sep}`) || !existsSync(resolve(path, 'provider-error.json'))) return false;
    try { return JSON.parse(readFileSync(resolve(path, 'provider-error.json'), 'utf8')).model === model; }
    catch { return false; }
  });
}

function cleanupOwnedProviderErrorArtifacts(model: string): void {
  for (const path of ownedProviderErrorArtifacts(model)) {
    if (path.startsWith(`${liveDebugRoot}${sep}`)) rmSync(path, { recursive: true, force: true });
  }
}

test('live provider HTTP errors record only bounded known envelope fields with both explicit gates', async () => {
  const model = `debug-${randomUUID()}`;
  const secret = 'test-api-key-never-persist';
  const cases = [
    { status: 400, format: POC_PRIMARY_RESPONSE_FORMAT, error: { type: 'invalid_request_error', code: 'invalid_schema',
      param: 'text.format', message: 'Invalid JSON schema' } },
    { status: 401, format: POC_FIDELITY_RESPONSE_FORMAT, error: { type: 'authentication_error', code: 'invalid_api_key',
      param: null, message: `Authorization: Bearer ${secret}` } },
    { status: 429, format: POC_FIDELITY_RESPONSE_FORMAT, error: { type: 'rate_limit_error', code: 'rate_limit_exceeded',
      param: null, message: 'Rate limit reached' } },
  ] as const;
  try {
    for (const [live, debug] of [[undefined, undefined], ['1', undefined], [undefined, '1']] as const) {
      const client = createOpenAIResponsesClient({ apiKey: () => secret, model,
        fetchImpl: (async () => new Response(JSON.stringify({ error: cases[0]!.error }),
          { status: 400, headers: { 'Set-Cookie': `private=${secret}` } })) as typeof fetch });
      expect(await withLiveDebugFlags(live, debug, () => client.complete(request(POC_PRIMARY_RESPONSE_FORMAT))))
        .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR', providerResponseState: 'unavailable' });
      expect(ownedProviderErrorArtifacts(model)).toEqual([]);
    }
    await withLiveDebugFlags('1', '1', async () => {
      for (const sample of cases) {
        const events: OpenAIResponseDiagnostic[] = [];
        const client = createOpenAIResponsesClient({ apiKey: () => secret, model,
          diagnostic: (event) => events.push(event),
          fetchImpl: (async () => new Response(JSON.stringify({ error: sample.error,
            private_body: secret }), { status: sample.status,
            headers: { Authorization: `Bearer ${secret}`, Cookie: 'private-cookie' } })) as typeof fetch });
        expect(await client.complete(request(sample.format)))
          .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR', providerResponseState: 'unavailable' });
        expect(events).toMatchObject([{ kind: 'provider_failure', source: 'http_status',
          code: 'PROVIDER_ERROR', httpStatus: sample.status }]);
        expect(JSON.stringify(events)).not.toContain('invalid_schema');
      }
    });
    const artifacts = ownedProviderErrorArtifacts(model);
    expect(artifacts).toHaveLength(3);
    const diagnostics = artifacts.map((path) => JSON.parse(readFileSync(resolve(path, 'provider-error.json'), 'utf8')));
    for (const sample of cases) {
      const diagnostic = diagnostics.find((item) => item.httpStatus === sample.status);
      expect(diagnostic).toMatchObject({ source: 'http_status', responseFormat: sample.format.name,
        model, httpStatus: sample.status, providerResponseState: 'unavailable' });
      expect(typeof diagnostic.elapsedMs).toBe('number');
      expect(diagnostic.error?.type).toBe(sample.error.type);
      expect(diagnostic.error?.code).toBe(sample.error.code);
    }
    expect(diagnostics.find((item) => item.httpStatus === 400)?.error).toMatchObject({
      param: 'text.format', message: 'Invalid JSON schema' });
    expect(diagnostics.find((item) => item.httpStatus === 401)?.error).not.toHaveProperty('message');
    const persisted = artifacts.map((path) => readFileSync(resolve(path, 'provider-error.json'), 'utf8')).join('\n');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('Authorization');
    expect(persisted).not.toContain('Bearer');
    expect(persisted).not.toContain('Cookie');
    expect(persisted).not.toContain('private_body');
  } finally { cleanupOwnedProviderErrorArtifacts(model); }
});

test('non-JSON 5xx body is never persisted and PoC public failure mapping remains unchanged', async () => {
  const model = `debug-${randomUUID()}`;
  const secret = 'test-api-key-never-persist';
  try {
    await withLiveDebugFlags('1', '1', async () => {
      const config = { apiKey: () => secret, model,
        fetchImpl: (async () => new Response(`private raw body ${secret}`, { status: 503 })) as typeof fetch };
      const client = createOpenAIResponsesClient(config);
      expect(await client.complete(request(POC_PRIMARY_RESPONSE_FORMAT)))
        .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR', providerResponseState: 'unavailable' });
      const adapter = createOpenAIPocSemanticModels(config);
      await expect(adapter.primary.complete({ systemInstruction: 'Test instruction',
        userInstruction: 'Select Save.', signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
    const artifacts = ownedProviderErrorArtifacts(model);
    expect(artifacts).toHaveLength(2);
    for (const path of artifacts) {
      const diagnostic = JSON.parse(readFileSync(resolve(path, 'provider-error.json'), 'utf8'));
      expect(diagnostic).toMatchObject({ source: 'http_status', httpStatus: 503,
        responseFormat: POC_PRIMARY_RESPONSE_FORMAT.name, model, providerResponseState: 'unavailable' });
      expect(diagnostic).not.toHaveProperty('error');
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
      expect(JSON.stringify(diagnostic)).not.toContain('private raw body');
    }
  } finally { cleanupOwnedProviderErrorArtifacts(model); }
});

test('completed HTTP response with provider error records its closed state without changing public code', async () => {
  const model = `debug-${randomUUID()}`;
  try {
    const client = createOpenAIResponsesClient({ apiKey: () => 'test-secret', model,
      fetchImpl: (async () => new Response(JSON.stringify({ status: 'failed',
        error: { type: 'server_error', code: 'model_error', param: null, message: 'Generation failed' },
        output: [] }), { status: 200 })) as typeof fetch });
    expect(await withLiveDebugFlags('1', '1', () => client.complete(request(POC_PRIMARY_RESPONSE_FORMAT))))
      .toEqual({ kind: 'failure', code: 'PROVIDER_ERROR', providerResponseState: 'unavailable' });
    const [path] = ownedProviderErrorArtifacts(model);
    expect(path).toBeTruthy();
    expect(JSON.parse(readFileSync(resolve(path!, 'provider-error.json'), 'utf8'))).toMatchObject({
      source: 'provider_response', httpStatus: 200, providerResponseState: 'unavailable',
      error: { type: 'server_error', code: 'model_error', message: 'Generation failed' },
    });
  } finally { cleanupOwnedProviderErrorArtifacts(model); }
});
