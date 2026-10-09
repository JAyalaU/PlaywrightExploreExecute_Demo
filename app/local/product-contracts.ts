import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/shared-contracts.js';
import type { TrustedSemanticSourceV3 } from '../domain/semantic-intent-v3.js';
import type { OpenAIResponsesConfig } from '../interpretation/openai-responses.js';
import { LocalWindowsExecutionProfileSchema, NativeProfileCatalog } from '../profile/native-profile.js';
import { NativePublicTargetApprovalSchema, validateNativePublicTargetApproval } from '../profile/native-admission.js';
import type { AuthStateProvider } from '../profile/local-context.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const url = z.string().url().refine(value => {
  const parsed = new URL(value);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}, 'Expected an absolute HTTP(S) URL');

export const LocalWorkflowRequestSchema = z.strictObject({
  taskText: z.string().min(1).refine(value => value.trim().length > 0),
  targetUrl: url,
  executionProfileRef: ExecutionProfileRefSchema,
});
export type LocalWorkflowRequest = z.infer<typeof LocalWorkflowRequestSchema>;
export function toInterpretationRequest(requestInput: unknown, testSpecId: string): TrustedSemanticSourceV3 {
  const request = LocalWorkflowRequestSchema.parse(requestInput);
  return { sourceInstruction: request.taskText, testSpecId: id.parse(testSpecId),
    executionProfileRef: request.executionProfileRef, startState: { url: request.targetUrl } };
}

export const LocalEvidencePolicySchema = z.strictObject({
  finalScreenshot: z.boolean(), failureScreenshot: z.boolean(), failureTrace: z.boolean(),
  failureVideo: z.boolean(), sensitiveBinaryApproved: z.boolean(),
}).superRefine((policy, context) => {
  if (!policy.sensitiveBinaryApproved &&
      (policy.finalScreenshot || policy.failureScreenshot || policy.failureTrace || policy.failureVideo))
    context.addIssue({ code: 'custom', path: ['sensitiveBinaryApproved'], message: 'Binary capture requires approval' });
});
export const LiveImagePolicySchema = z.strictObject({ liveImagePolicyVersion: z.literal('1'),
  captureApproved: z.boolean(), displayApproved: z.boolean() });
export const LiveViewerPolicySchema = z.strictObject({ liveViewerPolicyVersion: z.literal('1'),
  displayApproved: z.boolean() });

export const ProductTrustedConfigurationSchema = z.strictObject({
  profiles: z.array(LocalWindowsExecutionProfileSchema).min(1),
  evidencePolicy: LocalEvidencePolicySchema,
  liveImagePolicy: LiveImagePolicySchema.optional(),
  liveViewerPolicy: LiveViewerPolicySchema.optional(),
  artifactRoot: z.string().min(1),
  retentionDays: z.number().int().min(1).max(365),
  publicTargetApproval: NativePublicTargetApprovalSchema.optional(),
});
export type ProductTrustedConfiguration = z.infer<typeof ProductTrustedConfigurationSchema>;

export function parseProductTrustedConfiguration(input: unknown): ProductTrustedConfiguration {
  const config = ProductTrustedConfigurationSchema.parse(input);
  const catalog = new NativeProfileCatalog(config.profiles);
  for (const profile of config.profiles) catalog.resolve({ id: profile.id, version: profile.version });
  return config;
}

export function requireSemanticGeneralProductEnvironment(): void {
  const workflow = process.env.PLAYWRIGHT_DEMO_WORKFLOW_VERSION;
  const backend = process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND;
  if ((workflow !== undefined && workflow !== '' && workflow !== 'semantic-general-v1') ||
      (backend !== undefined && backend !== ''))
    throw new Error('Unsupported product workflow or browser backend');
}

export function selectNativeLocalWindowsProductProfile(config: ProductTrustedConfiguration) {
  const localProfiles = config.profiles;
  const approvedRef = config.publicTargetApproval?.executionProfileRef;
  const selected = approvedRef
    ? localProfiles.find(profile => profile.id === approvedRef.id && profile.version === approvedRef.version)
    : localProfiles.length === 1 ? localProfiles[0] : undefined;
  if (!selected) throw new Error('No unambiguous trusted local Windows profile');
  const reference = { id: selected.id, version: selected.version };
  const effective = new NativeProfileCatalog(config.profiles).resolve(reference);
  if (config.publicTargetApproval) validateNativePublicTargetApproval(config.publicTargetApproval, effective);
  return { config, reference, fingerprint: effective.fingerprint };
}

export interface LocalWorkflowTrustedDependencies {
  provider: OpenAIResponsesConfig;
  authProvider?: AuthStateProvider;
}
