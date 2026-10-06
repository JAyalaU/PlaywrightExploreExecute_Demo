import { randomUUID } from 'node:crypto';
import { ProtectedContextFactory } from '../profile/context.js';
import { profilePresentationMode } from '../profile/contracts.js';
import { requireTrustedResolvedTestReadbackV9, type TrustedResolvedTestReadbackV9 } from '../evidence/deferred-compiler-store-v4.js';
import { runDeferredResolvedTestV9, requireTrustedDeferredRunV9 } from '../runner/deferred-v9.js';
import { candidateGroundingDigest as hash } from '../domain/action-candidate-grounding.js';
import { DeferredReplayRecordV1Schema, deriveDeferredAgreementV1, parseDeferredReplayRecordV1, deferredResultRecordV2,
  type DeferredReplayRecordV1 } from '../domain/deferred-action-replay.js';
import type { DeferredRunnerRecordV9 } from '../domain/deferred-action-runner.js';
import type { DeferredNavigationTimingObserver } from '../domain/deferred-navigation-timing.js';
import type { DeferredBrowserDiagnosticSink } from '../domain/deferred-browser-diagnostics.js';

const issued = new WeakSet<object>(), authority = Symbol('deferred-two-replay-origin');
export class TrustedDeferredReplayV1 {
  readonly #record: DeferredReplayRecordV1;
  constructor(token: symbol, record: DeferredReplayRecordV1) {
    if (token !== authority) throw new Error('Trusted two-replay origin required');
    this.#record = structuredClone(record); issued.add(this);
  }
  protectedRecord() { return structuredClone(this.#record); }
}
export function requireTrustedDeferredReplayV1(input: TrustedDeferredReplayV1): DeferredReplayRecordV1 {
  if (!issued.has(input)) throw new Error('Untrusted two-replay origin');
  return TrustedDeferredReplayV1.prototype.protectedRecord.call(input);
}
/** Sequential fresh replays; each invocation owns and closes its protected session. No retry or repair. */
export async function runDeferredTwoFreshReplaysV1(factory: ProtectedContextFactory, input: TrustedResolvedTestReadbackV9,
  onRunStart?: (ordinal: 1 | 2) => void,onNavigationTiming?:DeferredNavigationTimingObserver,
  onBrowserDiagnostic?:DeferredBrowserDiagnosticSink): Promise<TrustedDeferredReplayV1> {
  const artifact = requireTrustedResolvedTestReadbackV9(input);
  // Approval, profile matching and fresh session launch remain entirely with the runner.
  let presentationMode: 'headless' | 'headed' = 'headless';
  try { presentationMode = profilePresentationMode(factory.catalog.resolve(artifact.resolved.executionProfileRef).profile); }
  catch { /* No-browser administrative default only. The runner emits a non-QA environment stop for absent approval. */ }
  const startedAt = new Date().toISOString(), runs: DeferredRunnerRecordV9[] = [];
  let hostStop: DeferredReplayRecordV1['hostStop'];
  for (let index = 0; index < 2; index++) {
    let run: DeferredRunnerRecordV9;
    try {
      onRunStart?.(index === 0 ? 1 : 2);
      run = requireTrustedDeferredRunV9(await runDeferredResolvedTestV9(factory, input,onNavigationTiming,index===0?'replay_1':'replay_2',onBrowserDiagnostic));
    }
    catch { hostStop = 'RUNNER_ENVIRONMENT_FAILURE'; break; }
    runs.push(run);
    if (run.cleanup !== 'verified' || run.result.kind !== 'completed') break;
  }
  const data = { orchestrationVersion: '1' as const, orchestrationId: `replay-pair-${randomUUID()}`, startedAt,
    finishedAt: new Date().toISOString(), presentationMode, runs, ...(hostStop ? { hostStop } : {}), agreement: deriveDeferredAgreementV1(runs, hostStop) };
  const { recordDigest: _unused, ...canonical } = DeferredReplayRecordV1Schema.parse({ ...data, recordDigest: '0'.repeat(64) });
  const record = parseDeferredReplayRecordV1({ ...canonical, recordDigest: hash(canonical) }, artifact);
  // Validate external terminal now; persistence cannot later reinterpret execution.
  deferredResultRecordV2(record, artifact);
  return new TrustedDeferredReplayV1(authority, record);
}
