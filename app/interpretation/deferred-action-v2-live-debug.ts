import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Private local escape hatch. Neither credentials nor provider output enter ordinary diagnostics. */
export function liveProviderDebugEnabled(): boolean {
  return process.env.PLAYWRIGHT_DEMO_LIVE_LLM_TESTS === '1' &&
    process.env.PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG === '1';
}

export type LiveProviderFailureKind = 'malformed_provider_json' | 'closed_wire_schema_failure' |
  'zod_normalization_failure' | 'non_zod_normalizer_exception';

interface FailureDetails {
  phase: 'primary' | 'independent';
  responseFormat: string;
  normalizer: string;
  model: string;
  providerCompletionState: 'completed';
  elapsedMs: number;
  kind: LiveProviderFailureKind;
  error: unknown;
  /** JSON.stringify of the parsed wire, taken before invoking the normalizer. Absent for invalid JSON. */
  wireSnapshot?: string;
}

interface AttemptDetails {
  phase: 'primary' | 'independent';
  responseFormat: string;
  model: string;
  providerCompletionState: 'completed';
  elapsedMs: number;
  normalizedOutcomeKind: 'extraction' | 'unresolved' | 'authored_ambiguity' | 'faithful' | 'not_faithful';
  wireSnapshot: string;
}

interface AdmissionDetails {
  testSpecId: string;
  finalKind: 'accepted' | 'rejected';
  stage?: 'primary' | 'independent' | 'admission';
  rejectionCategory?: string;
  rejectionCode?: string;
  rejectionDetail?: string;
  knownContributingPhases: ('primary' | 'independent')[];
  semanticDisagreementCategory?: 'semantic_disagreement' | 'omission_fidelity';
}

interface ProviderErrorDetails {
  source: 'http_status' | 'provider_response' | 'transport_exception';
  responseFormat: string;
  model: string;
  elapsedMs: number;
  httpStatus?: number;
  providerResponseState: 'completed' | 'incomplete' | 'unavailable';
  /** Only the parsed Responses error member is inspected; raw bodies are never written. */
  providerError?: unknown;
  /** Used only to suppress accidental echoes in the provider's error fields. */
  apiKey?: string;
}

function safeProviderErrorField(value: unknown, apiKey: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Drop the entire field if it resembles a credential or header, rather than persisting a partial secret.
  if ((apiKey && value.includes(apiKey)) || /\b(?:authorization|bearer|cookie|set-cookie|api[_-]?key)\b/i.test(value))
    return undefined;
  return value.slice(0, 512);
}

/** A small allowlisted provider error projection, separate from public transport diagnostics. */
export function recordLiveProviderError(details: ProviderErrorDetails): void {
  if (!liveProviderDebugEnabled()) return;
  try {
    const error = details.providerError !== null && typeof details.providerError === 'object' &&
      !Array.isArray(details.providerError) ? details.providerError as Record<string, unknown> : undefined;
    const fields = Object.fromEntries((['type', 'code', 'param', 'message'] as const)
      .map((name) => [name, safeProviderErrorField(error?.[name], details.apiKey)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const directory = debugDirectory();
    writeFileSync(join(directory, 'provider-error.json'), `${JSON.stringify({
      timestamp: new Date().toISOString(), source: details.source,
      responseFormat: details.responseFormat,
      model: details.apiKey && details.model.includes(details.apiKey) ? '[redacted]' : details.model,
      elapsedMs: Math.max(0, details.elapsedMs),
      providerResponseState: details.providerResponseState,
      ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
      ...(Object.keys(fields).length ? { error: fields } : {}),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* Local diagnostics cannot change transport or public failure behavior. */ }
}

function debugDirectory(): string {
  const directory = join(process.cwd(), 'artifacts', 'live-debug', `${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** One local record per successfully parsed and normalized provider attempt. */
export function recordLiveProviderAttempt(details: AttemptDetails): void {
  if (!liveProviderDebugEnabled()) return;
  try {
    const directory = debugDirectory();
    writeFileSync(join(directory, 'provider-wire.json'), `${details.wireSnapshot}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
      timestamp: new Date().toISOString(), phase: details.phase, model: details.model,
      responseFormat: details.responseFormat, providerCompletionState: details.providerCompletionState,
      elapsedMs: Math.max(0, details.elapsedMs), normalizedOutcomeKind: details.normalizedOutcomeKind,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* Private diagnostics cannot change an extraction result. */ }
}

/** Bounded admission decision only; no source, provider content, drafts, or public projection. */
export function recordLiveAdmission(details: AdmissionDetails): void {
  if (!liveProviderDebugEnabled()) return;
  try {
    const directory = debugDirectory();
    writeFileSync(join(directory, 'admission-diagnostic.json'), `${JSON.stringify({
      finalKind: details.finalKind, ...(details.stage ? { stage: details.stage } : {}),
      ...(details.rejectionCategory ? { rejectionCategory: details.rejectionCategory } : {}),
      ...(details.rejectionCode ? { rejectionCode: details.rejectionCode } : {}),
      ...(details.rejectionDetail ? { rejectionDetail: details.rejectionDetail } : {}),
      knownContributingPhases: details.knownContributingPhases,
      ...(details.semanticDisagreementCategory ? { semanticDisagreementCategory: details.semanticDisagreementCategory } : {}),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
      timestamp: new Date().toISOString(), phase: 'admission', testSpecId: details.testSpecId,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* Private diagnostics cannot change admission or projection. */ }
}

/** Writing diagnostics must never replace the original typed provider failure. */
export function recordLiveProviderFailure(details: FailureDetails): void {
  if (!liveProviderDebugEnabled()) return;
  try {
    const directory = debugDirectory();
    if (details.wireSnapshot !== undefined)
      writeFileSync(join(directory, 'provider-wire.json'), `${details.wireSnapshot}\n`, { flag: 'wx', mode: 0o600 });
    const zodError = details.error instanceof z.ZodError ? details.error : undefined;
    const error = details.error instanceof Error ? details.error : undefined;
    const exceptionClass = error?.constructor.name ?? typeof details.error;
    const exceptionName = error?.name ?? 'Unknown';
    const exceptionMessage = error?.message ?? String(details.error);
    const issues = zodError?.issues.map((issue) => ({ path: issue.path, code: issue.code }));
    const errorText = [
      `phase: ${details.phase}`,
      `failure kind: ${details.kind}`,
      `response format: ${details.responseFormat}`,
      `normalizer: ${details.normalizer}`,
      `exception class: ${exceptionClass}`,
      `exception name: ${exceptionName}`,
      `exception message: ${exceptionMessage}`,
      `exception type: ${zodError ? 'Zod error' : details.kind === 'malformed_provider_json' ?
        'non-Zod parser exception' : 'non-Zod normalizer exception'}`,
      ...(issues ? [`zod issues: ${JSON.stringify(issues)}`] : []),
      ...(error?.stack ? [`stack trace:\n${error.stack}`] : []),
    ].join('\n');
    writeFileSync(join(directory, 'normalization-error.txt'), `${errorText}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: details.phase,
      model: details.model,
      responseFormat: details.responseFormat,
      providerCompletionState: details.providerCompletionState,
      elapsedMs: Math.max(0, details.elapsedMs),
      normalizedOutcomeKind: null,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* A local diagnostic failure never changes interpretation, retries, or public projection. */ }
}
