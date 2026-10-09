import { readFile, open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { inspectNativePublicUrl, approveNativeLocalWindowsInspection,
  NativePublicAdmissionError, validateNativePublicTargetApproval } from './native-admission.js';
import { parseProductTrustedConfiguration,
  requireSemanticGeneralProductEnvironment, selectNativeLocalWindowsProductProfile } from '../local/product-contracts.js';
import { NativeProfileCatalog } from './native-profile.js';
import { z } from 'zod';

const MAX_INSPECTION_BYTES = 16 * 1024;
const MAX_LOOKUP_BYTES = 8192;
const MAX_CONFIG_BYTES = 1_048_576;
const AdmissionLookupRequestSchema = z.strictObject({ admissionVersion: z.literal('1'),
  kind: z.literal('lookup'), targetUrl: z.string().min(1).max(4096) });

async function readLookupRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_LOOKUP_BYTES) throw new NativePublicAdmissionError('APPROVAL_INVALID');
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return AdmissionLookupRequestSchema.parse(input);
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
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new NativePublicAdmissionError('APPROVAL_INVALID');
    const bytes = await readFile(args[1]!);
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new NativePublicAdmissionError('APPROVAL_INVALID');
    const config = parseProductTrustedConfiguration(JSON.parse(bytes.toString('utf8')) as unknown);
    requireSemanticGeneralProductEnvironment();
    const selected = selectNativeLocalWindowsProductProfile(config);
    const approval = config.publicTargetApproval;
    if (!approval || approval.targetUrl !== request.targetUrl) {
      process.stdout.write(`${JSON.stringify({ admissionVersion: '1', kind: 'denied' })}\n`);
      return;
    }
    const effective = new NativeProfileCatalog(config.profiles)
      .resolve(selected.reference);
    validateNativePublicTargetApproval(approval, effective, request.targetUrl);
    if (approval.profileFingerprint !== selected.fingerprint) throw new NativePublicAdmissionError('APPROVAL_INVALID');
    process.stdout.write(`${JSON.stringify({ admissionVersion: '1', kind: 'approved',
      canonicalUrl: request.targetUrl, executionProfileRef: selected.reference,
      profileFingerprint: selected.fingerprint })}\n`);
    return;
  }
  if (args[0] === 'inspect' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await inspectNativePublicUrl(args[1]!))}\n`);
    return;
  }
  if ((args[0] === 'approve' || args[0] === 'approve-headed') && args.length === 4) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new NativePublicAdmissionError('APPROVAL_INVALID');
    }
    const [, inspectionPath, outputPath, artifactRoot] = args;
    const bytes = await readFile(inspectionPath!);
    if (bytes.byteLength > MAX_INSPECTION_BYTES) throw new NativePublicAdmissionError('APPROVAL_INVALID');
    const inspection = JSON.parse(bytes.toString('utf8')) as unknown;
    const checked = await inspectNativePublicUrl((inspection as { canonicalUrl?: string }).canonicalUrl ?? '');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let confirmation: string;
    try {
      process.stdout.write(`Review exact URL, host, port and DNS pins before approving:\n${JSON.stringify(checked, null, 2)}\n`);
      confirmation = await prompt.question('Type the complete canonical URL to approve: ');
    } finally { prompt.close(); }
    requireSemanticGeneralProductEnvironment();
    const approved = await approveNativeLocalWindowsInspection(inspection, confirmation,
      args[0] === 'approve-headed' ? 'headed' : 'headless');
    const { profile, approval } = approved;
    const configuration = parseProductTrustedConfiguration({
      profiles: [profile],
      publicTargetApproval: approval,
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
  throw new NativePublicAdmissionError('APPROVAL_INVALID');
}

try { await main(process.argv.slice(2)); }
catch (error) {
  const code = error instanceof NativePublicAdmissionError ? error.code : 'APPROVAL_INVALID';
  process.stderr.write(`Public admission failed: ${code}\n`);
  process.exitCode = 1;
}
