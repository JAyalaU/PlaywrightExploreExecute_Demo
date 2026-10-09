import type { TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';
import { SemanticPrimaryOutputDiagnosticsV1Store } from
  '../evidence/semantic-primary-output-diagnostics-v1.js';
import { interpretSemanticIntentV3, type SemanticIntentModelsV3,
  type SemanticIntentOutcomeV3 } from './semantic-intent-v3.js';

/** A required restricted evidence write failed; no output-invalid terminal may be claimed. */
export class SemanticPrimaryDiagnosticPersistenceFailureV1 extends Error {
  constructor() { super('SEMANTIC_PRIMARY_DIAGNOSTIC_PERSISTENCE_FAILED'); }
}

/** Shared production interpretation entrypoint for local workflow and fixture tooling. */
export async function interpretSemanticIntentWithEvidenceV3(source: TrustedSemanticSourceV3,
  models: SemanticIntentModelsV3, artifactRoot: string,
  signal: AbortSignal = new AbortController().signal): Promise<SemanticIntentOutcomeV3> {
  const result = await interpretSemanticIntentV3(source, models, signal);
  if (result.kind !== 'rejected' || result.code !== 'PROVIDER_OUTPUT_INVALID') return result;
  if (!result.primaryOutputDiagnostic) throw new SemanticPrimaryDiagnosticPersistenceFailureV1();
  try {
    const store = new SemanticPrimaryOutputDiagnosticsV1Store(artifactRoot);
    await store.write(source.testSpecId, result.primaryOutputDiagnostic);
    const readback = await store.readByCorrelation({ testSpecId: source.testSpecId });
    if (readback.length !== 1 || readback[0]?.testSpecId !== source.testSpecId)
      throw new Error('Diagnostic readback absent');
  } catch { throw new SemanticPrimaryDiagnosticPersistenceFailureV1(); }
  return result;
}
