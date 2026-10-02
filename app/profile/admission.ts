import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/schema.js';
import { ProfileCatalog, type EffectiveProfile, type ExecutionProfile, type NetworkPolicy } from './contracts.js';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.string().refine((value) => isIP(value) !== 0);
const MAX_URL_BYTES = 4096;
const DNS_TIMEOUT_MS = 10_000;
const excluded4 = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) excluded4.addSubnet(subnet, prefix, 'ipv4');
const excluded6 = new BlockList();
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) excluded6.addSubnet(subnet, prefix, 'ipv6');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');

export class PublicAdmissionError extends Error {
  constructor(readonly code: 'URL_DENIED' | 'DNS_UNAVAILABLE' | 'ADDRESS_DENIED' |
      'INSPECTION_CHANGED' | 'APPROVAL_INVALID') {
    super(code);
    this.name = 'PublicAdmissionError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The local form supplies a candidate, never a network rule. */
export function canonicalPublicUrl(input: string): { url: string; host: string; port: 80 | 443 } {
  if (Buffer.byteLength(input, 'utf8') > MAX_URL_BYTES || input.trim() !== input) {
    throw new PublicAdmissionError('URL_DENIED');
  }
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new PublicAdmissionError('URL_DENIED'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.hash || isIP(parsed.hostname) || parsed.hostname.endsWith('.') ||
      parsed.hostname.length > 253 || parsed.hostname.includes('_')) {
    throw new PublicAdmissionError('URL_DENIED');
  }
  const host = parsed.hostname.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].includes(labels.at(-1)!)) {
    throw new PublicAdmissionError('URL_DENIED');
  }
  const port = parsed.protocol === 'https:' ? 443 : 80;
  if (parsed.port && Number(parsed.port) !== port) throw new PublicAdmissionError('URL_DENIED');
  return { url: parsed.href, host, port };
}

export function isPublicAddress(value: string): boolean {
  if (isIP(value) === 4) return !excluded4.check(value, 'ipv4');
  if (isIP(value) === 6) return global6.check(value, 'ipv6') && !excluded6.check(value, 'ipv6');
  return false;
}

function sortedAddresses(addresses: readonly string[]): string[] {
  if (!addresses.length || addresses.length > 32 || addresses.some((item) => !isPublicAddress(item))) {
    throw new PublicAdmissionError('ADDRESS_DENIED');
  }
  return [...new Set(addresses.map((item) => item.toLowerCase()))].sort();
}

export const PublicUrlInspectionSchema = z.strictObject({
  admissionVersion: z.literal('1'),
  kind: z.literal('inspection'),
  canonicalUrl: z.string().min(1).max(MAX_URL_BYTES),
  host: z.string().min(1),
  port: z.union([z.literal(80), z.literal(443)]),
  addresses: z.array(address).min(1).max(32),
  inspectedAt: z.iso.datetime(),
  inspectionDigest: fingerprint,
});
export type PublicUrlInspection = z.infer<typeof PublicUrlInspectionSchema>;

export const AdmittedPublicTargetApprovalSchema = z.strictObject({
  admissionVersion: z.literal('1'),
  targetUrl: z.string().min(1).max(MAX_URL_BYTES),
  executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: fingerprint,
  host: z.string().min(1),
  port: z.union([z.literal(80), z.literal(443)]),
  addresses: z.array(address).min(1).max(32),
  inspectionDigest: fingerprint,
  approvedAt: z.iso.datetime(),
});
export type AdmittedPublicTargetApproval = z.infer<typeof AdmittedPublicTargetApprovalSchema>;
export const HeadedPublicTargetApprovalSchema = AdmittedPublicTargetApprovalSchema.extend({
  admissionVersion: z.literal('2'),
  presentationMode: z.literal('headed'),
});
export type HeadedPublicTargetApproval = z.infer<typeof HeadedPublicTargetApprovalSchema>;
export const AdmissionLookupRequestSchema = z.strictObject({
  admissionVersion: z.literal('1'),
  kind: z.literal('lookup'),
  targetUrl: z.string().min(1).max(MAX_URL_BYTES),
});
export const HeadedAdmissionLookupRequestSchema = AdmissionLookupRequestSchema.extend({
  admissionVersion: z.literal('2'),
});
export const AdmissionLookupResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    admissionVersion: z.literal('1'),
    kind: z.literal('approved'),
    canonicalUrl: z.string().min(1).max(MAX_URL_BYTES),
    executionProfileRef: ExecutionProfileRefSchema,
    profileFingerprint: fingerprint,
  }),
  z.strictObject({ admissionVersion: z.literal('1'), kind: z.literal('denied') }),
]);
export const HeadedAdmissionLookupResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    admissionVersion: z.literal('2'), kind: z.literal('approved'),
    canonicalUrl: z.string().min(1).max(MAX_URL_BYTES),
    executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: fingerprint,
  }),
  z.strictObject({ admissionVersion: z.literal('2'), kind: z.literal('denied') }),
]);
export type AdmissionResolver = (host: string) => Promise<readonly string[]>;
const systemResolve: AdmissionResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);

/** DNS inspection is read-only. An operator must separately approve its result. */
export async function inspectPublicUrl(input: string, resolve: AdmissionResolver = systemResolve):
    Promise<PublicUrlInspection> {
  const candidate = canonicalPublicUrl(input);
  let answers: readonly string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answers = await Promise.race([
      resolve(candidate.host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PublicAdmissionError('DNS_UNAVAILABLE')), DNS_TIMEOUT_MS);
      }),
    ]);
  } catch { throw new PublicAdmissionError('DNS_UNAVAILABLE'); }
  finally { if (timer) clearTimeout(timer); }
  const addresses = sortedAddresses(answers);
  return PublicUrlInspectionSchema.parse({
    admissionVersion: '1', kind: 'inspection', canonicalUrl: candidate.url,
    host: candidate.host, port: candidate.port, addresses,
    inspectedAt: new Date().toISOString(),
    inspectionDigest: digest({ url: candidate.url, host: candidate.host, port: candidate.port, addresses }),
  });
}

/** Approval requires a fresh, identical DNS observation and explicit trusted operator action. */
export async function approvePublicInspection(input: unknown, confirmedUrl: string,
  resolve: AdmissionResolver = systemResolve): Promise<{
    profile: ExecutionProfile; policy: NetworkPolicy; approval: AdmittedPublicTargetApproval;
  }> {
  const inspected = PublicUrlInspectionSchema.parse(input);
  const candidate = canonicalPublicUrl(confirmedUrl);
  const expectedDigest = digest({ url: inspected.canonicalUrl, host: inspected.host,
    port: inspected.port, addresses: sortedAddresses(inspected.addresses) });
  if (candidate.url !== inspected.canonicalUrl || candidate.host !== inspected.host ||
      candidate.port !== inspected.port || inspected.inspectionDigest !== expectedDigest) {
    throw new PublicAdmissionError('INSPECTION_CHANGED');
  }
  const fresh = await inspectPublicUrl(candidate.url, resolve);
  if (fresh.inspectionDigest !== inspected.inspectionDigest) {
    throw new PublicAdmissionError('INSPECTION_CHANGED');
  }
  const { profile, policy } = admissionProfileAndPolicy(candidate, fresh.addresses);
  const ref = { id: profile.id, version: profile.version };
  const effective = new ProfileCatalog([profile], [policy]).resolve(ref);
  const approval: AdmittedPublicTargetApproval = {
    admissionVersion: '1', targetUrl: candidate.url, executionProfileRef: ref,
    profileFingerprint: effective.fingerprint, host: candidate.host, port: candidate.port,
    addresses: fresh.addresses, inspectionDigest: fresh.inspectionDigest,
    approvedAt: new Date().toISOString(),
  };
  return { profile, policy, approval };
}

/** Separately reviewed headed approval; v1 inspection and DNS pins are reused. */
export async function approveHeadedPublicInspection(input: unknown, confirmedUrl: string,
  resolve: AdmissionResolver = systemResolve): Promise<{
    profile: ExecutionProfile; policy: NetworkPolicy; approval: HeadedPublicTargetApproval;
  }> {
  const inspected = PublicUrlInspectionSchema.parse(input);
  const candidate = canonicalPublicUrl(confirmedUrl);
  const pins = sortedAddresses(inspected.addresses);
  if (candidate.url !== inspected.canonicalUrl || candidate.host !== inspected.host ||
      candidate.port !== inspected.port || inspected.inspectionDigest !== digest({
        url: candidate.url, host: candidate.host, port: candidate.port, addresses: pins,
      })) throw new PublicAdmissionError('INSPECTION_CHANGED');
  const fresh = await inspectPublicUrl(candidate.url, resolve);
  if (fresh.inspectionDigest !== inspected.inspectionDigest) throw new PublicAdmissionError('INSPECTION_CHANGED');
  const { profile, policy } = headedAdmissionProfileAndPolicy(candidate, fresh.addresses);
  const executionProfileRef = { id: profile.id, version: profile.version };
  const effective = new ProfileCatalog([profile], [policy]).resolve(executionProfileRef);
  return { profile, policy, approval: HeadedPublicTargetApprovalSchema.parse({
    admissionVersion: '2', presentationMode: 'headed', targetUrl: candidate.url,
    executionProfileRef, profileFingerprint: effective.fingerprint,
    host: candidate.host, port: candidate.port, addresses: fresh.addresses,
    inspectionDigest: fresh.inspectionDigest, approvedAt: new Date().toISOString(),
  }) };
}

function admissionProfileAndPolicy(candidate: ReturnType<typeof canonicalPublicUrl>,
  addresses: readonly string[]): { profile: ExecutionProfile; policy: NetworkPolicy } {
  const identity = digest({ targetUrl: candidate.url, addresses });
  const ref = { id: `admitted-public-${identity}`, version: '1' };
  const policy: NetworkPolicy = {
    id: `admitted-egress-${identity}`, version: '1',
    destinations: [{ host: candidate.host, ports: [candidate.port], addresses: [...addresses] }],
  };
  const profile: ExecutionProfile = {
    id: ref.id, version: ref.version, profileSchemaVersion: '3', presentationMode: 'headless',
    browserIsolation: 'docker', browser: 'chromium', viewport: { width: 1280, height: 800 },
    locale: 'en-US', timeoutPolicy: { actionMs: 10_000, navigationMs: 90_000,
      waits: { default: 10_000 } },
    networkPolicyRef: { id: policy.id, version: policy.version },
  };
  return { profile, policy };
}

function headedAdmissionProfileAndPolicy(candidate: ReturnType<typeof canonicalPublicUrl>,
  addresses: readonly string[]): { profile: ExecutionProfile; policy: NetworkPolicy } {
  const base = admissionProfileAndPolicy(candidate, addresses);
  const identity = digest({ targetUrl: candidate.url, addresses, presentationMode: 'headed' });
  const policy = { ...base.policy, id: `admitted-headed-egress-${identity}` };
  const profile: ExecutionProfile = {
    ...base.profile, id: `admitted-public-headed-${identity}`,
    profileSchemaVersion: '4', presentationMode: 'headed',
    networkPolicyRef: { id: policy.id, version: policy.version },
  };
  return { profile, policy };
}

function matchesGeneratedAdmissionProfile(actual: ExecutionProfile, expected: ExecutionProfile): boolean {
  // Read approvals created before the active PoC raised its navigation timeout.
  // This comparison is used only by the historical lookup exchange.
  return isDeepStrictEqual(actual, expected) || isDeepStrictEqual(actual, {
    ...expected, timeoutPolicy: { ...expected.timeoutPolicy, navigationMs: 30_000 },
  });
}

export function validateAdmittedPublicTargetApproval(approval: AdmittedPublicTargetApproval,
  effective: EffectiveProfile): void {
  try {
    const candidate = canonicalPublicUrl(approval.targetUrl);
    const pins = sortedAddresses(approval.addresses);
    const expected = admissionProfileAndPolicy(candidate, pins);
    if (approval.targetUrl !== candidate.url || approval.host !== candidate.host ||
        approval.port !== candidate.port ||
        approval.inspectionDigest !== digest({ url: candidate.url, host: candidate.host,
          port: candidate.port, addresses: pins }) ||
        approval.executionProfileRef.id !== expected.profile.id ||
        approval.executionProfileRef.version !== expected.profile.version ||
        !matchesGeneratedAdmissionProfile(effective.profile, expected.profile) ||
        !isDeepStrictEqual(effective.policy, expected.policy) ||
        ![effective.fingerprint, digest({ profile: effective.profile, policy: effective.policy })]
          .includes(approval.profileFingerprint)) {
      throw new Error('Invalid binding');
    }
  } catch { throw new PublicAdmissionError('APPROVAL_INVALID'); }
}

export function validateHeadedPublicTargetApproval(approval: HeadedPublicTargetApproval,
  effective: EffectiveProfile): void {
  try {
    const candidate = canonicalPublicUrl(approval.targetUrl);
    const pins = sortedAddresses(approval.addresses);
    const expected = headedAdmissionProfileAndPolicy(candidate, pins);
    if (approval.presentationMode !== 'headed' || approval.targetUrl !== candidate.url ||
        approval.host !== candidate.host || approval.port !== candidate.port ||
        approval.inspectionDigest !== digest({ url: candidate.url, host: candidate.host,
          port: candidate.port, addresses: pins }) ||
        !isDeepStrictEqual(approval.executionProfileRef,
          { id: expected.profile.id, version: expected.profile.version }) ||
        !matchesGeneratedAdmissionProfile(effective.profile, expected.profile) ||
        !isDeepStrictEqual(effective.policy, expected.policy) ||
        ![effective.fingerprint, digest({ profile: effective.profile, policy: effective.policy })]
          .includes(approval.profileFingerprint)) throw new Error('Invalid binding');
  } catch { throw new PublicAdmissionError('APPROVAL_INVALID'); }
}

/** Read-only selection from trusted launch configuration; task input grants no policy authority. */
export function lookupAdmittedPublicTarget(approval: AdmittedPublicTargetApproval,
  effective: EffectiveProfile, requestInput: unknown): z.infer<typeof AdmissionLookupResponseSchema> {
  const request = AdmissionLookupRequestSchema.parse(requestInput);
  validateAdmittedPublicTargetApproval(approval, effective);
  let canonical: ReturnType<typeof canonicalPublicUrl>;
  try { canonical = canonicalPublicUrl(request.targetUrl); }
  catch { return { admissionVersion: '1', kind: 'denied' }; }
  if (canonical.url !== approval.targetUrl) return { admissionVersion: '1', kind: 'denied' };
  return AdmissionLookupResponseSchema.parse({
    admissionVersion: '1', kind: 'approved', canonicalUrl: approval.targetUrl,
    executionProfileRef: approval.executionProfileRef,
    profileFingerprint: approval.profileFingerprint,
  });
}

export function lookupHeadedPublicTarget(approval: HeadedPublicTargetApproval,
  effective: EffectiveProfile, requestInput: unknown): z.infer<typeof HeadedAdmissionLookupResponseSchema> {
  const request = HeadedAdmissionLookupRequestSchema.parse(requestInput);
  validateHeadedPublicTargetApproval(approval, effective);
  let canonical: ReturnType<typeof canonicalPublicUrl>;
  try { canonical = canonicalPublicUrl(request.targetUrl); }
  catch { return { admissionVersion: '2', kind: 'denied' }; }
  if (canonical.url !== approval.targetUrl) return { admissionVersion: '2', kind: 'denied' };
  return HeadedAdmissionLookupResponseSchema.parse({
    admissionVersion: '2', kind: 'approved', canonicalUrl: approval.targetUrl,
    executionProfileRef: approval.executionProfileRef,
    profileFingerprint: approval.profileFingerprint,
  });
}
