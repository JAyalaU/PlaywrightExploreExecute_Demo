import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { ModelCompletionFailure } from './model-failure.js';
import { POC_FIDELITY_RESPONSE_FORMAT, POC_PRIMARY_RESPONSE_FORMAT,
  PocFidelityWireSchema, PocPrimaryWireSchema } from './deferred-action-poc-wire.js';
import { liveProviderDebugEnabled, recordLiveProviderAttempt, recordLiveProviderFailure } from './deferred-action-v2-live-debug.js';
import type { PocSemanticModels } from './deferred-action-poc-interpret.js';
import { diagnoseZodStructure } from './deferred-action-v2-structural.js';
import type { DeferredInterpretationStructuralV1 } from '../domain/deferred-interpretation-structural.js';

export function createOpenAIPocSemanticModels(primaryConfig: OpenAIResponsesConfig,
  reviewerConfig: OpenAIResponsesConfig = primaryConfig): PocSemanticModels {
  const adapter = (config: OpenAIResponsesConfig, phase: 'primary' | 'independent') => {
    const client = createOpenAIResponsesClient(config);
    const format = phase === 'primary' ? POC_PRIMARY_RESPONSE_FORMAT : POC_FIDELITY_RESPONSE_FORMAT;
    const schema = phase === 'primary' ? PocPrimaryWireSchema : PocFidelityWireSchema;
    return { complete: async ({ systemInstruction, userInstruction, signal, onProviderCompleted, onStructuralIssue }: {
      systemInstruction: string; userInstruction: string; signal: AbortSignal;
      onProviderCompleted?: (state?: 'completed' | 'incomplete' | 'unavailable') => void;
      onStructuralIssue?: (issue: DeferredInterpretationStructuralV1) => void;
    }) => {
      const started = Date.now();
      const outcome = await client.complete({ systemInstruction, input: userInstruction, format, signal });
      onProviderCompleted?.(outcome.kind === 'completed' ? 'completed' : outcome.providerResponseState ?? 'unavailable');
      if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code, outcome.completedMalformedOutput === true);
      let wire: unknown;
      try { wire = JSON.parse(outcome.output) as unknown; }
      catch (error) {
        onStructuralIssue?.(diagnoseZodStructure(undefined, phase, 'wire_normalization'));
        recordLiveProviderFailure({ phase, responseFormat: format.name, normalizer: 'poc_semantic_wire_v1',
          model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed', elapsedMs: Date.now() - started,
          kind: 'malformed_provider_json', error });
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID', true);
      }
      try {
        const parsed = schema.parse(wire);
        const normalized = JSON.stringify(parsed);
        if (liveProviderDebugEnabled()) recordLiveProviderAttempt({ phase, responseFormat: format.name,
          model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed',
          elapsedMs: Date.now() - started,
          normalizedOutcomeKind: phase === 'primary' ? (parsed as { response: { kind: 'extraction' | 'unresolved' | 'authored_ambiguity' } }).response.kind :
            (parsed as { response: { verdict: 'faithful' | 'not_faithful' } }).response.verdict,
          wireSnapshot: JSON.stringify(wire) });
        return normalized;
      } catch (error) {
        onStructuralIssue?.(diagnoseZodStructure(error, phase, 'wire_normalization', wire));
        recordLiveProviderFailure({ phase, responseFormat: format.name, normalizer: 'poc_semantic_wire_v1',
          model: config.model ?? 'gpt-5.6-terra', providerCompletionState: 'completed', elapsedMs: Date.now() - started,
          kind: 'closed_wire_schema_failure', error,
          ...(liveProviderDebugEnabled() ? { wireSnapshot: JSON.stringify(wire) } : {}) });
        throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID');
      }
    } };
  };
  return { primary: adapter(primaryConfig, 'primary'), reviewer: adapter(reviewerConfig, 'independent') };
}
