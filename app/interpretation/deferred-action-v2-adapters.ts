import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { z } from 'zod';
import { ModelCompletionFailure } from './model-failure.js';
import type { ActionSemanticExtractionModelsV2 } from './deferred-action-v2-interpret.js';
import { diagnoseZodStructure } from './deferred-action-v2-structural.js';
import { liveProviderDebugEnabled, recordLiveProviderAttempt, recordLiveProviderFailure } from './deferred-action-v2-live-debug.js';
import { ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  PrimaryActionExtractionV6WireSchema, IndependentActionExtractionV6WireSchema,
  normalizePrimaryActionExtractionV6Wire, normalizeIndependentActionExtractionV6Wire } from './deferred-action-v2-wire.js';

/** Two stateless adapters; independent credentials/model may be configured separately. No incumbent input API. */
export function createOpenAIActionSemanticExtractionModelsV2(primaryConfig: OpenAIResponsesConfig,
  independentConfig: OpenAIResponsesConfig = primaryConfig): ActionSemanticExtractionModelsV2 {
  const adapter = (config: OpenAIResponsesConfig,
    format: typeof ACTION_V2_PRIMARY_RESPONSE_FORMAT, normalize: (input: unknown, trustedSource: string) => string): ActionSemanticExtractionModelsV2['primary'] => {
    const client = createOpenAIResponsesClient(config);
    const phase = format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ? 'primary' : 'independent';
    const wireSchema = phase === 'primary' ? PrimaryActionExtractionV6WireSchema : IndependentActionExtractionV6WireSchema;
    const normalizer = phase === 'primary' ? 'normalizePrimaryActionExtractionV6Wire (v6)' :
      'normalizeIndependentActionExtractionV6Wire (v6)';
    return { complete: async ({ systemInstruction, userInstruction, signal, onProviderCompleted, onStructuralIssue }) => {
      const started = Date.now();
      const outcome = await client.complete({ systemInstruction, input: userInstruction, format, signal });
      // Settled client outcome, including typed provider failures; no payload is reported.
      onProviderCompleted?.(outcome.kind === 'completed' ? 'completed' : outcome.providerResponseState ?? 'unavailable');
      if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code, outcome.completedMalformedOutput === true);
      let wire: unknown;
      try { wire = JSON.parse(outcome.output) as unknown; }
      catch (error) { onStructuralIssue?.(diagnoseZodStructure(undefined, phase, 'wire_normalization'));
        recordLiveProviderFailure({ phase, responseFormat: format.name, normalizer,
          model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed', elapsedMs: Date.now() - started,
          kind: 'malformed_provider_json', error });
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); }
      // Freeze the exact parsed input for private diagnostics before a normalizer can mutate it.
      let wireSnapshot: string | undefined;
      if (liveProviderDebugEnabled()) {
        try { wireSnapshot = JSON.stringify(wire); } catch { /* Debugging cannot change normalization. */ }
      }
      try {
        const normalized = normalize(wire, userInstruction);
        if (wireSnapshot !== undefined) {
          try {
            const kind = (JSON.parse(normalized) as { kind?: unknown }).kind;
            if (kind === 'extraction' || kind === 'unresolved' || kind === 'authored_ambiguity')
              recordLiveProviderAttempt({ phase, responseFormat: format.name,
                model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed',
                elapsedMs: Date.now() - started, normalizedOutcomeKind: kind, wireSnapshot });
          } catch { /* Private diagnostics cannot change a normalized provider response. */ }
        }
        return normalized;
      }
      catch (error) { onStructuralIssue?.(diagnoseZodStructure(error, phase, 'wire_normalization', wire));
        if (liveProviderDebugEnabled()) {
          try {
            const kind = !wireSchema.safeParse(wire).success ? 'closed_wire_schema_failure' :
              error instanceof z.ZodError ? 'zod_normalization_failure' : 'non_zod_normalizer_exception';
            recordLiveProviderFailure({ phase, responseFormat: format.name, normalizer,
              model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed', elapsedMs: Date.now() - started,
              kind, error, ...(wireSnapshot === undefined ? {} : { wireSnapshot }) });
          } catch { /* Classification is private and cannot replace the original model failure. */ }
        }
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
    } };
  };
  return { primary: adapter(primaryConfig, ACTION_V2_PRIMARY_RESPONSE_FORMAT, normalizePrimaryActionExtractionV6Wire),
    independent: adapter(independentConfig, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT, normalizeIndependentActionExtractionV6Wire) };
}
