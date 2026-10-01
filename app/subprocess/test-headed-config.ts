/** Test-only fixture generator: deterministic approval from already reviewed public pins. */
import { readFile } from 'node:fs/promises';
import { inspectPublicUrl, approveHeadedPublicInspection } from '../profile/admission.js';
import { parseTrustedLocalConfiguration } from '../local/contracts.js';

const artifactRoot = process.argv[2];
if (!artifactRoot) process.exit(64);
const source = JSON.parse(await readFile(new URL('../../config/public-challenging-dom.json', import.meta.url), 'utf8')) as {
  publicTargetApproval: { targetUrl: string };
  networkPolicies: { destinations: { addresses: string[] }[] }[];
};
const url = source.publicTargetApproval.targetUrl;
const addresses = source.networkPolicies[0]!.destinations[0]!.addresses;
const resolve = async (): Promise<string[]> => addresses;
const inspection = await inspectPublicUrl(url, resolve);
const { profile, policy, approval } = await approveHeadedPublicInspection(inspection, url, resolve);
const config = parseTrustedLocalConfiguration({
  profiles: [profile], networkPolicies: [policy], publicTargetApproval: approval,
  liveViewerPolicy: { liveViewerPolicyVersion: '1', displayApproved: true },
  evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
    failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
  artifactRoot, retentionDays: 1,
});
process.stdout.write(JSON.stringify(config));
