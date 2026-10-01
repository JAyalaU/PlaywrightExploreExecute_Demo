import type { InterpretationModel } from './interpret.js';
import { ModelCompletionFailure } from './model-failure.js';
import type { StepDecisionModel } from './orchestrate.js';
import { createOpenAIResponsesClient, type OpenAIResponsesConfig } from './openai-responses.js';
import { DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT,
  normalizeDeferredActionInterpretationWire } from './deferred-action-wire.js';
import {
  INTERPRETATION_RESPONSE_FORMAT, STEP_DECISION_RESPONSE_FORMAT,
  AGENTIC_INTERPRETATION_RESPONSE_FORMAT, normalizeAgenticInterpretationWire,
  STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT, normalizeStructuredActionInterpretationWire,
  AGENTIC_DECISION_RESPONSE_FORMAT,
  normalizeInterpretationWire, normalizeStepDecisionWire,
} from './openai-wire.js';
import { AgenticDecisionV3Schema, type AgenticDecisionModelV3 } from './agentic-controller.js';
import type { AgenticVerificationModelV4 } from './verification-strategy.js';
import { AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT,
  normalizeAgenticVerificationDecisionWire } from './verification-wire.js';

/** Supply these two adapters to the unchanged handoffTask entry point. */
export function createOpenAIModelAdapters(config: OpenAIResponsesConfig): {
  interpretationModel: InterpretationModel;
  stepDecisionModel: StepDecisionModel;
} {
  const client = createOpenAIResponsesClient(config);

  const complete = async (
    systemInstruction: string, input: string, signal: AbortSignal,
    format: typeof INTERPRETATION_RESPONSE_FORMAT | typeof STEP_DECISION_RESPONSE_FORMAT,
    normalize: (wire: unknown) => string,
  ): Promise<string> => {
    const outcome = await client.complete({ systemInstruction, input, format, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try {
      return normalize(JSON.parse(outcome.output) as unknown);
    } catch {
      throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID');
    }
  };

  return {
    interpretationModel: {
      complete: ({ systemInstruction, userInstruction, signal }) =>
        complete(systemInstruction, userInstruction, signal,
          INTERPRETATION_RESPONSE_FORMAT, normalizeInterpretationWire),
    },
    stepDecisionModel: {
      complete: ({ systemInstruction, context, signal }) =>
        complete(systemInstruction, JSON.stringify(context), signal,
          STEP_DECISION_RESPONSE_FORMAT, normalizeStepDecisionWire),
    },
  };
}

/** Agentic-only interpretation wire; legacy handoff retains the original format. */
export function createOpenAIAgenticInterpretationModel(config: OpenAIResponsesConfig): InterpretationModel {
  const client = createOpenAIResponsesClient(config);
  return { complete: async ({ systemInstruction, userInstruction, signal }) => {
    const outcome = await client.complete({ systemInstruction, input: userInstruction,
      format: AGENTIC_INTERPRETATION_RESPONSE_FORMAT, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try { return normalizeAgenticInterpretationWire(JSON.parse(outcome.output) as unknown); }
    catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
  } };
}

/** TestSpec v5 interpretation adapter selected only by the structured-action-v1 workflow. */
export function createOpenAIStructuredActionInterpretationModel(config: OpenAIResponsesConfig): InterpretationModel {
  const client = createOpenAIResponsesClient(config);
  return { complete: async ({ systemInstruction, userInstruction, signal }) => {
    const outcome = await client.complete({ systemInstruction, input: userInstruction,
      format: STRUCTURED_ACTION_INTERPRETATION_RESPONSE_FORMAT, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try { return normalizeStructuredActionInterpretationWire(JSON.parse(outcome.output) as unknown); }
    catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
  } };
}

/** Separate TestSpec v6 source adapter; no workflow selection or older-format fallback. */
export function createOpenAIDeferredActionInterpretationModel(config: OpenAIResponsesConfig): InterpretationModel {
  const client = createOpenAIResponsesClient(config);
  return { complete: async ({ systemInstruction, userInstruction, signal }) => {
    const outcome = await client.complete({ systemInstruction, input: userInstruction,
      format: DEFERRED_ACTION_INTERPRETATION_RESPONSE_FORMAT, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try { return normalizeDeferredActionInterpretationWire(JSON.parse(outcome.output) as unknown); }
    catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
  } };
}

/** Trusted M7-v3 adapter. It shares the bounded Responses transport but not the legacy decision schema. */
export function createOpenAIAgenticDecisionModel(config: OpenAIResponsesConfig): AgenticDecisionModelV3 {
  const client = createOpenAIResponsesClient(config);
  return { complete: async ({ systemInstruction, context, signal }) => {
    const outcome = await client.complete({ systemInstruction,
      input: JSON.stringify(context), format: AGENTIC_DECISION_RESPONSE_FORMAT, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try {
      const parsed = JSON.parse(outcome.output) as unknown;
      const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as { response?: unknown } : undefined;
      const raw = envelope?.response;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid agentic decision envelope');
      const normalized = { ...raw as Record<string, unknown> };
      if (normalized.focus === null) delete normalized.focus;
      if (normalized.prerequisiteReasonCode === null) delete normalized.prerequisiteReasonCode;
      return JSON.stringify(AgenticDecisionV3Schema.parse(normalized));
    } catch {
      throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID');
    }
  } };
}

/** Private M7-v4 verification adapter; it does not alter the released v3 action adapter. */
export function createOpenAIVerificationDecisionModel(config: OpenAIResponsesConfig): AgenticVerificationModelV4 {
  const client = createOpenAIResponsesClient(config);
  return { complete: async ({ systemInstruction, context, signal }) => {
    const outcome = await client.complete({ systemInstruction, input: JSON.stringify(context),
      format: AGENTIC_VERIFICATION_DECISION_RESPONSE_FORMAT, signal });
    if (outcome.kind === 'failure') throw new ModelCompletionFailure(outcome.code);
    try { return normalizeAgenticVerificationDecisionWire(JSON.parse(outcome.output) as unknown); }
    catch { throw new ModelCompletionFailure('PROVIDER_OUTPUT_INVALID'); }
  } };
}
