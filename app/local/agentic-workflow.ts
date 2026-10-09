import { NativeProfileCatalog } from '../profile/native-profile.js';
import { validateNativePublicTargetApproval } from '../profile/native-admission.js';
import { LocalWorkflowError } from './workflow-error.js';
import { runSemanticGeneralLocalWorkflowV1, type SemanticGeneralLocalOptionsV1 } from './semantic-general-workflow.js';
import { LocalWorkflowRequestSchema, parseProductTrustedConfiguration,
  requireSemanticGeneralProductEnvironment, selectNativeLocalWindowsProductProfile,
  type LocalWorkflowTrustedDependencies } from './product-contracts.js';
import type { SubprocessResponseV2 } from '../subprocess/protocol-v2.js';
import { OFFLINE_SEMANTIC_FIXTURE_AUTHORITY } from './offline-fixture-authority.js';

/** One trusted v2 job. The request never chooses its workflow or policy. */
export async function runAgenticLocalWorkflow(requestInput: unknown, configInput: unknown,
  dependencies: LocalWorkflowTrustedDependencies, options: { signal?: AbortSignal;
    workflowVersion?: 'semantic-general-v1';
    offlineFixtureAuthority?: typeof OFFLINE_SEMANTIC_FIXTURE_AUTHORITY } & SemanticGeneralLocalOptionsV1 = {},
): Promise<SubprocessResponseV2> {
  const workflowVersion = options.workflowVersion ?? 'semantic-general-v1';
  if (workflowVersion !== 'semantic-general-v1') throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  try {
    requireSemanticGeneralProductEnvironment();
  } catch { throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }
  const request = LocalWorkflowRequestSchema.parse(requestInput);
  const config = parseProductTrustedConfiguration(configInput);
  try {
    const selected = selectNativeLocalWindowsProductProfile(config);
    if (!config.publicTargetApproval &&
        (options.offlineFixtureAuthority !== OFFLINE_SEMANTIC_FIXTURE_AUTHORITY ||
          !options.semanticModels))
      throw new Error('Trusted public target approval is required');
    if (request.executionProfileRef.id !== selected.reference.id ||
        request.executionProfileRef.version !== selected.reference.version)
      throw new Error('Request profile does not match trusted local selection');
    if (config.publicTargetApproval) validateNativePublicTargetApproval(config.publicTargetApproval,
      new NativeProfileCatalog(config.profiles).resolve(selected.reference), request.targetUrl);
  } catch { throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION'); }
  const catalog = new NativeProfileCatalog(config.profiles);
  try { catalog.resolve(request.executionProfileRef); }
  catch { throw new LocalWorkflowError('PROFILE_UNAVAILABLE'); }
  if (options.signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  return runSemanticGeneralLocalWorkflowV1(request, config, catalog, dependencies, options);
}
