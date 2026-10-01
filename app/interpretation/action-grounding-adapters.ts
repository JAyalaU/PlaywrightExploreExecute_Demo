import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { ModelCompletionFailure } from './model-failure.js';
import { ACTION_GROUNDING_RESPONSE_FORMAT, ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT, normalizeGroundingWire } from './action-grounding-wire.js';
import { ACTION_GROUNDING_PRIMARY_INSTRUCTION, ACTION_GROUNDING_INDEPENDENT_INSTRUCTION,
  type ActionGroundingModelV5, type IndependentGroundingModelV1 } from './action-grounding-controller.js';

export function createOpenAIActionGroundingModelsV1(config: OpenAIResponsesConfig): {
  primary: ActionGroundingModelV5; independent: IndependentGroundingModelV1;
} {
  const client = createOpenAIResponsesClient(config);
  const call = async (context: unknown, signal: AbortSignal, independent: boolean) => {
    const outcome = await client.complete({ systemInstruction: independent ? ACTION_GROUNDING_INDEPENDENT_INSTRUCTION : ACTION_GROUNDING_PRIMARY_INSTRUCTION,
      input: JSON.stringify(context), signal, format: independent ? ACTION_GROUNDING_INDEPENDENT_RESPONSE_FORMAT : ACTION_GROUNDING_RESPONSE_FORMAT });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try { return normalizeGroundingWire(JSON.parse(outcome.output), independent); }
    catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
  };
  return { primary: { complete: ({ context, signal }) => call(context, signal, false) },
    independent: { extract: ({ context, signal }) => call(context, signal, true) } };
}
