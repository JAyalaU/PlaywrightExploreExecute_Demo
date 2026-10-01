import type { OpenAIResponseFailureCode } from './openai-responses.js';

/** Stable, sanitized provider failure reason safe for ordinary M7 records. */
export class ModelCompletionFailure extends Error {
  constructor(readonly code: OpenAIResponseFailureCode, readonly completedMalformedOutput = false) {
    super(code);
    this.name = 'ModelCompletionFailure';
  }
}
