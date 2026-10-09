import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Private local provider-error diagnostics; never changes the transport outcome. */
export function liveProviderDebugEnabled(): boolean {
  return process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS === '1' &&
    process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG === '1';
}

interface ProviderErrorDetails {
  source: 'http_status' | 'provider_response' | 'transport_exception';
  responseFormat: string;
  model: string;
  elapsedMs: number;
  httpStatus?: number;
  providerResponseState: 'completed' | 'incomplete' | 'unavailable';
  providerError?: unknown;
  apiKey?: string;
}

function safeProviderErrorField(value: unknown, apiKey: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if ((apiKey && value.includes(apiKey)) || /\b(?:authorization|bearer|cookie|set-cookie|api[_-]?key)\b/i.test(value))
    return undefined;
  return value.slice(0, 512);
}

export function recordLiveProviderError(details: ProviderErrorDetails): void {
  if (!liveProviderDebugEnabled()) return;
  try {
    const error = details.providerError !== null && typeof details.providerError === 'object' &&
      !Array.isArray(details.providerError) ? details.providerError as Record<string, unknown> : undefined;
    const fields = Object.fromEntries((['type', 'code', 'param', 'message'] as const)
      .map((name) => [name, safeProviderErrorField(error?.[name], details.apiKey)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const directory = join(process.cwd(), 'artifacts', 'live-debug', `${Date.now()}-${randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, 'provider-error.json'), `${JSON.stringify({
      timestamp: new Date().toISOString(), source: details.source,
      responseFormat: details.responseFormat,
      model: details.apiKey && details.model.includes(details.apiKey) ? '[redacted]' : details.model,
      elapsedMs: Math.max(0, details.elapsedMs),
      providerResponseState: details.providerResponseState,
      ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
      ...(Object.keys(fields).length ? { error: fields } : {}),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* A local diagnostic failure cannot change provider handling. */ }
}
