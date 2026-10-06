import { readFile, open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { inspectPublicUrl, approvePublicInspection, approveHeadedPublicInspection,
  lookupAdmittedPublicTarget, lookupHeadedPublicTarget,
  AdmissionLookupRequestSchema, HeadedAdmissionLookupRequestSchema, PublicAdmissionError } from './admission.js';
import { parseTrustedLocalConfiguration, parseActivePocTrustedConfiguration,
  selectActivePocBrowserProfile } from '../local/contracts.js';
import { ProfileCatalog } from './contracts.js';
import { parseTrustedBrowserBackend } from './context.js';

const MAX_INSPECTION_BYTES = 16 * 1024;
const MAX_LOOKUP_BYTES = 8192;
const MAX_CONFIG_BYTES = 1_048_576;

async function readLookupRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_LOOKUP_BYTES) throw new PublicAdmissionError('APPROVAL_INVALID');
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return (typeof input === 'object' && input !== null && 'admissionVersion' in input &&
    input.admissionVersion === '2' ? HeadedAdmissionLookupRequestSchema : AdmissionLookupRequestSchema).parse(input);
}

async function main(args: string[]): Promise<void> {
  if (args[0] === 'select' && args.length === 2) {
    const request = AdmissionLookupRequestSchema.parse(await readLookupRequest());
    let valid = false;
    try {
      const url = new URL(request.targetUrl);
      valid = url.protocol === 'http:' || url.protocol === 'https:';
    } catch { /* An invalid URL has no browser navigation authority. */ }
    if (!valid) {
      process.stdout.write(`${JSON.stringify({ admissionVersion: '1', kind: 'denied' })}\n`);
      return;
    }
    const metadata = await stat(args[1]!);
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new PublicAdmissionError('APPROVAL_INVALID');
    const bytes = await readFile(args[1]!);
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new PublicAdmissionError('APPROVAL_INVALID');
    const config = parseActivePocTrustedConfiguration(JSON.parse(bytes.toString('utf8')) as unknown);
    const selected = selectActivePocBrowserProfile(config,
      parseTrustedBrowserBackend(process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND));
    process.stdout.write(`${JSON.stringify({ admissionVersion: '1', kind: 'approved',
      canonicalUrl: request.targetUrl, executionProfileRef: selected.reference,
      profileFingerprint: selected.fingerprint })}\n`);
    return;
  }
  if (args[0] === 'lookup' && args.length === 2) {
    const request = await readLookupRequest();
    const metadata = await stat(args[1]!);
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
      throw new PublicAdmissionError('APPROVAL_INVALID');
    }
    const bytes = await readFile(args[1]!);
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new PublicAdmissionError('APPROVAL_INVALID');
    const config = parseTrustedLocalConfiguration(JSON.parse(bytes.toString('utf8')) as unknown);
    const version = (request as { admissionVersion: '1' | '2' }).admissionVersion;
    if (!config.publicTargetApproval || !('admissionVersion' in config.publicTargetApproval) ||
        config.publicTargetApproval.admissionVersion !== version) {
      process.stdout.write(`${JSON.stringify({ admissionVersion: version, kind: 'denied' })}\n`);
      return;
    }
    const effective = new ProfileCatalog(config.profiles, config.networkPolicies)
      .resolve(config.publicTargetApproval.executionProfileRef);
    const response = config.publicTargetApproval.admissionVersion === '2'
      ? lookupHeadedPublicTarget(config.publicTargetApproval, effective, request)
      : lookupAdmittedPublicTarget(config.publicTargetApproval, effective, request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  if (args[0] === 'inspect' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await inspectPublicUrl(args[1]!))}\n`);
    return;
  }
  if ((args[0] === 'approve' || args[0] === 'approve-headed') && args.length === 4) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new PublicAdmissionError('APPROVAL_INVALID');
    }
    const [, inspectionPath, outputPath, artifactRoot] = args;
    const bytes = await readFile(inspectionPath!);
    if (bytes.byteLength > MAX_INSPECTION_BYTES) throw new PublicAdmissionError('APPROVAL_INVALID');
    const inspection = JSON.parse(bytes.toString('utf8')) as unknown;
    const checked = await inspectPublicUrl((inspection as { canonicalUrl?: string }).canonicalUrl ?? '');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let confirmation: string;
    try {
      process.stdout.write(`Review exact URL, host, port and DNS pins before approving:\n${JSON.stringify(checked, null, 2)}\n`);
      confirmation = await prompt.question('Type the complete canonical URL to approve: ');
    } finally { prompt.close(); }
    const { profile, policy, approval } = args[0] === 'approve-headed'
      ? await approveHeadedPublicInspection(inspection, confirmation)
      : await approvePublicInspection(inspection, confirmation);
    const configuration = parseTrustedLocalConfiguration({
      profiles: [profile], networkPolicies: [policy], publicTargetApproval: approval,
      evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
        failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
      ...(args[0] === 'approve-headed' ? { liveViewerPolicy: {
        liveViewerPolicyVersion: '1' as const, displayApproved: true,
      } } : {}),
      artifactRoot: artifactRoot!, retentionDays: 7,
    });
    const file = await open(outputPath!, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8'); }
    finally { await file.close(); }
    process.stdout.write(`Approved ${approval.executionProfileRef.id}@${approval.executionProfileRef.version}\n`);
    return;
  }
  throw new PublicAdmissionError('APPROVAL_INVALID');
}

try { await main(process.argv.slice(2)); }
catch (error) {
  const code = error instanceof PublicAdmissionError ? error.code : 'APPROVAL_INVALID';
  process.stderr.write(`Public admission failed: ${code}\n`);
  process.exitCode = 1;
}
