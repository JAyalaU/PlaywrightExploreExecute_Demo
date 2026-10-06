import { requireTrustedSemanticIntentAdmissionV3,
  type TrustedSemanticIntentAdmissionV3 } from '../domain/semantic-intent-v3.js';
import { requireIssuedSemanticGroundedTraceV1, type SemanticGroundedTraceV1,
  type SemanticCompilerAttemptV5 } from '../domain/semantic-resolved-v10.js';
import { ProtectedContextFactory } from '../profile/context.js';
import { compileSemanticGroundedTraceV1 } from '../exploration/semantic-trace-compiler-v5.js';
import { SemanticCompilerV5Store } from '../evidence/semantic-compiler-store-v5.js';
import { SemanticCompilerDiagnosticsV1Store } from '../evidence/semantic-compiler-diagnostics-v1.js';
import { SemanticReplayV2Store, requireTrustedSemanticReplayReadbackV2,
  type TrustedSemanticReplayReadbackV2 } from '../evidence/semantic-replay-store-v2.js';
import { runSemanticTwoFreshReplaysV2 } from './semantic-replay-v2.js';

export const SEMANTIC_GENERAL_WORKFLOW_VERSION = 'semantic-general-v1' as const;
/** Selection belongs to trusted operator launch state, never to authored test text or model output. */
export function semanticGeneralOfflineReviewEnabled(): boolean {
  return process.env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION === SEMANTIC_GENERAL_WORKFLOW_VERSION &&
    process.env.PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE === 'offline-review';
}

/** Separately selectable validation route for already admitted v7 intent and issued protected trace. */
export async function runSemanticGeneralizedOptInV1(factory: ProtectedContextFactory,
  artifactRoot: string, admission: TrustedSemanticIntentAdmissionV3, trace: SemanticGroundedTraceV1):
  Promise<{ workflowVersion: typeof SEMANTIC_GENERAL_WORKFLOW_VERSION; kind: 'compilation_stop';
    compiler: SemanticCompilerAttemptV5 } | {
    workflowVersion: typeof SEMANTIC_GENERAL_WORKFLOW_VERSION; kind: 'replayed';
    terminal: 'QA_PASS' | 'QA_FAIL' | 'NON_QA'; compilerAttemptId: string;
    replay: TrustedSemanticReplayReadbackV2 }> {
  if (!semanticGeneralOfflineReviewEnabled()) throw new Error('SEMANTIC_GENERAL_WORKFLOW_NOT_SELECTED');
  requireTrustedSemanticIntentAdmissionV3(admission);
  requireIssuedSemanticGroundedTraceV1(trace);
  const diagnostics = new SemanticCompilerDiagnosticsV1Store(artifactRoot);
  await diagnostics.writeTrace(trace, admission);
  const compiled = await compileSemanticGroundedTraceV1(factory, admission, trace);
  if (compiled.kind !== 'compiled' || !compiled.resolved) {
    await diagnostics.writeRejection(compiled, trace);
    return { workflowVersion: SEMANTIC_GENERAL_WORKFLOW_VERSION, kind: 'compilation_stop',
      compiler: compiled.compiler };
  }
  const readback = await new SemanticCompilerV5Store(artifactRoot).writeCompilationV5(
    compiled, admission, trace);
  // Diagnostic persistence must not become replay or QA authority.
  await diagnostics.writeAcceptedSeal(compiled, trace).catch(() => undefined);
  const replay = await runSemanticTwoFreshReplaysV2(factory, readback);
  const persisted = await new SemanticReplayV2Store(artifactRoot).writeReplayV2(replay, readback);
  return { workflowVersion: SEMANTIC_GENERAL_WORKFLOW_VERSION, kind: 'replayed',
    terminal: requireTrustedSemanticReplayReadbackV2(persisted).terminal,
    compilerAttemptId: compiled.compiler.compilerAttemptId, replay: persisted };
}
