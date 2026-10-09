import type { Dialog, Page } from '@playwright/test';
import { AdaptiveBrowser } from '../adaptive/browser.js';
import { authoredDigest, type TaskEnvelopeV1, type AgentProposalV1, type ObservationV1 } from
  '../adaptive/contracts.js';
import type { BrowserAction, DialogEvidence, ExpectedDialog, MinimalTask } from './types.js';

const dangerous = /\b(destroy|erase|purchase|buy|pay|checkout|transfer|send money|submit order|close account|delete account|remove account)\b/i;
const allowedKeys = new Set(['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp',
  'ArrowLeft', 'ArrowRight', 'Space']);

/** Keep Phase 3A wire compatibility at the browser edge, not in the new controller. */
export function fixtureResetTask(task: MinimalTask): TaskEnvelopeV1 {
  return { version: '1', taskId: 'minimal_adaptive', authoredInstruction: task.instruction,
    authoredDigest: authoredDigest(task.instruction), startUrl: task.startUrl,
    approvalRef: 'trusted_caller', stateResetRef: task.resetRef,
    operatorConstraints: { allowedOrigins: [...task.allowedOrigins], prohibitedEffects: [],
      confirmationRequiredEffects: [], allowedOperations: ['click', 'check', 'uncheck',
        'fill', 'select', 'press'],
      budgets: { maxActions: task.maxActions, maxObservations: task.maxModelTurns * 3 + 3,
        maxScreenshots: task.maxScreenshots } } };
}

export class MinimalBrowserTools {
  readonly #origins: Set<string>;
  readonly #root: AdaptiveBrowser;
  readonly #pages = new Map<Page, AdaptiveBrowser>();
  #mainFrameNavigations = 0;
  #documentLoads = 0;
  constructor(public browser: AdaptiveBrowser, readonly task: MinimalTask) {
    this.#root = browser;
    this.#pages.set(browser.page, browser);
    this.#origins = new Set(task.allowedOrigins.map(value => new URL(value).origin));
    if (!this.#origins.has(new URL(task.startUrl).origin)) throw new Error('START_ORIGIN_DENIED');
    this.track(browser.page);
  }
  private track(page: Page): void {
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.#mainFrameNavigations++;
    });
    page.on('domcontentloaded', () => { this.#documentLoads++; });
  }
  private browserFor(page: Page): AdaptiveBrowser {
    let browser = this.#pages.get(page);
    if (!browser) {
      browser = new AdaptiveBrowser(page, () => this.#root.close(), this.#root.sessionId);
      browser.allowOrigins(this.task.allowedOrigins);
      this.#pages.set(page, browser);
      this.track(page);
    }
    return browser;
  }
  pages(): { pageId: string; url: string; selected: boolean }[] {
    return this.#root.page.context().pages().filter(page => !page.isClosed() &&
      this.#origins.has(new URL(page.url()).origin)).slice(0, 10).map(page => ({
      pageId: this.browserFor(page).pageId, url: page.url(), selected: page === this.browser.page }));
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
    // Context scope also catches popup navigation before the popup is selected.
    await this.browser.page.context().route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() &&
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
    if (action.kind === 'select_page') return `page ${action.pageId}`;
    const target = action.target;
    if (!target) return 'focused page';
    if (target.kind === 'role_name') return `${target.role} "${target.name}"`;
    if (target.kind === 'visual_coordinate') return target.description;
    const ref = target.ref;
    const element = observation.dom.elements.find(item => item.ref === ref);
    return element ? `${element.role} "${element.name ?? ''}" ${element.visual?.context ?? ''}`.trim() : 'unknown target';
  }
  private async clickWithDialog(proposal: Extract<AgentProposalV1, { kind: 'interact' }>,
    observation: ObservationV1, expected: ExpectedDialog): Promise<DialogEvidence> {
    let resolveHandled: () => void = () => {};
    const handled = new Promise<void>(resolve => { resolveHandled = resolve; });
    let evidence: DialogEvidence | undefined;
    let dialogError: Error | undefined;
    let count = 0;
    const onDialog = (dialog: Dialog) => {
      count++;
      const actual = dialog.type();
      const matches = count === 1 && actual === expected.kind;
      const response = matches ? expected.response : 'dismiss';
      const operation = response === 'accept'
        ? dialog.accept(expected.kind === 'prompt' ? expected.text : undefined)
        : dialog.dismiss();
      void operation.then(() => {
        if (matches) evidence = { kind: expected.kind, response };
        else dialogError = new Error(count > 1 ? 'MULTIPLE_DIALOGS' :
          `UNEXPECTED_DIALOG_TYPE:${actual}`);
      }).catch(() => { dialogError = new Error('DIALOG_RESPONSE_FAILED'); })
        .finally(resolveHandled);
    };
    this.browser.page.on('dialog', onDialog);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.browser.dispatch(proposal, observation);
      const seen = await Promise.race([handled.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3_000); })]);
      if (dialogError) throw dialogError;
      if (!seen || !evidence) throw new Error(`EXPECTED_DIALOG_NOT_SEEN:${expected.kind}`);
      return evidence;
    } finally {
      if (timer) clearTimeout(timer);
      this.browser.page.off('dialog', onDialog);
    }
  }
  private async clickWithPopup(proposal: Extract<AgentProposalV1, { kind: 'interact' }>,
    observation: ObservationV1): Promise<{ pageId: string; url: string }> {
    let resolvePopup: (page: Page) => void = () => {};
    const opened = new Promise<Page>(resolve => { resolvePopup = resolve; });
    const opener = this.browser.page;
    const onPopup = (page: Page) => { resolvePopup(page); };
    opener.on('popup', onPopup);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.browser.dispatch(proposal, observation);
      const popup = await Promise.race([opened,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3_000); })]);
      if (!popup) throw new Error('EXPECTED_POPUP_NOT_SEEN');
      await popup.waitForLoadState('domcontentloaded', { timeout: 3_000 });
      if (popup.context() !== opener.context() ||
          new URL(popup.url()).origin !== new URL(observation.url).origin ||
          !this.#origins.has(new URL(popup.url()).origin)) throw new Error('POPUP_ORIGIN_DENIED');
      return { pageId: this.browserFor(popup).pageId, url: popup.url() };
    } finally {
      if (timer) clearTimeout(timer);
      opener.off('popup', onPopup);
    }
  }
  async execute(action: BrowserAction, observation: ObservationV1): Promise<{
    dialog?: DialogEvidence; popup?: { pageId: string; url: string } }> {
    if (action.observationId !== observation.observationId) throw new Error('STALE_OBSERVATION');
    const description = this.describe(action, observation);
    if (dangerous.test(description)) throw new Error('DANGEROUS_ACTION_DENIED');
    if (action.kind === 'select_page') {
      await this.browser.assertCurrent(observation);
      const selected = this.pages().find(page => page.pageId === action.pageId);
      if (!selected) throw new Error('PAGE_NOT_AVAILABLE');
      const page = [...this.#pages.entries()].find(([, browser]) =>
        browser.pageId === selected.pageId)?.[0];
      if (!page || page.isClosed() || !this.#origins.has(new URL(page.url()).origin))
        throw new Error('PAGE_NOT_AVAILABLE');
      this.browser = this.browserFor(page);
      return {};
    }
    if (action.kind === 'navigate') {
      if (!['http:', 'https:'].includes(new URL(action.url).protocol) ||
          !this.#origins.has(new URL(action.url).origin)) throw new Error('NAVIGATION_DENIED');
      const proposal: Extract<AgentProposalV1, { kind: 'navigate' }> = { version: '1',
        proposalId: 'minimal', kind: 'navigate', observationId: action.observationId,
        url: action.url, predictedEffect: 'Page navigation' };
      await this.browser.dispatch(proposal, observation);
      return {};
    }
    if (action.kind === 'press') {
      if (!allowedKeys.has(action.key)) throw new Error('KEY_NOT_ALLOWED');
      if (action.target) {
        if (action.target.kind === 'visual_coordinate') throw new Error('PRESS_TARGET_NOT_GROUNDED');
        const proposal: Extract<AgentProposalV1, { kind: 'interact' }> = { version: '1',
          proposalId: 'minimal', kind: 'interact', observationId: action.observationId,
          goalId: 'task', operation: 'press', target: action.target, key: action.key,
          predictedEffect: 'Observe the result of this key press' };
        await this.browser.dispatch(proposal, observation);
      } else {
        await this.browser.assertCurrent(observation);
        const activeLabel = await this.browser.page.evaluate(() => {
          const active = document.activeElement;
          return [active?.getAttribute('aria-label'), active?.getAttribute('title'),
            active?.textContent].filter(Boolean).join(' ').slice(0, 1024);
        });
        if (dangerous.test(activeLabel)) throw new Error('DANGEROUS_ACTION_DENIED');
        await this.browser.page.keyboard.press(action.key);
      }
      return {};
    }
    let target: Extract<AgentProposalV1, { kind: 'interact' }>['target'];
    if (action.target.kind === 'visual_coordinate') {
      if (action.operation !== 'click' && action.operation !== 'hover' || !observation.screenshot ||
          this.browser.page.url() !== observation.url) throw new Error('VISUAL_DISPATCH_DENIED');
      if (action.operation === 'click') {
        const actualLabel = await this.browser.page.evaluate(({ x, y }) => {
          const control = document.elementFromPoint(x, y)?.closest(
            'a,button,input,select,textarea,[role="button"],[role="checkbox"]');
          return [control?.getAttribute('aria-label'), control?.getAttribute('title'),
            control?.textContent].filter(Boolean).join(' ').slice(0, 1024);
        }, { x: action.target.x, y: action.target.y });
        if (dangerous.test(actualLabel)) throw new Error('DANGEROUS_ACTION_DENIED');
      }
      target = { kind: 'visual_coordinate', x: action.target.x, y: action.target.y,
        description: action.target.description, context: action.target.description,
        screenshotRef: observation.screenshot.ref, coordinateFrameId: observation.coordinateFrameId,
        viewport: observation.viewport };
    } else target = action.target;
    if (action.operation === 'hover') {
      await this.browser.hover(target, observation);
      return {};
    }
    if (action.operation === 'set_range') {
      await this.browser.setRange(target, observation, action.value);
      return {};
    }
    const base = { version: '1' as const, proposalId: 'minimal', kind: 'interact' as const,
      observationId: action.observationId, goalId: 'task', target,
      predictedEffect: 'Observe the result of this action' };
    let proposal: Extract<AgentProposalV1, { kind: 'interact' }>;
    if (action.operation === 'fill') proposal = { ...base, operation: 'fill', value: action.value };
    else if (action.operation === 'select_option') {
      if (target.kind === 'visual_coordinate') throw new Error('SELECT_TARGET_NOT_GROUNDED');
      await this.browser.assertCurrent(observation);
      const { fact } = this.browser.resolve(target, observation);
      if (!fact.options || !fact.optionsComplete) throw new Error('SELECT_OPTIONS_UNAVAILABLE');
      const matches = fact.options.filter(item => action.option.kind === 'label'
        ? item.label === action.option.label : item.value === action.option.value);
      if (matches.length !== 1 || matches[0]!.disabled) throw new Error('SELECT_OPTION_NOT_UNIQUE');
      proposal = { ...base, operation: 'select', value: matches[0]!.value };
    } else proposal = { ...base, operation: action.operation };
    if (action.operation === 'click' && action.dialog && action.popup)
      throw new Error('ACTION_EFFECT_CONFLICT');
    if (action.operation === 'click' && action.dialog)
      return { dialog: await this.clickWithDialog(proposal, observation, action.dialog) };
    if (action.operation === 'click' && action.popup) {
      return { popup: await this.clickWithPopup(proposal, observation) };
    }
    await this.browser.dispatch(proposal, observation);
    return {};
  }
}
