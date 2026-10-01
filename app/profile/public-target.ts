import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { ExecutionProfileRefSchema } from '../domain/schema.js';
import type { EffectiveProfile } from './contracts.js';
import type { ExternalTargetGate } from './context.js';
import { AdmittedPublicTargetApprovalSchema, HeadedPublicTargetApprovalSchema,
  validateAdmittedPublicTargetApproval, validateHeadedPublicTargetApproval } from './admission.js';

export const COLUMBIA_SAMPLE_URL = 'https://www.columbia.edu/~fdc/sample.html';
export const CHALLENGING_DOM_URL = 'https://the-internet.herokuapp.com/challenging_dom';

/** A launch-side approval for this acceptance gate, never a task or protocol field. */
const approvalBindingFields = {
  executionProfileRef: ExecutionProfileRefSchema,
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const LegacyPublicTargetApprovalSchema = z.discriminatedUnion('approvalVersion', [
  z.strictObject({ approvalVersion: z.literal('1'), targetUrl: z.literal(COLUMBIA_SAMPLE_URL),
    ...approvalBindingFields }),
  z.strictObject({ approvalVersion: z.literal('2'), targetUrl: z.literal(COLUMBIA_SAMPLE_URL),
    ...approvalBindingFields }),
  z.strictObject({ approvalVersion: z.literal('3'), targetUrl: z.literal(CHALLENGING_DOM_URL),
    ...approvalBindingFields }),
]);
export const PublicTargetApprovalSchema = z.union([
  LegacyPublicTargetApprovalSchema, AdmittedPublicTargetApprovalSchema, HeadedPublicTargetApprovalSchema,
]);
export type PublicTargetApproval = z.infer<typeof PublicTargetApprovalSchema>;

const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excluded.addSubnet(address, prefix, 'ipv4');

/** This v1 approval admits only reviewed public IPv4 pins; IPv6 needs a new review. */
function publicPin(address: string): boolean {
  return isIP(address) === 4 && !excluded.check(address, 'ipv4');
}

/** Fail configuration validation if the approval outlives its reviewed policy/profile. */
export function validatePublicTargetApproval(approval: PublicTargetApproval,
  effective: EffectiveProfile): void {
  if ('admissionVersion' in approval) {
    if (approval.admissionVersion === '2') validateHeadedPublicTargetApproval(approval, effective);
    else validateAdmittedPublicTargetApproval(approval, effective);
    return;
  }
  const profile = effective.profile;
  const destination = effective.policy.destinations;
  const bindingValid = approval.executionProfileRef.id === profile.id &&
      approval.executionProfileRef.version === profile.version &&
      approval.profileFingerprint === effective.fingerprint &&
      'browserIsolation' in profile && profile.browserIsolation === 'docker' &&
      profile.presentationMode === 'headless' && !profile.authStateRef;
  const rule = (host: string, addresses?: readonly string[]) => destination.find((item) =>
    item.host === host && item.ports.length === 1 && item.ports[0] === 443 &&
    item.addresses.length > 0 && (addresses
      ? item.addresses.length === addresses.length &&
        addresses.every((address) => item.addresses.includes(address))
      : item.addresses.every(publicPin)));
  const v1Valid = approval.approvalVersion === '1' &&
      profile.id === 'columbia-public-headless' && effective.policy.id === 'columbia-public-egress' &&
      profile.version === '1' &&
      effective.policy.version === '1' && destination.length === 1 &&
      rule('www.columbia.edu');
  // This diagnostic approval is intentionally limited to the reviewed DNS set.
  // A changed DNS response fails closed and needs a new reviewed version.
  const v2Valid = approval.approvalVersion === '2' &&
      profile.id === 'columbia-public-headless' && effective.policy.id === 'columbia-public-egress' &&
      profile.version === '2' &&
      effective.policy.version === '2' && destination.length === 2 &&
      rule('www.columbia.edu', ['162.159.128.65', '162.159.138.64']) &&
      rule('challenges.cloudflare.com', [
        '104.18.94.41', '104.18.95.41',
        '2606:4700::6812:5e29', '2606:4700::6812:5f29',
      ]);
  // The replacement acceptance target is exact-host only. Optional Optimizely
  // telemetry observed during qualification remains intentionally denied.
  const v3Valid = approval.approvalVersion === '3' &&
      profile.id === 'challenging-dom-public-headless' &&
      effective.policy.id === 'challenging-dom-public-egress' &&
      profile.version === '1' && effective.policy.version === '1' && destination.length === 1 &&
      rule('the-internet.herokuapp.com', [
        '3.209.172.72', '23.22.130.173', '54.243.238.66', '107.22.57.98',
      ]);
  if (!bindingValid || !(v1Valid || v2Valid || v3Valid)) {
    throw new Error('Public target approval does not match the reviewed isolated profile and policy');
  }
}

export function publicTargetGate(approval: PublicTargetApproval): ExternalTargetGate {
  return { authorize: async (effective) => validatePublicTargetApproval(approval, effective) };
}
