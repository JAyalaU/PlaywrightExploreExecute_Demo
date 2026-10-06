import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { ModelCompletionFailure } from './model-failure.js';
import type { SemanticIntentModelsV3 } from './semantic-intent-v3.js';
import { SEMANTIC_INTENT_FIDELITY_V3_FORMAT, SEMANTIC_INTENT_PRIMARY_V3_FORMAT,
  SemanticIntentFidelityWireV3Schema, SemanticIntentPrimaryWireV3Schema } from './semantic-intent-v3-wire.js';

/** Opt-in provider adapters. No production workflow imports this module. */
export function createOpenAISemanticIntentModelsV3(primaryConfig: OpenAIResponsesConfig,
  reviewerConfig: OpenAIResponsesConfig = primaryConfig): SemanticIntentModelsV3 {
  const adapter = (config: OpenAIResponsesConfig, phase: 'primary' | 'reviewer') => {
    const client = createOpenAIResponsesClient(config);
    return { complete: async ({ systemInstruction, userInstruction, signal }: {
      systemInstruction: string; userInstruction: string; signal: AbortSignal;
    }) => {
      const outcome = await client.complete({ systemInstruction, input: userInstruction,
        format: phase === 'primary' ? SEMANTIC_INTENT_PRIMARY_V3_FORMAT : SEMANTIC_INTENT_FIDELITY_V3_FORMAT,
        signal });
      if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code,
        outcome.completedMalformedOutput === true);
      try {
        const parsed = JSON.parse(outcome.output) as unknown;
        return JSON.stringify(phase === 'primary' ? SemanticIntentPrimaryWireV3Schema.parse(parsed) :
          SemanticIntentFidelityWireV3Schema.parse(parsed));
      } catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true); }
    } };
  };
  return { primary: adapter(primaryConfig, 'primary'), reviewer: adapter(reviewerConfig, 'reviewer') };
}
