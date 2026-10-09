import { AdaptiveBrowser } from '../adaptive/browser.js';
import { authoredDigest, type TaskEnvelopeV1, type AgentProposalV1, type ObservationV1 } from
  '../adaptive/contracts.js';
import type { BrowserAction, MinimalTask } from './types.js';

const dangerous = /\b(destroy|erase|purchase|buy|pay|checkout|transfer|send money|submit order|close account|delete account|remove account)\b/i;

/** Keep Phase 3A wire compatibility at the browser edge, not in the new controller. */
export function fixtureResetTask(task: MinimalTask): TaskEnvelopeV1 {
  return { version: '1', taskId: 'minimal_adaptive', authoredInstruction: task.instruction,
    authoredDigest: authoredDigest(task.instruction), startUrl: task.startUrl,
    approvalRef: 'trusted_caller', stateResetRef: task.resetRef,
    operatorConstraints: { allowedOrigins: [...task.allowedOrigins], prohibitedEffects: [],
      confirmationRequiredEffects: [], allowedOperations: ['click', 'check', 'uncheck'],
      budgets: { maxActions: task.maxActions, maxObservations: task.maxModelTurns * 3 + 3,
        maxScreenshots: task.maxScreenshots } } };
}

export class MinimalBrowserTools {
  readonly #origins: Set<string>;
  #mainFrameNavigations = 0;
  #documentLoads = 0;
  constructor(readonly browser: AdaptiveBrowser, readonly task: MinimalTask) {
    this.#origins = new Set(task.allowedOrigins.map(value => new URL(value).origin));
    if (!this.#origins.has(new URL(task.startUrl).origin)) throw new Error('START_ORIGIN_DENIED');
    browser.page.on('framenavigated', frame => {
      if (frame === browser.page.mainFrame()) this.#mainFrameNavigations++;
    });
    browser.page.on('domcontentloaded', () => { this.#documentLoads++; });
  }
  navigationMarker(): { navigations: number; documentLoads: number } {
    return { navigations: this.#mainFrameNavigations, documentLoads: this.#documentLoads };
  }
  async failureDiagnostic(marker: ReturnType<MinimalBrowserTools['navigationMarker']>,
    error: unknown): Promise<NonNullable<
    import('./types.js').Receipt['diagnostic']>> {
    const message = error instanceof Error ? error.message : '';
    const diagnostic: NonNullable<import('./types.js').Receipt['diagnostic']> = {
      capturedAt: new Date().toISOString(),
      currentUrl: this.browser.page.url(),
      mainFrameNavigations: this.#mainFrameNavigations - marker.navigations,
      documentLoads: this.#documentLoads - marker.documentLoads,
      ariaSnapshotTimedOut: /ariaSnapshot/i.test(message) && /timeout/i.test(message),
    };
    // This is diagnostic only: a stalled document must not stall the result.
    const state = await Promise.race([
      this.browser.page.evaluate(() => ({
        bodyAttached: !!document.body, documentReadyState: document.readyState,
      })).catch(() => undefined),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 750)),
    ]);
    if (state) {
      diagnostic.bodyAttached = state.bodyAttached;
      diagnostic.documentReadyState = state.documentReadyState;
    }
    return diagnostic;
  }
  async start(): Promise<ObservationV1> {
    // Block cross-origin main-frame navigation caused by a click before it leaves our scope.
    await this.browser.page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.browser.page.mainFrame() &&
          !this.#origins.has(new URL(request.url()).origin)) await route.abort();
      else await route.continue();
    });
    return this.browser.observeInitial(fixtureResetTask(this.task));
  }
  observe(): Promise<ObservationV1> { return this.browser.observeCurrent(); }
  screenshot(observation: ObservationV1): Promise<ObservationV1> {
    return this.browser.captureScreenshot(observation.observationId);
  }
  image(observation: ObservationV1): string | undefined {
    return observation.screenshot ? this.browser.getScreenshotData(observation.screenshot.ref) : undefined;
  }
  describe(action: BrowserAction, observation: ObservationV1): string {
    if (action.kind === 'navigate') return action.url;
    if (action.target.kind === 'role_name') return `${action.target.role} "${action.target.name}"`;
    if (action.target.kind === 'visual_coordinate') return action.target.description;
    const ref = action.target.ref;
    const element = observation.dom.elements.find(item => item.ref === ref);
    return element ? `${element.role} "${element.name ?? ''}" ${element.visual?.context ?? ''}`.trim() : 'unknown target';
  }
  async execute(action: BrowserAction, observation: ObservationV1): Promise<void> {
    if (action.observationId !== observation.observationId) throw new Error('STALE_OBSERVATION');
    const description = this.describe(action, observation);
    if (dangerous.test(description)) throw new Error('DANGEROUS_ACTION_DENIED');
    if (action.kind === 'navigate') {
      if (!['http:', 'https:'].includes(new URL(action.url).protocol) ||
          !this.#origins.has(new URL(action.url).origin)) throw new Error('NAVIGATION_DENIED');
      const proposal: Extract<AgentProposalV1, { kind: 'navigate' }> = { version: '1',
        proposalId: 'minimal', kind: 'navigate', observationId: action.observationId,
        url: action.url, predictedEffect: 'Page navigation' };
      await this.browser.dispatch(proposal, observation);
      return;
    }
    let target: Extract<AgentProposalV1, { kind: 'interact' }>['target'];
    if (action.target.kind === 'visual_coordinate') {
      if (action.operation !== 'click' || !observation.screenshot ||
          this.browser.page.url() !== observation.url) throw new Error('VISUAL_DISPATCH_DENIED');
      const actualLabel = await this.browser.page.evaluate(({ x, y }) => {
        const control = document.elementFromPoint(x, y)?.closest(
          'a,button,input,select,textarea,[role="button"],[role="checkbox"]');
        return [control?.getAttribute('aria-label'), control?.getAttribute('title'),
          control?.textContent].filter(Boolean).join(' ').slice(0, 1024);
      }, { x: action.target.x, y: action.target.y });
      if (dangerous.test(actualLabel)) throw new Error('DANGEROUS_ACTION_DENIED');
      target = { kind: 'visual_coordinate', x: action.target.x, y: action.target.y,
        description: action.target.description, context: action.target.description,
        screenshotRef: observation.screenshot.ref, coordinateFrameId: observation.coordinateFrameId,
        viewport: observation.viewport };
    } else target = action.target;
    const proposal: Extract<AgentProposalV1, { kind: 'interact' }> = { version: '1',
      proposalId: 'minimal', kind: 'interact', observationId: action.observationId,
      goalId: 'task', operation: action.operation, target,
      predictedEffect: 'Observe the result of this action' };
    await this.browser.dispatch(proposal, observation);
  }
}
