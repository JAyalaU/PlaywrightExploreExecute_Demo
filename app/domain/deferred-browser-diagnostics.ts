import { z } from 'zod';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { DeferredRunnerStopV9Schema } from './deferred-action-runner.js';

const id = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const ms = z.number().finite().min(0).max(1_000_000_000_000);
const count = z.number().int().min(0).max(1_000_000);
const state = z.enum(['open', 'closed', 'absent', 'unknown']);
const reason = z.enum(['NONE', 'NOT_READY', 'PAGE_COUNT', 'PAGE_CLOSED', 'CONTEXT_CLOSED', 'BROWSER_DISCONNECTED',
  'CAPTURE_TIMEOUT', 'CAPTURE_FAILED', 'FRAME_INVALID', 'CHANNEL_LOST', 'DISPLAY_LOST', 'RESULT_LIMIT',
  'CDP_DETACH_FAILED', 'CDP_DETACH_TIMEOUT', 'LATE_CAPTURE_DISCARDED',
  'STALE_STATE', 'UNPROVEN_FRAME', 'BROWSER_FAILURE', 'QUERY_UNEVALUABLE', 'OBSERVATION_TIMEOUT',
  'FRAME_DETACHED', 'NAVIGATION_IN_PROGRESS', 'OTHER']);
const exception = z.enum(['Error', 'TimeoutError', 'LiveImageCaptureTimeout', 'TargetClosedError',
  'ActionCandidateGroundingError', 'OtherError']);
const role = z.enum(['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch',
  'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox']);
export const ProtectedAriaFailureCategorySchema = z.enum(['TARGET_CLOSED', 'PAGE_CLOSED', 'CONTEXT_CLOSED',
  'BROWSER_DISCONNECTED', 'FRAME_DETACHED', 'EXECUTION_CONTEXT_DESTROYED', 'NAVIGATION_INTERRUPTED',
  'PLAYWRIGHT_TIMEOUT', 'PROTOCOL_ERROR', 'ARIA_SNAPSHOT_API_FAILURE', 'UNKNOWN_PLAYWRIGHT_ERROR']);
export type ProtectedAriaFailureCategory = z.infer<typeof ProtectedAriaFailureCategorySchema>;
export const DeferredBrowserDiagnosticV1Schema = z.strictObject({
  diagnosticVersion: z.literal('1'), source: z.enum(['viewer', 'grounding', 'runner']),
  operation: z.enum(['loop_start', 'capture', 'ready', 'first_frame', 'unavailable', 'closed', 'transition',
    'channel_loss', 'capture_timeout', 'capture_detach', 'capture_late_settle', 'capture_late_discard',
    'initial_state', 'candidate_enumeration', 'enumeration_predicate', 'role_pre_name',
    'role_post_name', 'native_select_inventory', 'candidate_filtering', 'fresh_state',
    'freshness_comparison', 'final_result', 'pre_action_ownership', 'rich_after_url',
    'frame_enumeration', 'frame_content', 'runner_v9_state', 'execution_entry_ownership',
    'document_readiness', 'main_document_response', 'main_document_navigation']),
  readinessBoundary: z.enum(['bootstrap_start', 'bootstrap_complete', 'before_click', 'after_click',
    'url_observation', 'before_candidate_query']).optional(),
  documentGenerationId: id.optional(), documentReadyState: z.enum(['loading', 'interactive', 'complete', 'unknown']).optional(),
  domContentLoadedObserved: z.boolean().optional(), loadObserved: z.boolean().optional(),
  mainResponseObserved: z.boolean().optional(), mainResponseStatusClass: z.enum(['2xx', '3xx', '4xx', '5xx', 'other', 'unknown']).optional(),
  redirectCount: z.number().int().min(0).max(32).optional(), navigationCommitted: z.boolean().optional(),
  navigationFailed: z.boolean().optional(), navigationFailureCategory: z.enum(['ABORTED', 'NETWORK', 'TIMEOUT', 'OTHER', 'UNKNOWN']).optional(),
  documentReplacedSinceUrlObservation: z.boolean().optional(), documentChangedDuringRead: z.boolean().optional(),
  phase: z.enum(['exploration', 'compilation', 'replay_1', 'replay_2']).optional(),
  ownerId: id.optional(), stepId: id.optional(),
  authoredOperation: z.enum(['click', 'fill', 'select_option']).optional(),
  semanticTargetRole: z.union([role, z.enum(['dropdown', 'select', 'select_box', 'other', 'absent'])]).optional(),
  attemptedRoles: z.array(role).max(13).optional(), concreteRole: role.optional(),
  exactNameConstraintPresent: z.boolean().optional(), labelConstraintPresent: z.boolean().optional(),
  contextConstraintPresent: z.boolean().optional(), choiceConstraintPresent: z.boolean().optional(),
  sourceConstraintDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  frameId: id.optional(), pageId: id.optional(), preNameCount: count.optional(), postNameCount: count.optional(),
  nativeSelectCount: count.optional(), visibleNativeSelectCount: count.optional(),
  enabledNativeSelectCount: count.optional(),
  startedAtMs: ms, endedAtMs: ms, elapsedMs: ms,
  outcome: z.enum(['started', 'success', 'failure', 'skipped']),
  attemptOrdinal: count.optional(), successfulFrameCount: count.optional(),
  lastSuccessfulFrameAt: z.iso.datetime().optional(), candidateCount: z.number().int().min(0).max(80).optional(),
  page: state, context: state, browser: z.enum(['connected', 'disconnected', 'absent', 'unknown']),
  currentUrl: z.string().max(512).optional(),
  browserOperation: z.enum(['frame_content', 'aria_snapshot', 'locator_count', 'element_handle',
    'owner_frame', 'candidate_snapshot', 'ref_count', 'visibility', 'enabled', 'editable',
    'native_select_count']).optional(),
  exceptionName: exception.optional(), internalReason: reason.optional(),
  ariaFailureCategory: ProtectedAriaFailureCategorySchema.optional(),
  playwrightTimeout: z.boolean().optional(),
  frameState: z.enum(['attached', 'detached', 'unknown']).optional(),
  pageCount: count.optional(), ownedPagePresent: z.boolean().optional(),
  frameCount: count.optional(), mainFrameId: id.optional(),
  runnerExceptionCategory: z.enum(['PLAYWRIGHT_TIMEOUT', 'PAGE_CLOSED', 'CONTEXT_CLOSED',
    'BROWSER_DISCONNECTED', 'FRAME_DETACHED', 'EXECUTION_CONTEXT_DESTROYED',
    'NAVIGATION_INTERRUPTED', 'PROTOCOL_ERROR', 'STATE_READ_API_FAILURE',
    'UNKNOWN_PLAYWRIGHT_ERROR']).optional(),
  runnerStopCode: DeferredRunnerStopV9Schema.optional(),
});
export type DeferredBrowserDiagnosticV1 = z.infer<typeof DeferredBrowserDiagnosticV1Schema>;
export type DeferredBrowserDiagnosticSink = (event: DeferredBrowserDiagnosticV1) => void;

/** No query, fragment, credentials, data content, or unrestricted page text. */
export function diagnosticBrowserUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return parsed.protocol;
    parsed.search = ''; parsed.hash = '';
    return parsed.href.length <= 512 ? parsed.href : undefined;
  } catch { return undefined; }
}

export function diagnosticBrowserState(session: ProtectedBrowserSession) {
  try {
    const context = session.context, browser = context.browser();
    const pages = context.pages();
    const page = pages.length === 1 ? pages[0] : undefined;
    return { page: !page ? 'absent' as const : page.isClosed() ? 'closed' as const : 'open' as const,
      context: session.isClosed ? 'closed' as const : pages.length && browser?.isConnected() ? 'open' as const : 'unknown' as const,
      browser: !browser ? 'absent' as const : browser.isConnected() ? 'connected' as const : 'disconnected' as const,
      ...(page ? { currentUrl: diagnosticBrowserUrl(page.url()) } : {}) };
  } catch { return { page: 'unknown' as const, context: 'unknown' as const, browser: 'unknown' as const }; }
}

export function diagnosticExceptionName(error: unknown): DeferredBrowserDiagnosticV1['exceptionName'] {
  const name = error instanceof Error ?
    (error.name === 'Error' && exception.safeParse(error.constructor?.name).success ? error.constructor.name : error.name) : '';
  return exception.safeParse(name).success ? name as DeferredBrowserDiagnosticV1['exceptionName'] : 'OtherError';
}

export function diagnosticElapsed(start: number, end = performance.now()): number {
  return Math.max(0, Math.min(86_400_000, Math.round(end - start)));
}

/** Bounded in-memory private collector. The first event remains; the tail tracks the failure boundary. */
export class DeferredBrowserDiagnosticCollector {
  readonly #events: DeferredBrowserDiagnosticV1[] = [];
  readonly record: DeferredBrowserDiagnosticSink = event => {
    const parsed = DeferredBrowserDiagnosticV1Schema.safeParse(event);
    if (!parsed.success) return;
    if (this.#events.length === 800) this.#events.splice(1, 1);
    this.#events.push(parsed.data);
  };
  snapshot(): DeferredBrowserDiagnosticV1[] { return structuredClone(this.#events); }
}
