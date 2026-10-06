import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/schema.js';

const ref = ExecutionProfileRefSchema;
const milliseconds = z.number().int().positive().max(120_000);

const executionProfileFields = {
  id: ref.shape.id,
  version: ref.shape.version,
  browser: z.literal('chromium'),
  viewport: z.strictObject({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320) }),
  locale: z.string().min(2),
  timezoneId: z.string().min(1).optional(),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  deviceScaleFactor: z.number().min(0.25).max(4).optional(),
  isMobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
  javaScriptEnabled: z.boolean().optional(),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  timeoutPolicy: z.strictObject({
    actionMs: milliseconds,
    navigationMs: milliseconds,
    waits: z.record(ref.shape.id, milliseconds),
  }),
  networkPolicyRef: ref.optional(),
  authStateRef: ref.optional(),
};

/** Legacy profiles are headless at every existing ID/version and retain their serialized shape. */
export const LegacyExecutionProfileSchema = z.strictObject(executionProfileFields);

export const ExecutionProfileV2Schema = z.strictObject({
  ...executionProfileFields,
  profileSchemaVersion: z.literal('2'),
  presentationMode: z.enum(['headless', 'headed']),
});

/** Public browser isolation is a new profile identity; existing fingerprints stay intact. */
export const IsolatedExecutionProfileSchema = z.strictObject({
  ...executionProfileFields,
  profileSchemaVersion: z.literal('3'),
  presentationMode: z.literal('headless'),
  browserIsolation: z.literal('docker'),
});

/** A distinct approved identity for the disposable headed browser image. */
export const IsolatedHeadedExecutionProfileSchema = z.strictObject({
  ...executionProfileFields,
  profileSchemaVersion: z.literal('4'),
  presentationMode: z.literal('headed'),
  browserIsolation: z.literal('docker'),
});

/** Windows owns a local Playwright Chromium process, without Docker isolation claims. */
const { networkPolicyRef: _historicalNetworkPolicyRef, ...localProfileFields } = executionProfileFields;
export const LocalWindowsExecutionProfileSchema = z.strictObject({
  ...localProfileFields,
  networkPolicyRef: z.never().optional(),
  profileSchemaVersion: z.literal('5'),
  presentationMode: z.enum(['headless', 'headed']),
  browserIsolation: z.literal('local-windows'),
  browserRuntime: z.literal('playwright-chromium-windows'),
});

export const ExecutionProfileSchema = z.union([
  LocalWindowsExecutionProfileSchema,
  IsolatedHeadedExecutionProfileSchema,
  IsolatedExecutionProfileSchema,
  ExecutionProfileV2Schema,
  LegacyExecutionProfileSchema,
]);

const address = z.string().refine((value) => isIP(value) !== 0, 'Expected an IP literal');
const host = z.string().min(1).refine((value) => {
  try {
    const parsed = new URL(`http://${value}/`);
    return !parsed.username && !parsed.password && !parsed.port &&
      parsed.hostname === value.toLowerCase() && !value.includes('/') && !value.includes('*');
  } catch { return false; }
}, 'Expected one exact normalized hostname or IP literal');

export const NetworkPolicySchema = z.strictObject({
  id: ref.shape.id,
  version: ref.shape.version,
  destinations: z.array(z.strictObject({
    host,
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
    addresses: z.array(address).min(1),
  })),
}).superRefine((policy, context) => {
  const pairs = new Set<string>();
  for (const [index, destination] of policy.destinations.entries()) {
    for (const port of destination.ports) {
      const pair = `${destination.host}:${port}`;
      if (pairs.has(pair)) context.addIssue({ code: 'custom', path: ['destinations', index], message: `Duplicate destination ${pair}` });
      pairs.add(pair);
    }
  }
});

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type PresentationMode = z.infer<typeof ExecutionProfileV2Schema>['presentationMode'];

export function profilePresentationMode(profile: ExecutionProfile): PresentationMode {
  return 'profileSchemaVersion' in profile ? profile.presentationMode : 'headless';
}
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type ProfileRef = z.infer<typeof ExecutionProfileRefSchema>;
export type EffectiveProfile = Readonly<{ profile: ExecutionProfile; policy: NetworkPolicy; fingerprint: string }>;

function key(refValue: ProfileRef): string { return `${refValue.id}\0${refValue.version}`; }
function fingerprint(profile: ExecutionProfile, policy: NetworkPolicy): string {
  // Destination policy is retained only to read older configurations. It is not
  // runtime authority and must not change the effective browser identity.
  const { networkPolicyRef: _legacy, ...runtimeProfile } = profile;
  void policy;
  return createHash('sha256').update(JSON.stringify(runtimeProfile)).digest('hex');
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** An immutable in-process catalog. M5 owns persistence and readback. */
export class ProfileCatalog {
  readonly #profiles = new Map<string, ExecutionProfile>();
  readonly #policies = new Map<string, NetworkPolicy>();

  constructor(profiles: readonly unknown[], policies: readonly unknown[] = []) {
    for (const input of profiles) {
      const profile = ExecutionProfileSchema.parse(input);
      if (this.#profiles.has(key(profile))) throw new Error(`Duplicate execution profile ${profile.id}@${profile.version}`);
      this.#profiles.set(key(profile), structuredClone(profile));
    }
    for (const input of policies) {
      const policy = NetworkPolicySchema.parse(input);
      if (this.#policies.has(key(policy))) throw new Error(`Duplicate network policy ${policy.id}@${policy.version}`);
      this.#policies.set(key(policy), structuredClone(policy));
    }
  }

  resolve(input: unknown): EffectiveProfile {
    const reference = ExecutionProfileRefSchema.parse(input);
    const profile = this.#profiles.get(key(reference));
    if (!profile) throw new Error(`Unavailable execution profile ${reference.id}@${reference.version}`);
    const policy: NetworkPolicy = profile.networkPolicyRef
      ? this.#policies.get(key(profile.networkPolicyRef)) ?? { id: 'legacy-unused-policy', version: '1', destinations: [] }
      : { id: 'legacy-unused-policy', version: '1', destinations: [] };
    const copy = deepFreeze(structuredClone(profile));
    const policyCopy = deepFreeze(structuredClone(policy));
    return Object.freeze({ profile: copy, policy: policyCopy, fingerprint: fingerprint(copy, policyCopy) });
  }
}

/** Refuse silent changes to settings or egress while retaining the same profile ref. */
export function assertEquivalentEffectiveProfile(expected: EffectiveProfile, actual: EffectiveProfile): void {
  if (key(expected.profile) !== key(actual.profile) ||
      expected.fingerprint !== fingerprint(expected.profile, expected.policy) ||
      actual.fingerprint !== fingerprint(actual.profile, actual.policy) ||
      expected.fingerprint !== actual.fingerprint) {
    throw new Error('Execution profile settings changed; use a new profile version');
  }
}
