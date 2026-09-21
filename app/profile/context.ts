import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import type { EffectiveProfile, ProfileRef } from './contracts.js';
import { ProfileCatalog, assertEquivalentEffectiveProfile } from './contracts.js';
import { ProtectedProxy } from './network.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Auth contents are obtained only at session start and never enter profile metadata. */
export interface AuthStateProvider {
  load(reference: ProfileRef): Promise<StorageState>;
}

/** Supplied by a trusted operator boundary after review of non-loopback targets. */
export interface ExternalTargetGate {
  authorize(effective: EffectiveProfile): Promise<void>;
}

function requiresExternalReview(effective: EffectiveProfile): boolean {
  return effective.policy.destinations.some((destination) => destination.addresses.some((address) => {
    if (isIP(address) === 4) return !address.startsWith('127.');
    if (isIP(address) === 6) return address !== '::1';
    return true;
  }));
}

export interface BrowserVersions {
  node: string;
  playwright: string;
  browser: string;
}

const require = createRequire(import.meta.url);
const playwrightVersion = (require('@playwright/test/package.json') as { version: string }).version;

/** Refuse a session if this browser build bypasses the configured proxy. */
async function verifyProxyBoundary(browser: Browser, effective: EffectiveProfile): Promise<void> {
  let reachedDirectly = false;
  const server = http.createServer((_request, response) => {
    reachedDirectly = true;
    response.end('unprotected');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot verify browser network policy');
  const probePort = address.port;
  let probeContext: BrowserContext | undefined;
  try {
    if (effective.policy.destinations.some((item) => item.host === '127.0.0.1' && item.ports.includes(probePort))) {
      throw new Error('Cannot verify browser network policy with an allowed probe destination');
    }
    probeContext = await browser.newContext({ serviceWorkers: 'block' });
    const page = await probeContext.newPage();
    const response = await page.goto(`http://127.0.0.1:${probePort}/policy-probe`, { timeout: 5000 });
    if (reachedDirectly || response?.status() !== 403 || await response.text() !== 'Network policy denied request') {
      throw new Error('Browser network policy is unenforceable');
    }
  } finally {
    await probeContext?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export class ProtectedBrowserSession {
  readonly context: BrowserContext;
  readonly effectiveProfile: EffectiveProfile;
  readonly versions: BrowserVersions;
  readonly #browser: Browser;
  readonly #proxy: ProtectedProxy;
  #closed = false;

  constructor(browser: Browser, context: BrowserContext, proxy: ProtectedProxy, effectiveProfile: EffectiveProfile) {
    this.#browser = browser;
    this.context = context;
    this.#proxy = proxy;
    this.effectiveProfile = effectiveProfile;
    this.versions = { node: process.version, playwright: playwrightVersion, browser: browser.version() };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    try { await this.context.close(); } catch (error) { errors.push(error); }
    try { await this.#browser.close(); } catch (error) { errors.push(error); }
    try { await this.#proxy.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Protected browser session cleanup failed');
  }
}

export class ProtectedContextFactory {
  constructor(readonly catalog: ProfileCatalog, readonly authProvider?: AuthStateProvider,
    readonly externalTargetGate?: ExternalTargetGate) {}

  /** The caller must close the returned session, including after test failure. */
  async open(reference: ProfileRef, expected?: EffectiveProfile, recording?: { videoDir: string }): Promise<ProtectedBrowserSession> {
    const effective = this.catalog.resolve(reference);
    if (expected) assertEquivalentEffectiveProfile(expected, effective);
    if (requiresExternalReview(effective)) {
      if (!this.externalTargetGate) throw new Error('External target requires security-review approval');
      await this.externalTargetGate.authorize(effective);
    }
    if (effective.profile.authStateRef && !this.authProvider) throw new Error('Protected auth-state provider is unavailable');

    const proxy = await ProtectedProxy.start(effective.policy);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        args: [
          '--proxy-bypass-list=<-loopback>',
          '--disable-background-networking',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      });
      browser.on('disconnected', () => {
        void proxy.close().catch((error: unknown) => process.emitWarning(`Browser proxy cleanup failed: ${String(error)}`));
      });
      await verifyProxyBoundary(browser, effective);
      const authState = effective.profile.authStateRef
        ? await this.authProvider!.load(effective.profile.authStateRef)
        : undefined;
      const profile = effective.profile;
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
        ...(recording ? { recordVideo: { dir: recording.videoDir } } : {}),
      });
      context.setDefaultTimeout(profile.timeoutPolicy.actionMs);
      context.setDefaultNavigationTimeout(profile.timeoutPolicy.navigationMs);
      return new ProtectedBrowserSession(browser, context, proxy, effective);
    } catch (error) {
      try { await browser?.close(); } finally { await proxy.close(); }
      throw error;
    }
  }
}
