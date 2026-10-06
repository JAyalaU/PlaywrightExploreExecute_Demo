import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import type { EffectiveProfile, ProfileRef } from './contracts.js';
import { ProfileCatalog, assertEquivalentEffectiveProfile, profilePresentationMode } from './contracts.js';
import { restrictedBrowserEnvironment } from './browser-environment.js';
import { IsolatedBrowser } from './isolated-browser.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Auth contents are obtained only at session start and never enter profile metadata. */
export interface AuthStateProvider {
  load(reference: ProfileRef): Promise<StorageState>;
}

/** Historical extension point; destination approval is unused by the active PoC. */
export interface ExternalTargetGate {
  authorize(effective: EffectiveProfile): Promise<void>;
}

export interface BrowserVersions {
  node: string;
  playwright: string;
  browser: string;
}

/** Correlation metadata only; it cannot change browser launch or policy. */
export interface ProtectedSessionOptions {
  videoDir?: string;
  observationOwner?: { kind: 'attempt' | 'run'; id: string };
  /** Private, non-authoritative lifecycle observation. Sink errors are ignored. */
  observeLifecycle?: (boundary: 'browser_launch_started' | 'browser_launch_completed' |
    'context_create_started' | 'context_create_completed') => void;
}

/** Trusted presentation choice. It does not alter the execution profile or QA artifacts. */
export interface ProtectedFactoryPresentationOptions {
  viewOnlyHeaded?: boolean;
}

export type TrustedBrowserBackend = 'docker-isolated' | 'local-windows';

/** Read only from the operator process environment, never from task or request data. */
export function parseTrustedBrowserBackend(value: string | undefined): TrustedBrowserBackend {
  if (value === undefined || value === '' || value === 'docker-isolated') return 'docker-isolated';
  if (value === 'local-windows') return value;
  throw new Error('Unsupported trusted browser backend');
}

/** Cleanup completed, but the trusted final read before teardown failed. */
export class ProtectedFinalCheckError extends Error {
  constructor(readonly checkError: unknown) { super('Protected final read failed'); }
}

const require = createRequire(import.meta.url);
const playwrightVersion = (require('@playwright/test/package.json') as { version: string }).version;

export class ProtectedBrowserSession {
  readonly context: BrowserContext;
  readonly effectiveProfile: EffectiveProfile;
  readonly versions: BrowserVersions;
  readonly #browser: Browser;
  readonly #isolated: IsolatedBrowser | undefined;
  readonly #closingObservers = new Set<() => void>();
  #closePromise: Promise<void> | undefined;

  constructor(browser: Browser, context: BrowserContext, effectiveProfile: EffectiveProfile,
    isolated?: IsolatedBrowser) {
    this.#browser = browser;
    this.context = context;
    this.#isolated = isolated;
    this.effectiveProfile = effectiveProfile;
    this.versions = { node: process.version, playwright: playwrightVersion, browser: browser.version() };
  }

  /** Used only by restricted runtime proofs; never part of persisted TestSpec data. */
  get isolationContainerId(): string | undefined { return this.#isolated?.containerId; }
  /** The viewer can observe only the same physically headed isolated Chromium. */
  get isViewerHeaded(): boolean { return !this.isClosed && this.#isolated?.isHeaded === true; }
  /** Private viewer bridge requires a physically headed isolated session. */
  openRfbBridge(): ReturnType<IsolatedBrowser['openRfbBridge']> {
    if (!this.isViewerHeaded || !this.#isolated) {
      throw new Error('Headed RFB session unavailable');
    }
    return this.#isolated.openRfbBridge();
  }
  get isClosed(): boolean { return this.#closePromise !== undefined; }

  /** Observation-only lifecycle hook; callbacks cannot alter protected cleanup. */
  onClosing(observer: () => void): () => void {
    if (this.#closePromise) { observer(); return () => undefined; }
    this.#closingObservers.add(observer);
    return () => this.#closingObservers.delete(observer);
  }

  close(): Promise<void> {
    // Publish the in-flight promise before invoking closing observers. A
    // concurrent cancellation or reentrant close must await the same cleanup.
    return this.#closePromise ??= Promise.resolve().then(() => this.#close());
  }

  /** Read-only final proof after closing observers; teardown always runs. No new actions. */
  closeWithFinalCheck(check: () => Promise<void>): Promise<void> {
    if (this.#closePromise) return this.#closePromise.then(() => { throw new ProtectedFinalCheckError(new Error('Final check missed closing boundary')); });
    return this.#closePromise = Promise.resolve().then(() => this.#close(check));
  }

  async #close(finalCheck?: () => Promise<void>): Promise<void> {
    for (const observer of this.#closingObservers) {
      try { observer(); } catch { /* Observation cannot change browser cleanup. */ }
    }
    this.#closingObservers.clear();
    let checkFailed = false, checkError: unknown;
    if (finalCheck) try { await finalCheck(); } catch (error) { checkFailed = true; checkError = error; }
    const errors: unknown[] = [];
    try { await this.context.close(); } catch (error) { errors.push(error); }
    try {
      if (this.#isolated) await this.#isolated.close();
      else await this.#browser.close();
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Protected browser session cleanup failed');
    if (checkFailed) throw new ProtectedFinalCheckError(checkError);
  }
}

export class ProtectedContextFactory {
  readonly browserBackend: TrustedBrowserBackend;
  constructor(readonly catalog: ProfileCatalog, readonly authProvider?: AuthStateProvider,
    readonly externalTargetGate?: ExternalTargetGate,
    readonly presentationOptions: ProtectedFactoryPresentationOptions = {}) {
    this.browserBackend = parseTrustedBrowserBackend(process.env.PLAYWRIGHT_DEMO_BROWSER_BACKEND);
  }

  /** Optional bounded presentation pause; ordinary and headless factories do nothing. */
  async pauseForObservation(_session: ProtectedBrowserSession): Promise<void> {}

  /** The caller must close the returned session, including after test failure. */
  async open(reference: ProfileRef, expected?: EffectiveProfile, options?: ProtectedSessionOptions): Promise<ProtectedBrowserSession> {
    const effective = this.catalog.resolve(reference);
    if (expected) assertEquivalentEffectiveProfile(expected, effective);
    const isolation = 'browserIsolation' in effective.profile ? effective.profile.browserIsolation : undefined;
    if (isolation === 'local-windows' && this.browserBackend !== 'local-windows' ||
        isolation === 'docker' && this.browserBackend !== 'docker-isolated' ||
        isolation === undefined && this.browserBackend === 'local-windows') {
      throw new Error('Browser backend and execution profile mismatch');
    }
    if (isolation === 'local-windows' && process.platform !== 'win32') {
      throw new Error('Local Windows browser backend requires Windows');
    }
    if (effective.profile.authStateRef && !this.authProvider) throw new Error('Protected auth-state provider is unavailable');
    if (this.presentationOptions.viewOnlyHeaded &&
        (!('browserIsolation' in effective.profile) || effective.profile.browserIsolation !== 'docker')) {
      throw new Error('View-only headed presentation requires an isolated browser');
    }

    let browser: Browser | undefined;
    let isolated: IsolatedBrowser | undefined;
    const observe = (boundary: Parameters<NonNullable<ProtectedSessionOptions['observeLifecycle']>>[0]) => {
      try { options?.observeLifecycle?.(boundary); } catch { /* Diagnostics cannot affect launch. */ }
    };
    try {
      observe('browser_launch_started');
      if (isolation === 'docker') {
        isolated = await IsolatedBrowser.open(this.presentationOptions.viewOnlyHeaded
          ? 'headed' : profilePresentationMode(effective.profile),
        { observationalSlowMo: !this.presentationOptions.viewOnlyHeaded });
        browser = isolated.browser;
      } else browser = await chromium.launch({
        headless: profilePresentationMode(effective.profile) === 'headless',
        env: restrictedBrowserEnvironment(process.env),
        args: [
          '--disable-background-networking',
          '--disable-quic',
        ],
      });
      observe('browser_launch_completed');
      const authState = effective.profile.authStateRef
        ? await this.authProvider!.load(effective.profile.authStateRef)
        : undefined;
      const profile = effective.profile;
      observe('context_create_started');
      const context = await browser.newContext({
        viewport: profile.viewport,
        locale: profile.locale,
        ...(profile.timezoneId ? { timezoneId: profile.timezoneId } : {}),
        ...(profile.colorScheme ? { colorScheme: profile.colorScheme } : {}),
        ...(profile.deviceScaleFactor ? { deviceScaleFactor: profile.deviceScaleFactor } : {}),
        ...(profile.isMobile !== undefined ? { isMobile: profile.isMobile } : {}),
        ...(profile.hasTouch !== undefined ? { hasTouch: profile.hasTouch } : {}),
        ...(profile.javaScriptEnabled !== undefined ? { javaScriptEnabled: profile.javaScriptEnabled } : {}),
        ...(profile.reducedMotion ? { reducedMotion: profile.reducedMotion } : {}),
        ...(authState ? { storageState: authState } : {}),
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
        ...(options?.videoDir ? { recordVideo: { dir: options.videoDir } } : {}),
      });
      context.setDefaultTimeout(profile.timeoutPolicy.actionMs);
      context.setDefaultNavigationTimeout(profile.timeoutPolicy.navigationMs);
      observe('context_create_completed');
      return new ProtectedBrowserSession(browser, context, effective, isolated);
    } catch (error) {
      try {
        if (isolated) await isolated.close();
        else await browser?.close();
      } finally { /* Browser cleanup is handled above. */ }
      throw error;
    }
  }
}
