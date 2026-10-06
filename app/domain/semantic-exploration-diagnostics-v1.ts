import { z } from 'zod';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { diagnosticBrowserUrl } from './deferred-browser-diagnostics.js';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).max(128);
export const SemanticExplorationBoundaryV1Schema = z.enum([
  'attempt_created', 'browser_launch_started', 'browser_launch_completed',
  'context_create_started', 'context_create_completed', 'page_create_started', 'page_create_completed',
  'viewer_open_started', 'viewer_open_completed', 'root_navigation_started', 'root_navigation_committed',
  'mcp_session_started', 'mcp_session_completed',
  'root_navigation_returned', 'document_readiness_started', 'document_readiness_completed',
  'grounding_session_initialized', 'step_started', 'candidate_read_started', 'candidate_read_completed',
  'step_grounded', 'action_dispatch_started', 'action_dispatch_completed',
  'action_effect_started', 'action_effect_completed', 'verification_observation_started',
  'verification_observation_completed', 'trace_issued', 'cleanup_started', 'cleanup_completed',
]);
export type SemanticExplorationBoundaryV1 = z.infer<typeof SemanticExplorationBoundaryV1Schema>;
export const SemanticExplorationFailureV1Schema = z.enum([
  'BROWSER_LAUNCH_FAILED', 'CONTEXT_CREATE_FAILED', 'PAGE_CREATE_FAILED',
  'ROOT_NAVIGATION_HTTP_FAILURE', 'ROOT_NAVIGATION_FAILED', 'DOCUMENT_READINESS_FAILED',
  'GROUNDING_STATE_READ_FAILED', 'GROUNDING_CANDIDATE_FAILED', 'ACTION_DISPATCH_FAILED',
  'ACTION_EFFECT_FAILED', 'VERIFICATION_OBSERVATION_FAILED', 'VIEWER_ONLY_FAILURE',
  'BROWSER_DISCONNECTED', 'CONTEXT_CLOSED', 'PAGE_CLOSED', 'UNKNOWN_EXPLORATION_FAILURE',
]);
export type SemanticExplorationFailureV1 = z.infer<typeof SemanticExplorationFailureV1Schema>;
const step = z.strictObject({ stepId: id, kind: z.enum(['navigation', 'action', 'verification']),
  family: z.enum(['navigate', 'activate', 'choose', 'set_value', 'set_checked', 'exists',
    'visible', 'enabled', 'checked', 'selected', 'value', 'url', 'cardinality']),
  ordinalPresent: z.boolean(), relationshipPresent: z.boolean(),
  mechanic: z.enum(['click', 'check', 'uncheck', 'select_option', 'fill']).nullable(),
  observation: z.enum(['complete_count', 'boolean_property', 'value_property', 'url',
    'native_selected_option']).nullable() });
const snapshot = z.strictObject({ browserLaunchAttempted: z.boolean(),
  browser: z.enum(['connected', 'disconnected', 'unknown']),
  context: z.enum(['open', 'closed', 'unknown']), page: z.enum(['open', 'closed', 'absent', 'unknown']),
  pageCount: z.number().int().min(0).max(100).nullable(), mainFramePresent: z.boolean().nullable(),
  sanitizedUrl: z.string().max(512).nullable(), documentGenerationId: id.nullable(),
  readyState: z.enum(['loading', 'interactive', 'complete', 'unknown']).nullable(),
  domContentLoadedObserved: z.boolean().nullable(),
  mainResponseStatusClass: z.enum(['2xx', '3xx', '4xx', '5xx', 'other']).nullable(),
  navigation: z.enum(['not_started', 'started', 'committed', 'returned', 'failed']),
  viewer: z.enum(['not_requested', 'opening', 'ready', 'transient_unavailable',
    'terminal_unavailable', 'closed']) });
export const SemanticExplorationDiagnosticV1Schema = z.strictObject({
  diagnosticVersion: z.literal('semantic_exploration_diagnostic_v1'),
  workflowVersion: z.literal('semantic-general-v1'), testSpecId: id, explorationAttemptId: id,
  successfulTraceId: id.nullable(),
  viewerActivity: z.strictObject({ captureTimeouts: z.number().int().min(0).max(800),
    unavailableEvents: z.number().int().min(0).max(800), recovered: z.boolean(),
    channelLost: z.boolean() }),
  milestones: z.array(z.strictObject({ ordinal: z.number().int().min(1).max(512),
    boundary: SemanticExplorationBoundaryV1Schema, at: z.iso.datetime(), step: step.nullable() })).max(512),
  firstFailure: z.strictObject({ category: SemanticExplorationFailureV1Schema, boundary: SemanticExplorationBoundaryV1Schema,
    stepId: id.nullable(), at: z.iso.datetime(), browser: snapshot }).nullable(),
  finalBoundary: SemanticExplorationBoundaryV1Schema,
});
export type SemanticExplorationDiagnosticV1 = z.infer<typeof SemanticExplorationDiagnosticV1Schema>;
export type SemanticExplorationStepDiagnosticV1 = z.infer<typeof step>;
export type SemanticExplorationBrowserSnapshotV1 = z.infer<typeof snapshot>;

/** Closed private classification. Semantic unresolved outcomes keep their public classification. */
export function classifySemanticExplorationFailureV1(boundary: SemanticExplorationBoundaryV1,
  browser: SemanticExplorationBrowserSnapshotV1, groundingReason?: string): SemanticExplorationFailureV1 {
  // MCP opening cleans its browser session before propagating its own failure.
  if (boundary === 'mcp_session_started') return 'UNKNOWN_EXPLORATION_FAILURE';
  if (browser.browser === 'disconnected') return 'BROWSER_DISCONNECTED';
  if (browser.context === 'closed') return 'CONTEXT_CLOSED';
  if (browser.page === 'closed') return 'PAGE_CLOSED';
  if (boundary === 'browser_launch_started') return 'BROWSER_LAUNCH_FAILED';
  if (boundary === 'context_create_started') return 'CONTEXT_CREATE_FAILED';
  if (boundary === 'page_create_started') return 'PAGE_CREATE_FAILED';
  if (boundary === 'root_navigation_started' || boundary === 'root_navigation_committed' ||
      browser.navigation === 'failed') return browser.mainResponseStatusClass === '4xx' ||
        browser.mainResponseStatusClass === '5xx' ? 'ROOT_NAVIGATION_HTTP_FAILURE' : 'ROOT_NAVIGATION_FAILED';
  if (boundary === 'document_readiness_started') return 'DOCUMENT_READINESS_FAILED';
  if (groundingReason && ['UNRESOLVED_TARGET', 'AMBIGUOUS_TARGET', 'ORDINAL_OUT_OF_BOUNDS',
    'RESULT_LIMIT', 'UNSUPPORTED_CAPABILITY', 'EXPLICIT_MECHANIC_MISMATCH'].includes(groundingReason))
    return 'GROUNDING_CANDIDATE_FAILED';
  if (boundary === 'candidate_read_started') return 'GROUNDING_STATE_READ_FAILED';
  if (boundary === 'action_dispatch_started') return 'ACTION_DISPATCH_FAILED';
  if (boundary === 'action_effect_started') return 'ACTION_EFFECT_FAILED';
  if (boundary === 'verification_observation_started') return 'VERIFICATION_OBSERVATION_FAILED';
  return 'UNKNOWN_EXPLORATION_FAILURE';
}

/** Read-only, bounded post-failure state. No browser operation is needed for unavailable state. */
export async function semanticExplorationBrowserSnapshotV1(session: ProtectedBrowserSession | undefined,
  state: Pick<SemanticExplorationBrowserSnapshotV1, 'browserLaunchAttempted' | 'documentGenerationId' |
    'domContentLoadedObserved' | 'mainResponseStatusClass' | 'navigation' | 'viewer'>):
  Promise<SemanticExplorationBrowserSnapshotV1> {
  let browser: SemanticExplorationBrowserSnapshotV1['browser'] = 'unknown';
  let context: SemanticExplorationBrowserSnapshotV1['context'] = 'unknown';
  let page: SemanticExplorationBrowserSnapshotV1['page'] = 'unknown';
  let pageCount: number | null = null, mainFramePresent: boolean | null = null;
  let sanitizedUrl: string | null = null;
  let readyState: SemanticExplorationBrowserSnapshotV1['readyState'] = null;
  if (session) try {
    const pages = session.context.pages(); pageCount = Math.min(100, pages.length);
    browser = session.context.browser()?.isConnected() === true ? 'connected' :
      session.context.browser()?.isConnected() === false ? 'disconnected' : 'unknown';
    context = session.isClosed ? 'closed' : 'open';
    const owned = pages.length === 1 ? pages[0] : undefined;
    page = !owned ? 'absent' : owned.isClosed() ? 'closed' : 'open';
    if (owned && !owned.isClosed()) {
      mainFramePresent = !!owned.mainFrame(); sanitizedUrl = diagnosticBrowserUrl(owned.url()) ?? null;
      // Failure-only, bounded read. Timeout leaves readiness unknown without changing the stop.
      const read = owned.evaluate(() => document.readyState).catch(() => 'unknown');
      const value = await Promise.race([read, new Promise<'unknown'>(resolve => setTimeout(() => resolve('unknown'), 200))]);
      readyState = value === 'loading' || value === 'interactive' || value === 'complete' ? value : 'unknown';
    }
  } catch { /* Snapshot uncertainty is explicit. */ }
  return snapshot.parse({ ...state, browser, context, page, pageCount, mainFramePresent,
    sanitizedUrl, readyState });
}

/** Private observation only; never influences exploration or QA decisions. */
export class SemanticExplorationDiagnosticCollectorV1 {
  readonly #testSpecId: string; readonly #attemptId: string;
  readonly #milestones: SemanticExplorationDiagnosticV1['milestones'] = [];
  #firstFailure: SemanticExplorationDiagnosticV1['firstFailure'] = null;
  #traceId: string | null = null;
  #viewerActivity = { captureTimeouts: 0, unavailableEvents: 0, recovered: false, channelLost: false };
  constructor(testSpecId: string, attemptId: string) {
    this.#testSpecId = id.parse(testSpecId); this.#attemptId = id.parse(attemptId);
    this.record('attempt_created');
  }
  record(boundary: SemanticExplorationBoundaryV1, metadata: SemanticExplorationStepDiagnosticV1 | null = null): void {
    if (this.#milestones.length === 512) {
      this.#milestones.splice(1, 1);
      this.#milestones.forEach((item, index) => { item.ordinal = index + 1; });
    }
    this.#milestones.push({ ordinal: this.#milestones.length + 1, boundary, at: new Date().toISOString(),
      step: metadata ? step.parse(metadata) : null });
  }
  get latest(): SemanticExplorationBoundaryV1 { return this.#milestones.at(-1)!.boundary; }
  issuedTrace(traceId: string): void { this.#traceId = id.parse(traceId); this.record('trace_issued'); }
  setViewerActivity(value: { captureTimeouts: number; unavailableEvents: number;
    recovered: boolean; channelLost: boolean }): void { this.#viewerActivity = { ...value }; }
  async fail(category: SemanticExplorationFailureV1, browser: Promise<SemanticExplorationBrowserSnapshotV1>,
    stepId: string | null): Promise<void> {
    if (this.#firstFailure) return;
    const boundary = this.latest, at = new Date().toISOString();
    this.#firstFailure = { category, boundary, stepId: stepId ? id.parse(stepId) : null,
      at, browser: await browser };
  }
  snapshot(): SemanticExplorationDiagnosticV1 {
    return SemanticExplorationDiagnosticV1Schema.parse({ diagnosticVersion: 'semantic_exploration_diagnostic_v1',
      workflowVersion: 'semantic-general-v1', testSpecId: this.#testSpecId,
      explorationAttemptId: this.#attemptId, successfulTraceId: this.#traceId,
      viewerActivity: this.#viewerActivity,
      milestones: this.#milestones,
      firstFailure: this.#firstFailure, finalBoundary: this.latest });
  }
}
