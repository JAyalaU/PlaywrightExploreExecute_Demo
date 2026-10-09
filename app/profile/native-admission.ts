import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/shared-contracts.js';
import type { NativeEffectiveProfile } from './native-profile.js';
import { LocalWindowsExecutionProfileSchema, NativeProfileCatalog } from './native-profile.js';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.string().refine(value => isIP(value) !== 0);
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
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) excluded6.addSubnet(subnet, prefix, 'ipv6');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
function publicAddress(value: string): boolean {
  if (isIP(value) === 4) return !excluded4.check(value, 'ipv4');
  if (isIP(value) === 6) return global6.check(value, 'ipv6') && !excluded6.check(value, 'ipv6');
  return false;
}
export class NativePublicAdmissionError extends Error {
  constructor(readonly code: 'URL_DENIED' | 'DNS_UNAVAILABLE' | 'ADDRESS_DENIED' |
    'INSPECTION_CHANGED' | 'APPROVAL_INVALID') { super(code); }
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function canonicalPublicUrl(input: string): { url: string; host: string; port: 80 | 443 } {
  if (Buffer.byteLength(input, 'utf8') > MAX_URL_BYTES || input.trim() !== input)
    throw new NativePublicAdmissionError('URL_DENIED');
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new NativePublicAdmissionError('URL_DENIED'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.hash || isIP(parsed.hostname) || parsed.hostname.endsWith('.') ||
      parsed.hostname.length > 253 || parsed.hostname.includes('_'))
    throw new NativePublicAdmissionError('URL_DENIED');
  const host = parsed.hostname.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].includes(labels.at(-1)!))
    throw new NativePublicAdmissionError('URL_DENIED');
  const port = parsed.protocol === 'https:' ? 443 : 80;
  if (parsed.port && Number(parsed.port) !== port) throw new NativePublicAdmissionError('URL_DENIED');
  return { url: parsed.href, host, port };
}
function sortedAddresses(addresses: readonly string[]): string[] {
  if (!addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item)))
    throw new NativePublicAdmissionError('ADDRESS_DENIED');
  return [...new Set(addresses.map(item => item.toLowerCase()))].sort();
}
export const NativePublicUrlInspectionSchema = z.strictObject({
  admissionVersion: z.literal('1'), kind: z.literal('inspection'),
  canonicalUrl: z.string().min(1).max(MAX_URL_BYTES), host: z.string().min(1),
  port: z.union([z.literal(80), z.literal(443)]), addresses: z.array(address).min(1).max(32),
  inspectedAt: z.iso.datetime(), inspectionDigest: fingerprint,
});
export type NativeAdmissionResolver = (host: string) => Promise<readonly string[]>;
const systemResolve: NativeAdmissionResolver = async host =>
  (await lookup(host, { all: true, verbatim: true })).map(item => item.address);
export async function inspectNativePublicUrl(input: string,
  resolve: NativeAdmissionResolver = systemResolve) {
  const candidate = canonicalPublicUrl(input);
  let answers: readonly string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answers = await Promise.race([resolve(candidate.host), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new NativePublicAdmissionError('DNS_UNAVAILABLE')), DNS_TIMEOUT_MS);
    })]);
  } catch { throw new NativePublicAdmissionError('DNS_UNAVAILABLE'); }
  finally { if (timer) clearTimeout(timer); }
  const addresses = sortedAddresses(answers);
  return NativePublicUrlInspectionSchema.parse({ admissionVersion: '1', kind: 'inspection',
    canonicalUrl: candidate.url, host: candidate.host, port: candidate.port, addresses,
    inspectedAt: new Date().toISOString(),
    inspectionDigest: digest({ url: candidate.url, host: candidate.host, port: candidate.port, addresses }) });
}
const approval = z.strictObject({
  admissionVersion: z.literal('1'), targetUrl: z.string().min(1).max(MAX_URL_BYTES),
  executionProfileRef: ExecutionProfileRefSchema, profileFingerprint: fingerprint,
  host: z.string().min(1), port: z.union([z.literal(80), z.literal(443)]),
  addresses: z.array(address).min(1).max(32), inspectionDigest: fingerprint,
  approvedAt: z.iso.datetime(),
});
export const NativePublicTargetApprovalSchema = z.union([approval, approval.extend({
  admissionVersion: z.literal('2'), presentationMode: z.literal('headed'),
})]);
export type NativePublicTargetApproval = z.infer<typeof NativePublicTargetApprovalSchema>;

export async function approveNativeLocalWindowsInspection(input: unknown, confirmedUrl: string,
  presentationMode: 'headless' | 'headed' = 'headless',
  resolve: NativeAdmissionResolver = systemResolve) {
  const inspected = NativePublicUrlInspectionSchema.parse(input);
  const candidate = canonicalPublicUrl(confirmedUrl);
  const pins = sortedAddresses(inspected.addresses);
  if (candidate.url !== inspected.canonicalUrl || candidate.host !== inspected.host ||
      candidate.port !== inspected.port || inspected.inspectionDigest !== digest({
        url: candidate.url, host: candidate.host, port: candidate.port, addresses: pins,
      })) throw new NativePublicAdmissionError('INSPECTION_CHANGED');
  const fresh = await inspectNativePublicUrl(candidate.url, resolve);
  if (fresh.inspectionDigest !== inspected.inspectionDigest)
    throw new NativePublicAdmissionError('INSPECTION_CHANGED');
  const identity = digest({ targetUrl: candidate.url, addresses: fresh.addresses,
    presentationMode, browserIsolation: 'local-windows', profileSchemaVersion: '5' });
  const profile = LocalWindowsExecutionProfileSchema.parse({
    id: `admitted-local-windows-${identity}`, version: '1', profileSchemaVersion: '5',
    presentationMode, browserIsolation: 'local-windows',
    browserRuntime: 'playwright-chromium-windows', browser: 'chromium',
    viewport: { width: 1280, height: 800 }, locale: 'en-US',
    timeoutPolicy: { actionMs: 10_000, navigationMs: 90_000, waits: { default: 10_000 } },
  });
  const executionProfileRef = { id: profile.id, version: profile.version };
  const effective = new NativeProfileCatalog([profile]).resolve(executionProfileRef);
  const approval = NativePublicTargetApprovalSchema.parse({
    admissionVersion: presentationMode === 'headed' ? '2' : '1',
    ...(presentationMode === 'headed' ? { presentationMode: 'headed' } : {}),
    targetUrl: candidate.url, executionProfileRef, profileFingerprint: effective.fingerprint,
    host: candidate.host, port: candidate.port, addresses: fresh.addresses,
    inspectionDigest: fresh.inspectionDigest, approvedAt: new Date().toISOString(),
  });
  return { profile, approval };
}

/** Exact reviewed target binding. DNS addresses remain approval metadata, not runtime egress controls. */
export function validateNativePublicTargetApproval(input: unknown,
  effective: NativeEffectiveProfile, requestedTarget?: string): NativePublicTargetApproval {
  const value = NativePublicTargetApprovalSchema.parse(input);
  let candidate: ReturnType<typeof canonicalPublicUrl>, normalized: string[];
  try { candidate = canonicalPublicUrl(value.targetUrl); normalized = sortedAddresses(value.addresses); }
  catch { throw new Error('Invalid native public target approval URL or addresses'); }
  const expectedDigest = createHash('sha256').update(JSON.stringify({
    url: candidate.url, host: candidate.host, port: candidate.port, addresses: normalized,
  })).digest('hex');
  if (value.targetUrl !== candidate.url ||
      (requestedTarget !== undefined && requestedTarget !== value.targetUrl) ||
      value.host !== candidate.host || value.port !== candidate.port ||
      value.addresses.length !== normalized.length || value.inspectionDigest !== expectedDigest ||
      value.executionProfileRef.id !== effective.profile.id ||
      value.executionProfileRef.version !== effective.profile.version ||
      value.profileFingerprint !== effective.fingerprint ||
      effective.profile.presentationMode !== (value.admissionVersion === '2' ? 'headed' : 'headless') ||
      !!effective.profile.authStateRef)
    throw new Error('Native public target approval does not match trusted profile and target');
  return value;
}
