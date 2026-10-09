import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { ObservationV1Schema, type ActionEvidenceV1, type AgentProposalV1,
  type LearnedProcedureV1, type ObservationV1, type TargetHypothesisV1,
  type TaskEnvelopeV1 } from './contracts.js';
import type { ObservationBroker } from './interfaces.js';
import { ProtectedContextFactory } from '../profile/local-context.js';
import type { NativeEffectiveProfile, NativeProfileRef } from '../profile/native-profile.js';

const controls = 'a,button,input,select,textarea,[role="button"],[role="checkbox"]';
const fillableInputTypes = new Set(['text', 'password', 'number', 'email', 'search', 'tel', 'url']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Element = ObservationV1['dom']['elements'][number];
type Fact = { domIndex: number; role: string; name: string; checked?: boolean; enabled: boolean;
  value?: string; valuePresent?: boolean; inputType?: string;
  range?: NonNullable<Element['range']>;
  options?: NonNullable<Element['options']>; optionsComplete?: boolean;
  bounds?: NonNullable<Element['bounds']>; visual?: NonNullable<Element['visual']> };
type VisualAnchor = Extract<LearnedProcedureV1['steps'][number]['targetStrategies'][number]['target'],
  { kind: 'visual_anchor' }>;
export function observedViewportRegion(bounds: NonNullable<Element['bounds']>,
  viewport: ObservationV1['viewport']): NonNullable<VisualAnchor['viewportRegion']> {
  const x = (bounds.x + bounds.width / 2) / viewport.width;
  const y = (bounds.y + bounds.height / 2) / viewport.height;
  const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const column = x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  return `${row}_${column}` as NonNullable<VisualAnchor['viewportRegion']>;
}
function containsPoint(bounds: NonNullable<Element['bounds']>, x: number, y: number): boolean {
  return x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width &&
    y < bounds.y + bounds.height;
}

/** The only page owner for an adaptive run. References are scoped to each observation. */
export class AdaptiveBrowser implements ObservationBroker {
  readonly sessionId: string;
  readonly pageId = `p${randomUUID().replaceAll('-', '')}`;
  #last?: ObservationV1;
  #lastFacts: Fact[] = [];
  #factsComplete = false;
  #screenshot: { ref: string; dataUrl: string; digest: string } | undefined;
  #allowedOrigins = new Set<string>();
  #navigationEpoch = 0;
  #lastObservationEpoch = -1;
  constructor(readonly page: Page, readonly closeSession: () => Promise<void>,
    sessionId = `s${randomUUID().replaceAll('-', '')}`) {
    this.sessionId = sessionId;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.#navigationEpoch++; });
  }

  allowOrigins(origins: readonly string[]): void {
    this.#allowedOrigins = new Set(origins.map(value => new URL(value).origin));
  }
  async observeInitial(task: TaskEnvelopeV1): Promise<ObservationV1> {
    this.allowOrigins(task.operatorConstraints.allowedOrigins);
    await this.page.goto(task.startUrl);
    return this.observeCurrent();
  }
  async observeCurrent(_afterAction?: ActionEvidenceV1): Promise<ObservationV1> {
    if (this.#lastObservationEpoch >= 0 && this.#navigationEpoch !== this.#lastObservationEpoch)
      await this.page.waitForLoadState('domcontentloaded');
    for (let attempt = 0; attempt < 4; attempt++) {
      const epoch = this.#navigationEpoch;
      try { return await this.readObservation(); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (attempt === 3 || !(this.#navigationEpoch !== epoch ||
          /OBSERVATION_DOCUMENT_CHANGED|Execution context was destroyed|Cannot find context/i.test(message)))
          throw error;
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(75);
      }
    }
    throw new Error('OBSERVATION_UNAVAILABLE');
  }
  private async accessibilitySummary(): Promise<string> {
    const sensitiveValues = () => this.page.locator('input').evaluateAll(nodes => nodes
      .filter(node => {
        const input = node as HTMLInputElement;
        return ['password', 'hidden'].includes(input.type) ||
          /password|one-time-code|cc-/.test(input.autocomplete);
      }).map(node => (node as HTMLInputElement).value).filter(Boolean));
    const before = await sensitiveValues();
    let snapshot = await this.page.locator('body').ariaSnapshot();
    const after = await sensitiveValues();
    for (const value of new Set([...before, ...after])) {
      snapshot = snapshot.replaceAll(value, '[redacted]');
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) snapshot = snapshot.replaceAll(escaped, '[redacted]');
    }
    return snapshot.slice(0, 16_384);
  }
  private async readObservation(): Promise<ObservationV1> {
    this.#screenshot = undefined;
    const epoch = this.#navigationEpoch;
    const url = this.page.url();
    if (!this.#allowedOrigins.has(new URL(url).origin)) throw new Error('NAVIGATION_DENIED');
    const facts = await this.readFacts();
    const snapshot = await this.accessibilitySummary();
    const title = await this.page.title();
    if (this.#navigationEpoch !== epoch || this.page.url() !== url)
      throw new Error('OBSERVATION_DOCUMENT_CHANGED');
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
    const observationId = `o${randomUUID().replaceAll('-', '')}`;
    const revision = hash(JSON.stringify({ epoch, url, facts, snapshot })).slice(0, 32);
    const elements: Element[] = facts.map(fact => ({ ref: `e${fact.domIndex}`, role: fact.role,
      ...(fact.name ? { name: fact.name } : {}),
      ...(fact.checked === undefined ? {} : { checked: fact.checked }),
      enabled: fact.enabled, ...(fact.value === undefined ? {} : { value: fact.value }),
      ...(fact.valuePresent === undefined ? {} : { valuePresent: fact.valuePresent }),
      ...(fact.inputType === undefined ? {} : { inputType: fact.inputType }),
      ...(fact.range === undefined ? {} : { range: fact.range }),
      ...(fact.options === undefined ? {} : { options: fact.options,
        optionsComplete: fact.optionsComplete }),
      ...(fact.bounds ? { bounds: fact.bounds } : {}),
      ...(fact.visual ? { visual: fact.visual } : {}) }));
    const observation = ObservationV1Schema.parse({ version: '1', observationId,
      sessionId: this.sessionId, pageId: this.pageId, documentRevision: revision,
      coordinateFrameId: observationId, url, observedAt: new Date().toISOString(),
      viewport: { ...viewport, scale: 1 },
      accessibility: { snapshotRef: `a${observationId}`, summary: snapshot },
      dom: { factsRef: `d${observationId}`, complete: this.#factsComplete,
        summary: `${title}\n${facts.map((fact, index) =>
        `${index}: ${fact.role} ${JSON.stringify(fact.name)} ${fact.checked === undefined ? '' : `checked=${fact.checked}`} enabled=${fact.enabled}`).join('\n')}`.slice(0, 16_384), elements } });
    this.#last = observation;
    this.#lastFacts = facts;
    this.#lastObservationEpoch = epoch;
    return observation;
  }
  async observeAccessibility(_observationId: string): Promise<ObservationV1> { return this.observeCurrent(); }
  async observeDom(_observationId: string, _focus?: string): Promise<ObservationV1> { return this.observeCurrent(); }
  async captureScreenshot(observationId: string, _focus?: string): Promise<ObservationV1> {
    if (this.#last?.observationId !== observationId) throw new Error('STALE_OBSERVATION');
    try { await this.assertCurrent(this.#last); }
    catch (error) {
      if (this.#navigationEpoch === this.#lastObservationEpoch) throw error;
    }
    // A navigation invalidates the requested refs. Read the new document without re-clicking.
    const observation = await this.observeCurrent();
    const viewport = observation.viewport;
    if (viewport.width * viewport.height > 2_500_000) throw new Error('SCREENSHOT_VIEWPORT_TOO_LARGE');
    const scroll = await this.scrollPosition();
    const bytes = await this.page.screenshot({ type: 'jpeg', quality: 60, fullPage: false,
      animations: 'disabled', caret: 'hide', scale: 'css' });
    if (bytes.length > 1_500_000) throw new Error('SCREENSHOT_TOO_LARGE');
    await this.assertCurrent(observation);
    const afterScroll = await this.scrollPosition();
    if (scroll.x !== afterScroll.x || scroll.y !== afterScroll.y)
      throw new Error('STALE_SCREENSHOT');
    const ref = `i${randomUUID().replaceAll('-', '')}`;
    const screenshot = { ref, sessionId: this.sessionId, pageId: this.pageId,
      viewport, documentRevision: observation.documentRevision,
      coordinateFrameId: observation.coordinateFrameId, observedAt: new Date().toISOString(),
      scrollX: scroll.x, scrollY: scroll.y };
    const result = ObservationV1Schema.parse({ ...observation, screenshot });
    this.#last = result;
    this.#screenshot = { ref, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
      digest: hash(bytes.toString('base64')) };
    return result;
  }
  getScreenshotData(ref: string): string {
    if (!this.#last?.screenshot || this.#last.screenshot.ref !== ref ||
        this.#screenshot?.ref !== ref) throw new Error('SCREENSHOT_NOT_CURRENT');
    return this.#screenshot.dataUrl;
  }
  async assertScreenshotPixels(observation: ObservationV1): Promise<void> {
    if (!observation.screenshot || !this.#screenshot ||
        observation.screenshot.ref !== this.#screenshot.ref)
      throw new Error('SCREENSHOT_NOT_CURRENT');
    const fresh = await this.page.screenshot({ type: 'jpeg', quality: 60, fullPage: false,
      animations: 'disabled', caret: 'hide', scale: 'css' });
    if (hash(fresh.toString('base64')) !== this.#screenshot.digest)
      throw new Error('STALE_SCREENSHOT');
  }
  /** Re-identify a demonstrated visual control in a fresh screenshot without using an old ref. */
  matchesVisualAnchor(anchor: VisualAnchor,
    target: Extract<TargetHypothesisV1, { kind: 'visual_coordinate' | 'element_ref' }>,
    observation: ObservationV1): boolean {
    if (!observation.screenshot || target.kind === 'visual_coordinate' &&
        target.screenshotRef !== observation.screenshot.ref)
      return false;
    if (target.kind === 'element_ref' && (!anchor.observedRole || !anchor.visualKind ||
        !anchor.visualSignature || !anchor.viewportRegion)) return false;
    const matches = observation.dom.elements.filter(item => item.bounds && item.visual &&
      item.enabled !== false &&
      (target.kind === 'element_ref' ? item.ref === target.ref &&
        item.bounds.x + item.bounds.width / 2 >= 0 &&
        item.bounds.y + item.bounds.height / 2 >= 0 &&
        item.bounds.x + item.bounds.width / 2 < observation.viewport.width &&
        item.bounds.y + item.bounds.height / 2 < observation.viewport.height
        : containsPoint(item.bounds, target.x, target.y)) &&
      (!anchor.observedRole || item.role === anchor.observedRole) &&
      (!anchor.visualKind || item.visual.kind === anchor.visualKind) &&
      (!anchor.visualSignature || item.visual.signature === anchor.visualSignature) &&
      (!anchor.viewportRegion ||
        observedViewportRegion(item.bounds, observation.viewport) === anchor.viewportRegion));
    return matches.length === 1;
  }
  async scrollPosition(): Promise<{ x: number; y: number }> {
    return this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  }
  async readFacts(): Promise<Fact[]> {
    const result = await this.page.locator(controls).evaluateAll(nodes => ({ complete: nodes.length <= 100,
      items: nodes.slice(0, 100).map((node, domIndex) => {
      const el = node as HTMLElement;
      const input = node as HTMLInputElement;
      const sensitive = el.tagName === 'INPUT' &&
        (['password', 'hidden'].includes(input.type) ||
          /password|one-time-code|cc-/.test(input.autocomplete));
      const capturesValue = !sensitive && (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ||
        el.tagName === 'INPUT' && !['checkbox', 'radio', 'file'].includes(input.type));
      const numberOr = (raw: string, fallback: number) => {
        const number = Number(raw);
        return raw && Number.isFinite(number) ? number : fallback;
      };
      const positiveOr = (raw: string, fallback: number) => {
        const number = numberOr(raw, fallback);
        return number > 0 ? number : fallback;
      };
      const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' :
        el.tagName === 'INPUT' && input.type === 'checkbox' ? 'checkbox' :
        el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase());
      const labels = 'labels' in input && input.labels ? Array.from(input.labels).map(item => item.textContent || '').join(' ') : '';
      const name = (el.getAttribute('aria-label') || labels || el.textContent?.slice(0, 2_048) ||
        el.getAttribute('placeholder') || el.getAttribute('title') ||
        el.getAttribute('name') || '').trim().slice(0, 1024);
      const rect = el.getBoundingClientRect();
      const svg = el.querySelector('svg');
      const image = el.querySelector('img');
      const canvas = el.querySelector('canvas');
      const container = el.closest('header,nav,aside,main,section,form');
      const context = `${container?.tagName.toLowerCase() ?? 'page'} ${
        (container?.textContent ?? '').slice(0, 512).replace(/\s+/g, ' ').trim().slice(0, 120)}`.trim();
      const visualKind = svg ? 'svg_icon' : image ? 'image' : canvas ? 'canvas' : 'other';
      const visualSource = svg ? [svg.getAttribute('viewBox') ?? '',
        ...Array.from(svg.querySelectorAll('path,circle,rect,polygon,polyline,line,ellipse')).slice(0, 30)
          .map(shape => [shape.tagName.toLowerCase(), ...['d', 'cx', 'cy', 'r', 'points',
            'x', 'y', 'width', 'height', 'x1', 'x2', 'y1', 'y2']
            .map(key => shape.getAttribute(key) ?? '')].join(':'))].join('|').slice(0, 8_192)
        : image ? (image.currentSrc || image.src).slice(0, 4_096) : '';
      return { domIndex, visible: !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
        role, name, ...(input.type === 'checkbox' ? { checked: input.checked } : {}),
        ...(capturesValue ? { value: input.value.slice(0, 1024) } : {}),
        ...(sensitive && el.tagName === 'INPUT' ? { valuePresent: input.value.length > 0 } : {}),
        ...(el.tagName === 'INPUT' ? { inputType: input.type.slice(0, 100) } : {}),
        ...(el.tagName === 'INPUT' && input.type === 'range' ? { range: {
          min: numberOr(input.min, 0), max: numberOr(input.max, 100),
          step: input.step === 'any' ? 'any' as const : positiveOr(input.step, 1),
          value: numberOr(input.value, 0) } } : {}),
        ...(el instanceof HTMLSelectElement ? {
          options: Array.from(el.options).slice(0, 100).map(option => ({
            label: option.label.slice(0, 1024), value: option.value.slice(0, 1024),
            selected: option.selected, disabled: option.disabled })),
          optionsComplete: el.options.length <= 100 } : {}),
        enabled: !('disabled' in input && input.disabled) && el.getAttribute('aria-disabled') !== 'true',
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visualKind, visualSource, context };
    }).filter(item => item.visible && item.bounds.width > 0 && item.bounds.height > 0) }));
    this.#factsComplete = result.complete;
    return result.items.map(({ visible: _visible, visualKind, visualSource, context, ...item }) => ({
      ...item, visual: { kind: visualKind as NonNullable<Element['visual']>['kind'],
        context: context || 'page', ...(visualSource ? { signature: hash(visualSource) } : {}) } }));
  }
  /** A live reread closes the gap between model proposal and browser action. */
  async assertCurrent(observation: ObservationV1): Promise<void> {
    if (this.#lastObservationEpoch !== this.#navigationEpoch)
      throw new Error('STALE_LIVE_PAGE');
    const viewport = this.page.viewportSize();
    const scroll = await this.scrollPosition();
    const epoch = this.#navigationEpoch;
    if (this.#last?.observationId !== observation.observationId || this.page.url() !== observation.url ||
        this.#navigationEpoch !== epoch || this.#lastObservationEpoch !== epoch ||
        !viewport || viewport.width !== observation.viewport.width ||
        viewport.height !== observation.viewport.height ||
        observation.screenshot && (scroll.x !== observation.screenshot.scrollX ||
          scroll.y !== observation.screenshot.scrollY ||
          Date.now() - Date.parse(observation.screenshot.observedAt) > 45_000))
      throw new Error('STALE_LIVE_PAGE');
    const facts = await this.readFacts();
    const snapshot = await this.accessibilitySummary();
    if (this.#navigationEpoch !== epoch || this.page.url() !== observation.url ||
        hash(JSON.stringify({ epoch, url: this.page.url(), facts, snapshot })).slice(0, 32) !==
          observation.documentRevision) throw new Error('STALE_LIVE_PAGE');
  }
  resolve(target: TargetHypothesisV1, observation: ObservationV1): { index: number; fact: Fact } {
    const matches = observation.dom.elements.map((element, index) => ({ element, index })).filter(({ element }) =>
      target.kind === 'element_ref' ? element.ref === target.ref :
      target.kind === 'role_name' ? element.role === target.role && element.name === target.name : false);
    if (matches.length !== 1) throw new Error('TARGET_NOT_GROUNDED');
    const fact = this.#lastFacts[matches[0]!.index]!;
    return { index: fact.domIndex, fact };
  }
  async dispatch(proposal: Extract<AgentProposalV1, { kind: 'interact' | 'navigate' | 'observe' | 'verify' }>,
    observation: ObservationV1): Promise<void> {
    await this.assertCurrent(observation);
    if (proposal.kind === 'navigate') { await this.page.goto(proposal.url); return; }
    if (proposal.kind === 'observe' || proposal.kind === 'verify') return;
    if (proposal.target.kind === 'visual_coordinate') {
      if (proposal.operation !== 'click' || !observation.screenshot ||
          proposal.target.screenshotRef !== observation.screenshot.ref ||
          proposal.target.coordinateFrameId !== observation.coordinateFrameId ||
          proposal.target.viewport.width !== observation.viewport.width ||
          proposal.target.viewport.height !== observation.viewport.height ||
          proposal.target.x < 0 || proposal.target.y < 0 ||
          proposal.target.x >= observation.viewport.width ||
          proposal.target.y >= observation.viewport.height ||
          !this.#screenshot || this.#screenshot.ref !== observation.screenshot.ref)
        throw new Error('VISUAL_DISPATCH_DENIED');
      const hit = await this.page.evaluate(({ x, y, selector }) => {
        const hit = document.elementFromPoint(x, y);
        const control = hit?.closest(selector);
        return { index: control ? Array.from(document.querySelectorAll(selector)).indexOf(control) : -1,
          disabled: control instanceof HTMLButtonElement || control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement
            ? control.disabled : control?.getAttribute('aria-disabled') === 'true' };
      }, { x: proposal.target.x, y: proposal.target.y, selector: controls });
      if (hit.index < 0 || hit.disabled) throw new Error('VISUAL_TARGET_NOT_ACTIONABLE');
      const known = this.#lastFacts.find(item => item.domIndex === hit.index);
      if (known && known.name && known.enabled) {
        const locator = this.page.locator(controls).nth(hit.index);
        if (await locator.isVisible()) { await locator.click(); return; }
      }
      await this.assertScreenshotPixels(observation);
      await this.page.mouse.click(proposal.target.x, proposal.target.y);
      // Mouse delivery can resolve while a click-triggered navigation is still starting.
      await this.page.waitForLoadState('domcontentloaded');
      return;
    }
    const { index, fact } = this.resolve(proposal.target, observation);
    if (!fact.enabled) throw new Error('TARGET_DISABLED');
    const editable = fact.role === 'textarea' || !!fact.inputType &&
      fillableInputTypes.has(fact.inputType);
    const unnamedNativeAction = proposal.target.kind === 'element_ref' && !fact.name &&
      (fact.role === 'checkbox' && (proposal.operation === 'check' || proposal.operation === 'uncheck') ||
        editable && (proposal.operation === 'fill' || proposal.operation === 'press') ||
        !!fact.options && (proposal.operation === 'select' || proposal.operation === 'press'));
    if (proposal.target.kind === 'element_ref' && !fact.name && !unnamedNativeAction) {
      const box = fact.bounds;
      const candidates = this.#lastFacts.filter(item => !item.name && item.enabled && item.visual &&
        ['button', 'link', 'checkbox', 'radio', 'switch'].includes(item.role) && item.bounds &&
        item.bounds.x + item.bounds.width / 2 >= 0 &&
        item.bounds.x + item.bounds.width / 2 < observation.viewport.width &&
        item.bounds.y + item.bounds.height / 2 >= 0 &&
        item.bounds.y + item.bounds.height / 2 < observation.viewport.height);
      if (proposal.operation !== 'click' || !observation.screenshot || !box ||
          candidates.length !== 1 || candidates[0]?.domIndex !== index)
        throw new Error('VISUAL_REF_NOT_GROUNDED');
      await this.assertScreenshotPixels(observation);
    } else if (proposal.target.kind === 'element_ref' && observation.screenshot &&
        !unnamedNativeAction) {
      await this.assertScreenshotPixels(observation);
    }
    const locator = this.page.locator(controls).nth(index);
    if (!await locator.isVisible()) throw new Error('TARGET_NOT_VISIBLE');
    switch (proposal.operation) {
      case 'click': await locator.click(); break;
      case 'check': await locator.check(); break;
      case 'uncheck': await locator.uncheck(); break;
      case 'fill':
        if (!editable) throw new Error('FILL_TARGET_UNSUPPORTED');
        await locator.fill(proposal.value); break;
      case 'select':
        if (!fact.options || !fact.optionsComplete ||
            fact.options.filter(option => option.value === proposal.value && !option.disabled).length !== 1)
          throw new Error('SELECT_TARGET_UNSUPPORTED');
        await locator.selectOption({ value: proposal.value }); break;
      case 'press':
        if (!['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp',
          'ArrowLeft', 'ArrowRight', 'Space'].includes(proposal.key))
          throw new Error('KEY_NOT_ALLOWED');
        await locator.press(proposal.key); break;
      default: throw new Error('UNSUPPORTED_DISPATCH_OPERATION');
    }
  }
  async hover(target: TargetHypothesisV1, observation: ObservationV1): Promise<void> {
    await this.assertCurrent(observation);
    if (target.kind === 'visual_coordinate') {
      if (!observation.screenshot || target.screenshotRef !== observation.screenshot.ref ||
          target.coordinateFrameId !== observation.coordinateFrameId ||
          target.viewport.width !== observation.viewport.width ||
          target.viewport.height !== observation.viewport.height ||
          target.x < 0 || target.y < 0 || target.x >= observation.viewport.width ||
          target.y >= observation.viewport.height)
        throw new Error('VISUAL_DISPATCH_DENIED');
      await this.assertScreenshotPixels(observation);
      await this.page.mouse.move(target.x, target.y);
      return;
    }
    const { index, fact } = this.resolve(target, observation);
    if (!fact.enabled) throw new Error('TARGET_DISABLED');
    const locator = this.page.locator(controls).nth(index);
    if (!await locator.isVisible()) throw new Error('TARGET_NOT_VISIBLE');
    await locator.hover();
  }
  async setRange(target: TargetHypothesisV1, observation: ObservationV1,
    value: number): Promise<void> {
    await this.assertCurrent(observation);
    if (target.kind === 'visual_coordinate') throw new Error('RANGE_TARGET_NOT_GROUNDED');
    const { index, fact } = this.resolve(target, observation);
    if (!fact.enabled || fact.inputType !== 'range' || !fact.range)
      throw new Error('RANGE_TARGET_UNSUPPORTED');
    const { min, max, step } = fact.range;
    if (step === 'any' || step <= 0 || max < min || value < min || value > max)
      throw new Error('RANGE_VALUE_UNREACHABLE');
    const steps = (value - min) / step;
    if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-6 ||
        steps > 100) throw new Error('RANGE_VALUE_UNREACHABLE');
    const locator = this.page.locator(controls).nth(index);
    if (!await locator.isVisible()) throw new Error('TARGET_NOT_VISIBLE');
    await locator.press('Home');
    for (let index = 0; index < Math.round(steps); index++) await locator.press('ArrowRight');
    if (Math.abs(Number(await locator.inputValue()) - value) > 1e-6)
      throw new Error('RANGE_VALUE_NOT_REACHED');
  }
  async close(): Promise<void> { await this.closeSession(); }
}

/** Native schema-5 Chromium owner. Local application admission remains a trusted caller decision. */
export async function openProtectedAdaptiveBrowser(factory: ProtectedContextFactory,
  profileRef: NativeProfileRef, expected: NativeEffectiveProfile): Promise<AdaptiveBrowser> {
  const session = await factory.open(profileRef, expected);
  try { return new AdaptiveBrowser(await session.context.newPage(), () => session.close()); }
  catch (error) { await session.close(); throw error; }
}
