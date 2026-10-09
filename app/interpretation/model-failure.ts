import type { OpenAIResponseFailureCode } from './openai-responses.js';
import type { SemanticPrimaryOutputDiagnosticV1 } from './semantic-primary-output-diagnostic-v1.js';

/** Stable, sanitized provider failure reason safe for ordinary M7 records. */
export class ModelCompletionFailure extends Error {
  constructor(readonly code: OpenAIResponseFailureCode, readonly completedMalformedOutput = false,
    readonly semanticPrimaryDiagnostic?: SemanticPrimaryOutputDiagnosticV1) {
    super(code);
    this.name = 'ModelCompletionFailure';
  }
}
