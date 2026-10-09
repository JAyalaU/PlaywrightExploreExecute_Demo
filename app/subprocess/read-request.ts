import { readFile, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { parseProductTrustedConfiguration } from '../local/product-contracts.js';
import { LocalWorkflowError } from '../local/workflow-error.js';
import { MAX_REQUEST_BYTES, SubprocessProtocolError } from './shared-protocol.js';

/** Bounded stdin read with cancellation before v2 schema parsing. */
export async function readSubprocessRequest(input: Readable, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = (): void => { input.destroy(new Error('CANCELLED')); };
  if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of input) {
      if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
      length += bytes.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        input.destroy();
        throw new SubprocessProtocolError('REQUEST_TOO_LARGE');
      }
      chunks.push(bytes);
    }
    if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (signal?.aborted) throw new LocalWorkflowError('CANCELLED');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** The config path is trusted launch input, never a field in task JSON. */
export async function readSubprocessTrustedConfiguration(file: string): Promise<unknown> {
  const maxConfigBytes = 1_048_576;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > maxConfigBytes) throw new Error('Invalid configuration');
    const bytes = await readFile(file);
    if (bytes.byteLength > maxConfigBytes) throw new Error('Configuration too large');
    return parseProductTrustedConfiguration(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  } catch {
    throw new LocalWorkflowError('INVALID_TRUSTED_CONFIGURATION');
  }
}
