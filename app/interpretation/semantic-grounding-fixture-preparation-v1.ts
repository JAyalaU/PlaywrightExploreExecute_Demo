import type { TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';
import type { SemanticIntentModelsV3, SemanticIntentOutcomeV3 } from './semantic-intent-v3.js';
import { interpretSemanticIntentWithEvidenceV3, SemanticPrimaryDiagnosticPersistenceFailureV1 } from
  './semantic-intent-v3-boundary.js';

export type SemanticGroundingFixtureInterpretationOutcomeV1 = SemanticIntentOutcomeV3 | {
  kind: 'rejected'; code: 'SEMANTIC_PRIMARY_DIAGNOSTIC_PERSISTENCE_FAILED' |
    'UNEXPECTED_CLOSED_FAILURE';
};

/** The fixture driver's one-shot interpretation entrypoint; no browser or grounding work. */
export async function prepareSemanticGroundingFixtureInterpretationV1(source: TrustedSemanticSourceV3,
  models: SemanticIntentModelsV3, artifactRoot: string,
  signal: AbortSignal): Promise<SemanticGroundingFixtureInterpretationOutcomeV1> {
  try { return await interpretSemanticIntentWithEvidenceV3(source, models, artifactRoot, signal); }
  catch (error) { return { kind: 'rejected', code: error instanceof
    SemanticPrimaryDiagnosticPersistenceFailureV1 ?
      'SEMANTIC_PRIMARY_DIAGNOSTIC_PERSISTENCE_FAILED' : 'UNEXPECTED_CLOSED_FAILURE' }; }
}
