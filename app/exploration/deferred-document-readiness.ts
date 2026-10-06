import { randomUUID } from 'node:crypto';
import type { Frame, Page, Request, Response } from '@playwright/test';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { diagnosticBrowserState, diagnosticBrowserUrl, diagnosticElapsed,
  type DeferredBrowserDiagnosticSink, type DeferredBrowserDiagnosticV1 } from '../domain/deferred-browser-diagnostics.js';

type Boundary = NonNullable<DeferredBrowserDiagnosticV1['readinessBoundary']>;
type StatusClass = NonNullable<DeferredBrowserDiagnosticV1['mainResponseStatusClass']>;
type Navigation = { responseObserved: boolean; statusClass: StatusClass; redirectCount: number;
  committed: boolean; failed: boolean; failureCategory?: DeferredBrowserDiagnosticV1['navigationFailureCategory'];
  url?: string | undefined; generationId?: string };
type Document = { generationId: string; domContentLoaded?: boolean; load?: boolean; navigation: Navigation };
type WatchedPage = { page: Page; document: Document; pending?: Navigation | undefined;
  navigationByRequest: WeakMap<Request, Navigation>;
  listeners: Array<() => void> };

const freshNavigation = (): Navigation => ({ responseObserved: false, statusClass: 'unknown',
  redirectCount: 0, committed: false, failed: false });
const freshDocument = (navigation = freshNavigation(), lifecycleKnown = false): Document => ({
  generationId: navigation.generationId ?? `document-${randomUUID()}`,
  ...(lifecycleKnown ? { domContentLoaded: false, load: false } : {}), navigation });
function statusClass(status: number): StatusClass {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}
function failureCategory(request: Request): NonNullable<DeferredBrowserDiagnosticV1['navigationFailureCategory']> {
  // Classify locally. Never retain the raw browser/network failure string.
  const message = request.failure()?.errorText ?? '';
  if (/abort|cancel/i.test(message)) return 'ABORTED';
  if (/timed? ?out/i.test(message)) return 'TIMEOUT';
  if (/dns|connection|network|ssl|proxy|internet/i.test(message)) return 'NETWORK';
  return message ? 'OTHER' : 'UNKNOWN';
}
function redirects(request: Request): number {
  let count = 0, previous = request.redirectedFrom();
  while (previous && count < 32) { count++; previous = previous.redirectedFrom(); }
  return count;
}

/** Read-only, private accounting for a single protected exploration session. */
export class DeferredDocumentReadinessTracker {
  readonly #pages = new Map<Page, WatchedPage>();
  readonly #session: ProtectedBrowserSession;
  readonly #emit: DeferredBrowserDiagnosticSink | undefined;
  readonly #ownerId: string;
  readonly #identity: (object: object, prefix: string) => string;
  readonly #onPage: (page: Page) => void;
  #lastUrlObservation: { page: Page; frame: Frame; generationId: string } | undefined;
  #disposed = false;

  constructor(session: ProtectedBrowserSession, ownerId: string, emit: DeferredBrowserDiagnosticSink | undefined,
    identity: (object: object, prefix: string) => string) {
    this.#session = session; this.#ownerId = ownerId; this.#emit = emit; this.#identity = identity;
    this.#onPage = page => this.#watch(page);
    if (!emit) return;
    session.context.on('page', this.#onPage);
    session.context.pages().forEach(this.#onPage);
    session.onClosing(() => this.dispose());
  }

  #watch(page: Page): void {
    if (this.#disposed || this.#pages.has(page)) return;
    const watched: WatchedPage = { page, document: freshDocument(), navigationByRequest: new WeakMap(), listeners: [] };
    this.#pages.set(page, watched);
    const listen = (event: 'request' | 'response' | 'requestfailed' | 'framenavigated' | 'domcontentloaded' | 'load',
      handler: (...args: any[]) => void) => {
      const on = page.on.bind(page) as (name: string, listener: (...args: any[]) => void) => void;
      const off = page.off.bind(page) as (name: string, listener: (...args: any[]) => void) => void;
      const guarded = (...args: any[]) => { try { handler(...args); }
        catch { /* Browser event accounting cannot affect execution. */ } };
      on(event, guarded); watched.listeners.push(() => off(event, guarded));
    };
    const mainRequest = (request: Request): boolean => {
      try { return request.isNavigationRequest() && request.frame() === page.mainFrame(); }
      catch { return false; }
    };
    listen('request', (request: Request) => {
      if (!mainRequest(request)) return;
      watched.pending = { ...freshNavigation(), generationId: `document-${randomUUID()}`,
        redirectCount: redirects(request), url: diagnosticBrowserUrl(request.url()) };
      watched.navigationByRequest.set(request, watched.pending);
      this.#recordNavigation(watched, watched.pending, 'main_document_navigation', 'started');
    });
    listen('response', (response: Response) => {
      const request = response.request();
      if (!mainRequest(request)) return;
      const nav = watched.navigationByRequest.get(request);
      if (!nav) return;
      nav.responseObserved = true; nav.statusClass = statusClass(response.status());
      nav.url = diagnosticBrowserUrl(response.url());
      this.#recordNavigation(watched, nav, 'main_document_response', 'success');
    });
    listen('requestfailed', (request: Request) => {
      if (!mainRequest(request)) return;
      const nav = watched.navigationByRequest.get(request);
      if (!nav) return;
      nav.failed = true; nav.failureCategory = failureCategory(request);
      this.#recordNavigation(watched, nav, 'main_document_navigation', 'failure');
    });
    listen('framenavigated', (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      const navigation = watched.pending ?? freshNavigation();
      navigation.committed = true;
      watched.document = freshDocument(navigation, true);
      watched.pending = undefined;
      this.#recordNavigation(watched, navigation, 'main_document_navigation', 'success');
    });
    listen('domcontentloaded', () => { watched.document.domContentLoaded = true; });
    listen('load', () => { watched.document.load = true; });
  }

  #recordNavigation(watched: WatchedPage, navigation: Navigation,
    operation: 'main_document_navigation' | 'main_document_response',
    outcome: 'started' | 'success' | 'failure'): void {
    if (!this.#emit || this.#disposed) return;
    const now = performance.now();
    try { this.#emit({ diagnosticVersion: '1', source: 'grounding', operation,
      phase: 'exploration', ownerId: this.#ownerId, startedAtMs: now, endedAtMs: now, elapsedMs: 0,
      outcome,
      ...diagnosticBrowserState(this.#session), pageId: this.#identity(watched.page, 'page'),
      mainFrameId: this.#identity(watched.page.mainFrame(), 'frame'),
      documentGenerationId: navigation.generationId ?? watched.document.generationId,
      currentUrl: navigation.url ?? diagnosticBrowserUrl(watched.page.url()),
      mainResponseObserved: navigation.responseObserved, mainResponseStatusClass: navigation.statusClass,
      redirectCount: navigation.redirectCount, navigationCommitted: navigation.committed,
      navigationFailed: navigation.failed,
      ...(navigation.failureCategory ? { navigationFailureCategory: navigation.failureCategory } : {}) }); }
    catch { /* Diagnostics have no browser authority. */ }
  }

  currentIdentity(): Pick<DeferredBrowserDiagnosticV1, 'pageId' | 'mainFrameId' | 'documentGenerationId'> {
    try {
      const pages = this.#session.context.pages();
      if (pages.length !== 1 || pages[0]!.isClosed()) return {};
      const page = pages[0]!, watched = this.#pages.get(page);
      return watched ? { pageId: this.#identity(page, 'page'), mainFrameId: this.#identity(page.mainFrame(), 'frame'),
        documentGenerationId: watched.document.generationId } : {};
    } catch { return {}; }
  }

  /** The browser read is launched at the boundary; it never gates an action or assertion. */
  probe(boundary: Boundary, stepId: string): void {
    try { this.#probe(boundary, stepId); }
    catch { /* Diagnostic sampling cannot change browser or QA control flow. */ }
  }

  #probe(boundary: Boundary, stepId: string): void {
    if (!this.#emit || this.#disposed) return;
    const startedAtMs = performance.now();
    let watched: WatchedPage | undefined;
    try {
      const pages = this.#session.context.pages();
      if (pages.length === 1 && !pages[0]!.isClosed()) watched = this.#pages.get(pages[0]!);
    } catch { /* Unknown ownership is still reported. */ }
    const docState = watched?.document, generationId = docState?.generationId;
    const navigation = watched?.pending ?? docState?.navigation;
    const previous = this.#lastUrlObservation;
    if (watched && generationId && boundary === 'url_observation')
      this.#lastUrlObservation = { page: watched.page, frame: watched.page.mainFrame(), generationId };
    const browserState = diagnosticBrowserState(this.#session);
    const fields: Partial<DeferredBrowserDiagnosticV1> = {
      ...(watched ? { pageId: this.#identity(watched.page, 'page'),
        mainFrameId: this.#identity(watched.page.mainFrame(), 'frame'),
        currentUrl: diagnosticBrowserUrl(watched.page.url()) } : {}),
      ...(generationId ? { documentGenerationId: generationId } : {}),
      ...(docState?.domContentLoaded !== undefined ? { domContentLoadedObserved: docState.domContentLoaded } : {}),
      ...(docState?.load !== undefined ? { loadObserved: docState.load } : {}),
      mainResponseObserved: navigation?.responseObserved ?? false,
      mainResponseStatusClass: navigation?.statusClass ?? 'unknown',
      redirectCount: navigation?.redirectCount ?? 0,
      navigationCommitted: navigation?.committed ?? false, navigationFailed: navigation?.failed ?? false,
      ...(navigation?.failureCategory ? { navigationFailureCategory: navigation.failureCategory } : {}),
      ...(boundary === 'before_candidate_query' && previous ?
        { documentReplacedSinceUrlObservation: previous.page !== watched?.page ||
          previous.frame !== watched.page.mainFrame() || previous.generationId !== generationId } : {}),
    };
    try { this.#emit({ diagnosticVersion: '1', source: 'grounding', operation: 'document_readiness',
      phase: 'exploration', ownerId: this.#ownerId, stepId, readinessBoundary: boundary,
      startedAtMs, endedAtMs: startedAtMs, elapsedMs: 0, outcome: 'started',
      ...browserState, ...fields, documentReadyState: 'unknown' }); }
    catch { /* The immediate boundary marker cannot affect the browser. */ }
    const finish = (readyState: DeferredBrowserDiagnosticV1['documentReadyState'], success: boolean) => {
      if (this.#disposed) return;
      const endedAtMs = performance.now(), changed = !!watched && watched.document.generationId !== generationId;
      try { this.#emit?.({ diagnosticVersion: '1', source: 'grounding', operation: 'document_readiness',
        phase: 'exploration', ownerId: this.#ownerId, stepId, readinessBoundary: boundary,
        startedAtMs, endedAtMs, elapsedMs: diagnosticElapsed(startedAtMs, endedAtMs),
        outcome: success && !changed ? 'success' : 'failure', ...browserState, ...fields,
        documentReadyState: changed ? 'unknown' : readyState ?? 'unknown',
        documentChangedDuringRead: changed }); }
      catch { /* Diagnostics have no browser authority. */ }
    };
    if (!watched) { finish('unknown', false); return; }
    void watched.page.evaluate(() => globalThis.document.readyState).then(value => {
      finish(value === 'loading' || value === 'interactive' || value === 'complete' ? value : 'unknown', true);
    }, () => finish('unknown', false));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try { this.#session.context.off('page', this.#onPage); } catch { /* Closing context. */ }
    for (const watched of this.#pages.values()) for (const remove of watched.listeners)
      try { remove(); } catch { /* Closing page. */ }
    this.#pages.clear();
  }
}
