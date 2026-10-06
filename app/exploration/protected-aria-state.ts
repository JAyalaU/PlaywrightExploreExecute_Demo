import type { Frame } from '@playwright/test';
import type { ProtectedBrowserSession } from '../profile/context.js';
import { diagnosticExceptionName, type DeferredBrowserDiagnosticV1,
  type ProtectedAriaFailureCategory } from '../domain/deferred-browser-diagnostics.js';

type AriaFailure = {
  exceptionName: NonNullable<DeferredBrowserDiagnosticV1['exceptionName']>;
  ariaFailureCategory: ProtectedAriaFailureCategory;
  playwrightTimeout: boolean;
  frameState: NonNullable<DeferredBrowserDiagnosticV1['frameState']>;
};

function property(error: unknown, key: 'name' | 'code' | 'message'): string {
  try {
    const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' ? value.slice(0, 2048) : '';
  } catch { return ''; }
}

/** Maps a raw Playwright error to a closed private category. No error text escapes this function. */
export function classifyProtectedAriaFailure(error: unknown, frame: Frame,
  session: ProtectedBrowserSession): AriaFailure {
  let frameState: AriaFailure['frameState'] = 'unknown';
  let contextClosed = false, pageClosed = false, browserDisconnected = false;
  try { frameState = frame.isDetached() ? 'detached' : 'attached'; } catch { /* state unavailable */ }
  try { contextClosed = session.isClosed; } catch { /* state unavailable */ }
  try { pageClosed = frame.page().isClosed(); } catch { /* state unavailable */ }
  try { browserDisconnected = session.context.browser()?.isConnected() === false; } catch { /* state unavailable */ }

  const name = property(error, 'name'), code = property(error, 'code');
  const message = property(error, 'message');
  const playwrightTimeout = name === 'TimeoutError' || code === 'ETIMEDOUT' ||
    /(?:timeout|timed out)(?:\s+\d+ms)?\s*(?:exceeded)?/i.test(message);
  let category: ProtectedAriaFailureCategory;
  if (browserDisconnected || code === 'BROWSER_DISCONNECTED') category = 'BROWSER_DISCONNECTED';
  else if (contextClosed || code === 'CONTEXT_CLOSED' || /browser context.*(?:closed|destroyed)/i.test(message)) category = 'CONTEXT_CLOSED';
  else if (pageClosed || code === 'PAGE_CLOSED' || /\bpage (?:has been |was |is )?closed\b|\bpage crashed\b/i.test(message)) category = 'PAGE_CLOSED';
  else if (frameState === 'detached' || code === 'FRAME_DETACHED' || /frame (?:was |is )?detached|detached frame/i.test(message))
    category = 'FRAME_DETACHED';
  else if (name === 'TargetClosedError' || code === 'TARGET_CLOSED' || /target (?:page, context or browser has been |was )?closed/i.test(message))
    category = 'TARGET_CLOSED';
  else if (playwrightTimeout) category = 'PLAYWRIGHT_TIMEOUT';
  else if (/execution context (?:was )?destroyed|cannot find context with specified id/i.test(message))
    category = 'EXECUTION_CONTEXT_DESTROYED';
  else if (/navigation.*(?:interrupted|in progress)|navigating|frame navigated/i.test(message))
    category = 'NAVIGATION_INTERRUPTED';
  else if (name === 'ProtocolError' || code === 'PROTOCOL_ERROR' || /protocol error/i.test(message))
    category = 'PROTOCOL_ERROR';
  else if (/ariaSnapshot|aria snapshot|accessibility snapshot/i.test(message)) category = 'ARIA_SNAPSHOT_API_FAILURE';
  else category = 'UNKNOWN_PLAYWRIGHT_ERROR';
  return { exceptionName: diagnosticExceptionName(error) ?? 'OtherError', ariaFailureCategory: category,
    playwrightTimeout, frameState };
}

/** The only whole-body ARIA read used by protected state capture. The original exception is rethrown. */
export async function readProtectedAriaState(frame: Frame, session: ProtectedBrowserSession,
  onFailure?: (failure: AriaFailure) => void): Promise<string> {
  try { return await frame.locator('body').ariaSnapshot({ mode: 'ai', timeout: 3000 }); }
  catch (error) {
    if (onFailure) {
      try { onFailure(classifyProtectedAriaFailure(error, frame, session)); }
      catch { /* Private diagnostics cannot alter protected-state behavior. */ }
    }
    throw error;
  }
}
