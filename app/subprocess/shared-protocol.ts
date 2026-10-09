import { z } from 'zod';

export const MAX_REQUEST_BYTES = 65_536;
export const MAX_RESPONSE_BYTES = 65_536;
export const MAX_STDERR_BYTES = 16_384;
export const DEFAULT_HOST_DEADLINE_MS = 300_000;
export const MAX_HOST_DEADLINE_MS = 1_200_000;

export const SUBPROCESS_EXIT = {
  success: 0, qaFailure: 1, automationStop: 2, bridgeError: 64, cancelled: 130,
} as const;

export const BridgeErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'INVALID_TRUSTED_CONFIGURATION', 'PROFILE_UNAVAILABLE',
  'DESTINATION_DENIED', 'PROVIDER_CONFIGURATION_ERROR', 'CANCELLED',
  'WORKFLOW_FAILED', 'REPORT_INVALID', 'PROTOCOL_INVALID',
  'PROTOCOL_UNSUPPORTED_VERSION', 'REQUEST_TOO_LARGE',
]);

export class SubprocessProtocolError extends Error {
  constructor(readonly code: 'PROTOCOL_INVALID' | 'PROTOCOL_UNSUPPORTED_VERSION' |
    'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE') {
    super(code);
    this.name = 'SubprocessProtocolError';
  }
}
