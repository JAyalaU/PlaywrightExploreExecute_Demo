import { test, expect } from '@playwright/test';
import { ProfileCatalog } from '../app/profile/contracts.js';
import { approveHeadedPublicInspection, inspectPublicUrl,
  lookupHeadedPublicTarget, validateHeadedPublicTargetApproval } from '../app/profile/admission.js';
import { ViewOnlyClientRfb, ViewOnlyServerRfb, MaskedWebSocketFrames }
  from '../app/observability/viewer-gateway.js';
import { ViewerNoticeSchema } from '../app/observability/viewer-channel.js';

const URL = 'https://the-internet.herokuapp.com/challenging_dom';
const pins = ['3.209.172.72', '23.22.130.173'];
const resolve = async (): Promise<string[]> => pins;

test('P4-3B headed approval uses independent v4/v2 identity and refuses changed authority', async () => {
  const inspected = await inspectPublicUrl(URL, resolve);
  const { profile, policy, approval } = await approveHeadedPublicInspection(inspected, URL, resolve);
  expect('profileSchemaVersion' in profile && profile.profileSchemaVersion).toBe('4');
  expect('presentationMode' in profile && profile.presentationMode).toBe('headed');
  const effective = new ProfileCatalog([profile], [policy]).resolve(approval.executionProfileRef);
  validateHeadedPublicTargetApproval(approval, effective);
  expect(lookupHeadedPublicTarget(approval, effective, {
    admissionVersion: '2', kind: 'lookup', targetUrl: URL,
  })).toEqual({ admissionVersion: '2', kind: 'approved', canonicalUrl: URL,
    executionProfileRef: approval.executionProfileRef, profileFingerprint: approval.profileFingerprint });
  expect(lookupHeadedPublicTarget(approval, effective, {
    admissionVersion: '2', kind: 'lookup', targetUrl: 'https://example.org/',
  })).toEqual({ admissionVersion: '2', kind: 'denied' });
  expect(() => validateHeadedPublicTargetApproval({ ...approval, profileFingerprint: 'a'.repeat(64) }, effective)).toThrow();
  expect(() => validateHeadedPublicTargetApproval({ ...approval, addresses: [...pins, '10.0.0.1'] }, effective)).toThrow();
});

test('P4-3B RFB parser permits only display requests and denies forged input and clipboard', () => {
  const client = new ViewOnlyClientRfb();
  expect(client.consume(Buffer.from('RFB 003.008\n'))).toHaveLength(1);
  expect(client.consume(Buffer.from([1]))).toHaveLength(1);
  expect(client.consume(Buffer.from([1]))).toHaveLength(1);
  expect(client.consume(Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21]))[0])
    .toEqual(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
  expect(client.consume(Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]))).toHaveLength(1);
  for (const type of [4, 5, 6, 150, 251]) {
    expect(() => new ViewOnlyClientRfb().consume(Buffer.concat([
      Buffer.from('RFB 003.008\n'), Buffer.from([1, 1, type]),
    ]))).toThrow('RFB input denied');
  }
  const server = new ViewOnlyServerRfb();
  const init = Buffer.alloc(24); init.writeUInt16BE(1280, 0); init.writeUInt16BE(800, 2); init[4] = 32;
  server.consume(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]),
    Buffer.alloc(4), init]));
  expect(() => server.consume(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]))).toThrow('RFB server data denied');
});

test('P4-3B WebSocket requires masked binary and notice rejects arbitrary fields', () => {
  const wire = new MaskedWebSocketFrames();
  expect(() => wire.consume(Buffer.from([0x82, 0x01, 0x00]))).toThrow('Unmasked WebSocket input');
  const event = {
    liveViewerVersion: '1', streamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sequence: 1, sourceEventSequence: 4,
    testSpecId: 'local-test', executionProfileRef: { id: 'headed', version: '1' },
    profileFingerprint: 'a'.repeat(64), owner: { kind: 'attempt', id: 'explore-test' },
    kind: 'ready', port: 12345, path: '/rfb', connectionCapability: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  } as const;
  expect(ViewerNoticeSchema.parse(event).kind).toBe('ready');
  expect(ViewerNoticeSchema.safeParse({ ...event, pageText: 'private' }).success).toBe(false);
});
