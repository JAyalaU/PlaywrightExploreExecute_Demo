import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/shared-contracts.js';

const ref = ExecutionProfileRefSchema;
const milliseconds = z.number().int().positive().max(120_000);

/** Native schema 5 is the sole product profile contract. Field order preserves its fingerprint. */
export const LocalWindowsExecutionProfileSchema = z.strictObject({
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
  timeoutPolicy: z.strictObject({ actionMs: milliseconds, navigationMs: milliseconds,
    waits: z.record(ref.shape.id, milliseconds) }),
  authStateRef: ref.optional(),
  profileSchemaVersion: z.literal('5'),
  presentationMode: z.enum(['headless', 'headed']),
  browserIsolation: z.literal('local-windows'),
  browserRuntime: z.literal('playwright-chromium-windows'),
});

export type NativeExecutionProfile = z.infer<typeof LocalWindowsExecutionProfileSchema>;
export type NativeProfileRef = z.infer<typeof ExecutionProfileRefSchema>;
export type NativeEffectiveProfile = Readonly<{ profile: NativeExecutionProfile; fingerprint: string }>;

function key(value: NativeProfileRef): string { return `${value.id}\0${value.version}`; }
function fingerprint(profile: NativeExecutionProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export class NativeProfileCatalog {
  readonly #profiles = new Map<string, NativeExecutionProfile>();
  constructor(profiles: readonly unknown[]) {
    for (const input of profiles) {
      const profile = LocalWindowsExecutionProfileSchema.parse(input);
      if (this.#profiles.has(key(profile))) throw new Error(`Duplicate execution profile ${profile.id}@${profile.version}`);
      this.#profiles.set(key(profile), structuredClone(profile));
    }
  }
  resolve(input: unknown): NativeEffectiveProfile {
    const reference = ExecutionProfileRefSchema.parse(input);
    const profile = this.#profiles.get(key(reference));
    if (!profile) throw new Error(`Unavailable execution profile ${reference.id}@${reference.version}`);
    const copy = deepFreeze(structuredClone(profile));
    return Object.freeze({ profile: copy, fingerprint: fingerprint(copy) });
  }
}

export function assertEquivalentNativeProfile(expected: NativeEffectiveProfile,
  actual: NativeEffectiveProfile): void {
  if (key(expected.profile) !== key(actual.profile) ||
      expected.fingerprint !== fingerprint(expected.profile) ||
      actual.fingerprint !== fingerprint(actual.profile) ||
      expected.fingerprint !== actual.fingerprint)
    throw new Error('Execution profile settings changed; use a new profile version');
}
