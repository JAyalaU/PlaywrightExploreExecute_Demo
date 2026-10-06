import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import type { ProtectedBrowserSession } from '../profile/context.js';

export type CommittedDocumentWaitStop = 'PAGE_NOT_OWNED' | 'PAGE_CLOSED' | 'CONTEXT_CLOSED' |
  'BROWSER_DISCONNECTED' | 'DOCUMENT_REPLACED' | 'TIMEOUT';
export type CommittedDocumentWaitObservation = {
  waitRequired: boolean; generationId?: string; domContentLoadedReached: boolean;
  startedAtMs: number; endedAtMs: number; elapsedMs: number; safeStop?: CommittedDocumentWaitStop;
};
type Waiter = { generationId: string; resolve: () => void;
  reject: (reason: CommittedDocumentWaitStop) => void };
type Watched = { generationId?: string; pending: Request | undefined; dcl: boolean;
  waiters: Set<Waiter>; remove: Array<() => void> };

export class CommittedDocumentReadinessError extends Error {
  constructor(readonly reason: CommittedDocumentWaitStop,
    readonly observation: CommittedDocumentWaitObservation) {
    super(reason); this.name = 'CommittedDocumentReadinessError';
  }
}

/** Passive main-document commit/lifecycle tracking for one fresh protected context. */
export class CommittedDocumentReadiness {
  readonly #pages = new Map<Page, Watched>();
  readonly #onPage: (page: Page) => void;
  #disposed = false;

  constructor(readonly session: ProtectedBrowserSession) {
    this.#onPage = page => this.#watch(page);
    session.context.on('page', this.#onPage);
    session.context.pages().forEach(this.#onPage);
    session.onClosing(() => this.dispose());
  }

  #watch(page: Page): void {
    if (this.#disposed || this.#pages.has(page)) return;
    const watched: Watched = { pending: undefined, dcl: false, waiters: new Set(), remove: [] };
    this.#pages.set(page, watched);
    const request = (item: Request) => {
      try { return item.isNavigationRequest() && item.frame() === page.mainFrame(); }
      catch { return false; }
    };
    const onRequest = (item: Request) => { if (request(item)) watched.pending = item; };
    const onFailed = (item: Request) => { if (watched.pending === item) watched.pending = undefined; };
    const onNavigated = (frame: ReturnType<Page['mainFrame']>) => {
      if (frame !== page.mainFrame() || !watched.pending) return;
      watched.pending = undefined;
      for (const waiter of watched.waiters) waiter.reject('DOCUMENT_REPLACED');
      watched.waiters.clear();
      watched.generationId = `document-${randomUUID()}`;
      watched.dcl = false;
    };
    const onDcl = () => {
      if (!watched.generationId) return;
      watched.dcl = true;
      for (const waiter of watched.waiters) {
        if (waiter.generationId === watched.generationId) waiter.resolve();
      }
      watched.waiters.clear();
    };
    const onClose = () => {
      for (const waiter of watched.waiters) waiter.reject('PAGE_CLOSED');
      watched.waiters.clear();
    };
    page.on('request', onRequest); watched.remove.push(() => page.off('request', onRequest));
    page.on('requestfailed', onFailed); watched.remove.push(() => page.off('requestfailed', onFailed));
    page.on('framenavigated', onNavigated); watched.remove.push(() => page.off('framenavigated', onNavigated));
    page.on('domcontentloaded', onDcl); watched.remove.push(() => page.off('domcontentloaded', onDcl));
    page.on('close', onClose); watched.remove.push(() => page.off('close', onClose));
  }

  async waitForCurrentPage(timeoutMs: number,
    observe?: (attempt: CommittedDocumentWaitObservation) => void): Promise<CommittedDocumentWaitObservation> {
    const startedAtMs = performance.now();
    const pages = this.session.context.pages();
    if (pages.length !== 1) {
      const reason: CommittedDocumentWaitStop = this.session.context.browser()?.isConnected() === false ?
        'BROWSER_DISCONNECTED' : 'PAGE_NOT_OWNED';
      const observation = this.#observation(startedAtMs, false, false, undefined, reason);
      try { observe?.(observation); } catch { /* Diagnostic sink has no authority. */ }
      throw new CommittedDocumentReadinessError(reason, observation);
    }
    return this.wait(pages[0]!, timeoutMs, observe);
  }

  /** Check that an ensuing document read still belongs to the waited generation. */
  assertCurrentGeneration(page: Page, observed: CommittedDocumentWaitObservation): void {
    const watched = this.#pages.get(page);
    const reason: CommittedDocumentWaitStop | undefined = this.#disposed || this.session.isClosed ? 'CONTEXT_CLOSED' :
      page.isClosed() ? 'PAGE_CLOSED' :
      !watched || this.session.context.pages().length !== 1 || this.session.context.pages()[0] !== page ? 'PAGE_NOT_OWNED' :
      this.session.context.browser()?.isConnected() === false ? 'BROWSER_DISCONNECTED' :
      watched.generationId !== observed.generationId ? 'DOCUMENT_REPLACED' : undefined;
    if (reason) throw new CommittedDocumentReadinessError(reason,
      this.#observation(observed.startedAtMs, observed.waitRequired, false, observed.generationId, reason));
  }

  async wait(page: Page, timeoutMs: number,
    observe?: (attempt: CommittedDocumentWaitObservation) => void): Promise<CommittedDocumentWaitObservation> {
    const startedAtMs = performance.now();
    const watched = this.#pages.get(page);
    const generationId = watched?.generationId;
    const fail = (reason: CommittedDocumentWaitStop, required: boolean): never => {
      const observation = this.#observation(startedAtMs, required, false, generationId, reason);
      try { observe?.(observation); } catch { /* Diagnostic sink has no authority. */ }
      throw new CommittedDocumentReadinessError(reason, observation);
    };
    if (this.#disposed || this.session.isClosed) fail('CONTEXT_CLOSED', false);
    if (page.isClosed()) fail('PAGE_CLOSED', false);
    if (!watched || this.session.context.pages().length !== 1 ||
        this.session.context.pages()[0] !== page) fail('PAGE_NOT_OWNED', false);
    if (this.session.context.browser()?.isConnected() === false) fail('BROWSER_DISCONNECTED', false);
    const finish = (required: boolean): CommittedDocumentWaitObservation => {
      const observation = this.#observation(startedAtMs, required, watched!.dcl, generationId);
      try { observe?.(observation); } catch { /* Diagnostic sink has no authority. */ }
      return observation;
    };
    // No committed main-document generation is evidence to wait on. In
    // particular, an initial about:blank page must never acquire a new wait.
    if (!generationId || watched.dcl) return finish(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: Waiter | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waiter = { generationId, resolve, reject };
        watched.waiters.add(waiter);
        timer = setTimeout(() => reject('TIMEOUT'), Math.max(1, timeoutMs));
      });
    } catch (reason) { fail(reason as CommittedDocumentWaitStop, true); }
    finally {
      if (timer) clearTimeout(timer);
      if (waiter) watched.waiters.delete(waiter);
    }
    if (this.#disposed || this.session.isClosed) fail('CONTEXT_CLOSED', true);
    if (page.isClosed()) fail('PAGE_CLOSED', true);
    if (watched.generationId !== generationId) fail('DOCUMENT_REPLACED', true);
    if (!watched.dcl) fail('DOCUMENT_REPLACED', true);
    return finish(true);
  }

  #observation(startedAtMs: number, waitRequired: boolean, domContentLoadedReached: boolean,
    generationId?: string, safeStop?: CommittedDocumentWaitStop): CommittedDocumentWaitObservation {
    const endedAtMs = performance.now();
    return { waitRequired, ...(generationId ? { generationId } : {}), domContentLoadedReached,
      startedAtMs, endedAtMs, elapsedMs: Math.max(0, Math.min(86_400_000, Math.round(endedAtMs - startedAtMs))),
      ...(safeStop ? { safeStop } : {}) };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.session.context.off('page', this.#onPage);
    for (const watched of this.#pages.values()) {
      for (const waiter of watched.waiters) waiter.reject('CONTEXT_CLOSED');
      watched.waiters.clear();
      for (const remove of watched.remove) remove();
    }
    this.#pages.clear();
  }
}
