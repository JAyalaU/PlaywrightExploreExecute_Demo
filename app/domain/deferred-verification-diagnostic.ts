import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
const bounded = z.string().max(512);
/** Restricted accounting only. This record is never evidence for trace, replay, or QA. */
export const DeferredVerificationDiagnosticV1Schema = z.strictObject({
  diagnosticVersion: z.literal('1'), stepId: id,
  verificationVersion: z.enum(['1', '2']), dependencyStepId: id.optional(),
  claimKind: bounded, expected: z.union([bounded, z.boolean(), z.number()]).optional(),
  subject: z.strictObject({ role: bounded.optional(), name: bounded.optional() }).optional(),
  intentKind: bounded.optional(), optionLabel: bounded.optional(), optionValue: bounded.optional(),
  controlConstraints: z.array(z.strictObject({ kind: z.enum(['role', 'name', 'label']), text: bounded })).max(24).optional(),
  strategy: z.enum(['poc_resulting_url', 'ordinary_model', 'native_owned_option']),
  observationKind: bounded.optional(), observed: z.union([bounded, z.boolean(), z.number()]).optional(),
  ownerCandidateCount: z.number().int().min(0).max(80).optional(),
  ownerRole: bounded.optional(), ownerName: bounded.optional(),
  optionCandidateCount: z.number().int().min(0).max(80).optional(),
  optionSelected: z.boolean().optional(), unresolvedConstraint: bounded.optional(),
  comparisonAttempted: z.boolean(), comparisonKind: bounded.optional(),
  comparisonExpected: z.union([bounded, z.boolean(), z.number()]).optional(),
  decisionKind: z.enum(['observe', 'conclude']).optional(),
  decisionTurn: z.number().int().min(1).max(4).optional(),
  decision: z.enum(['true', 'false', 'unresolved', 'unsupported']), reason: bounded.optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000),
});
export type DeferredVerificationDiagnosticV1 = z.infer<typeof DeferredVerificationDiagnosticV1Schema>;

export function diagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  // Never store credentials or arbitrary text. Callers only pass accepted literals/closed values.
  if (value.length > 512) return undefined;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return undefined;
      url.search = ''; url.hash = ''; return url.href; }
    catch { return undefined; }
  }
  return value;
}

/** Native option values are page supplied. Retain only short display-like values. */
export function diagnosticOptionValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !/^[\p{L}\p{N} _.-]*$/u.test(value) ||
      /[A-Za-z0-9]{24,}/.test(value)) return undefined;
  return value;
}
