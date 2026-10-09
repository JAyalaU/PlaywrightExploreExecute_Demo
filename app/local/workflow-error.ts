export type LocalWorkflowFailureCode =
  | 'INVALID_REQUEST' | 'INVALID_TRUSTED_CONFIGURATION' | 'PROFILE_UNAVAILABLE'
  | 'DESTINATION_DENIED' | 'PROVIDER_CONFIGURATION_ERROR' | 'CANCELLED'
  | 'WORKFLOW_FAILED' | 'REPORT_INVALID';

/** Closed launch/transport failure, separate from the semantic QA terminal. */
export class LocalWorkflowError extends Error {
  constructor(readonly code: LocalWorkflowFailureCode) {
    super(code);
    this.name = 'LocalWorkflowError';
  }
}
