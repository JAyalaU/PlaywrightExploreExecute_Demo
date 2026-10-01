import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { ModelCompletionFailure } from './model-failure.js';
import type { ActionSemanticExtractionModelsV2 } from './deferred-action-v2-interpret.js';
import { diagnoseZodStructure } from './deferred-action-v2-structural.js';
import { ACTION_V2_PRIMARY_RESPONSE_FORMAT, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT,
  normalizePrimaryActionExtractionV5Wire, normalizeIndependentActionExtractionV5Wire } from './deferred-action-v2-wire.js';

/** Two stateless adapters; independent credentials/model may be configured separately. No incumbent input API. */
export function createOpenAIActionSemanticExtractionModelsV2(primaryConfig: OpenAIResponsesConfig,
  independentConfig: OpenAIResponsesConfig = primaryConfig): ActionSemanticExtractionModelsV2 {
  const adapter = (config: OpenAIResponsesConfig,
    format: typeof ACTION_V2_PRIMARY_RESPONSE_FORMAT, normalize: (input: unknown, trustedSource: string) => string): ActionSemanticExtractionModelsV2['primary'] => {
    const client = createOpenAIResponsesClient(config);
    return { complete: async ({ systemInstruction, userInstruction, signal, onProviderCompleted, onStructuralIssue }) => {
      const outcome = await client.complete({ systemInstruction, input: userInstruction, format, signal });
      // Settled client outcome, including typed provider failures; no payload is reported.
      onProviderCompleted?.(outcome.kind === 'completed' ? 'completed' : outcome.providerResponseState ?? 'unavailable');
      if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code, outcome.completedMalformedOutput === true);
      let wire: unknown;
      try { wire = JSON.parse(outcome.output) as unknown; }
      catch { onStructuralIssue?.(diagnoseZodStructure(undefined, format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ? 'primary' : 'independent', 'wire_normalization'));
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); }
      try { return normalize(wire, userInstruction); }
      catch (error) { onStructuralIssue?.(diagnoseZodStructure(error, format === ACTION_V2_PRIMARY_RESPONSE_FORMAT ? 'primary' : 'independent', 'wire_normalization', wire));
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
    } };
  };
  return { primary: adapter(primaryConfig, ACTION_V2_PRIMARY_RESPONSE_FORMAT, normalizePrimaryActionExtractionV5Wire),
    independent: adapter(independentConfig, ACTION_V2_INDEPENDENT_RESPONSE_FORMAT, normalizeIndependentActionExtractionV5Wire) };
}
