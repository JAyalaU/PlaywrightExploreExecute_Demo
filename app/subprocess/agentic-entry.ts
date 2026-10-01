import type { Readable } from 'node:stream';
import { LocalWorkflowError } from '../local/workflow.js';
import { runAgenticLocalWorkflow } from '../local/agentic-workflow.js';
import type { LocalWorkflowTrustedDependencies } from '../local/contracts.js';
import { readSubprocessRequest } from './entry.js';
import { parseSubprocessRequestV2, SUBPROCESS_PROTOCOL_V2,
  type SubprocessResponseV2 } from './protocol-v2.js';
import { SubprocessProtocolError } from './protocol.js';

export async function runAgenticSubprocessAdapterV2(input: Readable,
  loadConfiguration: () => Promise<unknown>, dependencies: LocalWorkflowTrustedDependencies,
  options: { signal?: AbortSignal;
    workflowVersion?: 'agentic-exploration-v1' | 'goal-directed-v1' | 'structured-action-v1' | 'deferred-action-v1';
    workflow?: typeof runAgenticLocalWorkflow } = {}): Promise<SubprocessResponseV2> {
  let started = false;
  try {
    const request = parseSubprocessRequestV2(await readSubprocessRequest(input, options.signal));
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    const config = await loadConfiguration();
    if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    started = true;
    return await (options.workflow ?? runAgenticLocalWorkflow)(request.request, config, dependencies,
      { ...(options.signal ? { signal: options.signal } : {}),
        workflowVersion: options.workflowVersion ?? 'agentic-exploration-v1' });
  } catch (error) {
    const failure = options.signal?.aborted ? new LocalWorkflowError('CANCELLED') : error;
    const code = failure instanceof SubprocessProtocolError
      ? failure.code === 'PROTOCOL_UNSUPPORTED_VERSION' || failure.code === 'REQUEST_TOO_LARGE'
        ? failure.code : 'PROTOCOL_INVALID'
      : failure instanceof LocalWorkflowError ? failure.code : 'WORKFLOW_FAILED';
    const noResources = failure instanceof LocalWorkflowError && [
      'INVALID_REQUEST', 'INVALID_TRUSTED_CONFIGURATION', 'PROFILE_UNAVAILABLE',
      'DESTINATION_DENIED', 'PROVIDER_CONFIGURATION_ERROR',
    ].includes(failure.code);
    return { protocolVersion: SUBPROCESS_PROTOCOL_V2, kind: 'bridge_error', code,
      cleanup: started && !noResources ? 'unverified' : 'not_started' };
  }
}
