import { randomUUID } from 'node:crypto';
import type { AdaptiveBrowser } from '../adaptive/browser.js';
import { ChoiceSchema, VerdictSchema, type Attempt, type MinimalModel, type MinimalResult,
  type MinimalTask, type Receipt, type ResetProof, type BrowserAction } from './types.js';
import { MinimalBrowserTools } from './browser-tools.js';

export interface MinimalRunOptions {
  task: MinimalTask;
  model: MinimalModel;
  openBrowser: () => Promise<AdaptiveBrowser>;
  /** Trusted caller-owned reset; never callable by the model. */
  reset: (task: MinimalTask) => Promise<ResetProof>;
  /** Optional private benchmark artifact handoff; diagnostic failure never changes QA. */
  onCleanFinalScreenshot?: (image: { observationId: string; dataUrl: string }) => Promise<void>;
}

function workflowFrom(attempt: Attempt): string {
  const steps = attempt.receipts.filter(item => item.delivery === 'returned' && item.observedChange)
    .slice(0, 12).map((item, index) =>
      `${index + 1}. ${item.action.kind === 'navigate' ? 'navigate' :
        item.action.kind === 'press' ? 'press' :
          item.action.kind === 'select_page' ? 'select_page' : item.action.operation} ` +
      `${item.action.kind === 'select_page' ? 'newly opened page' : item.targetDescription}${item.dialog ?
        `; dialog ${item.dialog.kind} ${item.dialog.response}` : ''}; observed ${item.observedChange}`);
  return steps.length ? steps.join('\n') : 'No interaction with an observed effect was demonstrated.';
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'Unknown tool error';
}
function actionErrorText(error: unknown, action: BrowserAction): string {
  const message = error instanceof Error ? error.message : 'Unknown tool error';
  const value = action.kind === 'act' && action.operation === 'fill' ? action.value :
    action.kind === 'act' && action.operation === 'click' && action.dialog?.kind === 'prompt'
      ? action.dialog.text : undefined;
  if (!value)
    return message.slice(0, 300);
  const escaped = JSON.stringify(value).slice(1, -1);
  return message.replaceAll(value, '[redacted]')
    .replaceAll(escaped, '[redacted]').slice(0, 300);
}
function observationChange(before: Attempt['observations'][number], after: Attempt['observations'][number]): string | undefined {
  if (before.pageId !== after.pageId) return `Selected page ${after.url}`;
  if (before.url !== after.url) return `URL ${before.url} -> ${after.url}`;
  if (before.documentRevision !== after.documentRevision) return 'Page controls or accessibility changed';
  return undefined;
}

async function runAttempt(options: MinimalRunOptions, phase: 'discovery' | 'clean',
  workflow: string | undefined, deadline: number): Promise<{ attempt: Attempt;
    screenshots: { observationId: string; dataUrl: string }[] }> {
  let browser: AdaptiveBrowser | undefined;
  const screenshotsForEvaluation: { observationId: string; dataUrl: string }[] = [];
  const attempt: Attempt = { resetProof: { freshBrowserContext: false, applicationStateVerified: false },
    observations: [], receipts: [], stopReason: 'error' };
  try {
    browser = await options.openBrowser();
    attempt.resetProof = await options.reset(options.task);
    const freshNavigation = attempt.resetProof.kind === 'fresh_navigation';
    if (freshNavigation) attempt.resetProof = { ...attempt.resetProof, applicationStateVerified: false };
    if (!attempt.resetProof.freshBrowserContext ||
        !freshNavigation && !attempt.resetProof.applicationStateVerified ||
        attempt.resetProof.resetRef !== options.task.resetRef) throw new Error('RESET_NOT_VERIFIED');
    const tools = new MinimalBrowserTools(browser, options.task);
    let observation = await tools.start();
    if (freshNavigation) {
      if (observation.url !== options.task.startUrl) throw new Error('INITIAL_NAVIGATION_NOT_VERIFIED');
      attempt.resetProof = { ...attempt.resetProof, initialNavigationVerified: true };
    }
    attempt.observations.push(observation);
    let screenshots = 0, unchanged = 0;
    for (let turn = 0; turn < options.task.maxModelTurns; turn++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || attempt.receipts.length >= options.task.maxActions) {
        attempt.stopReason = 'budget'; break;
      }
      const signal = AbortSignal.timeout(remainingMs);
      const screenshotDataUrl = tools.image(observation);
      const choice = ChoiceSchema.parse(await options.model.choose({
        instruction: options.task.instruction, phase, ...(workflow ? { workflow } : {}),
        observation, pages: tools.pages(), ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
        recentReceipts: attempt.receipts.slice(-6),
        remaining: { modelTurns: options.task.maxModelTurns - turn,
          actions: options.task.maxActions - attempt.receipts.length,
          screenshots: options.task.maxScreenshots - screenshots, elapsedMs: remainingMs }, signal }));
      if (choice.kind === 'done' || choice.kind === 'stuck') {
        attempt.stopReason = choice.kind;
        attempt.stopDetail = choice.reason;
        break;
      }
      if (choice.kind === 'observe') {
        if (choice.modality === 'screenshot') {
          if (screenshots >= options.task.maxScreenshots) {
            attempt.stopReason = 'budget'; attempt.stopDetail = 'Screenshot budget exhausted'; break;
          }
          observation = await tools.screenshot(observation);
          screenshots++;
          if (phase === 'clean') screenshotsForEvaluation.push({ observationId: observation.observationId,
            dataUrl: tools.image(observation)! });
        } else observation = await tools.observe();
        attempt.observations.push(observation);
        continue;
      }
      const before = observation;
      const receipt: Receipt = { id: `r${randomUUID().replaceAll('-', '')}`,
        action: choice.kind === 'act' && choice.operation === 'fill'
          ? { kind: 'act', operation: 'fill', observationId: choice.observationId,
            target: choice.target, valueRedacted: true } :
          choice.kind === 'act' && choice.operation === 'click' && choice.dialog?.kind === 'prompt'
            ? { ...choice, dialog: { kind: 'prompt', response: choice.dialog.response } } : choice,
        targetDescription: tools.describe(choice, before), beforeId: before.observationId,
        delivery: 'failed' };
      const navigationMarker = tools.navigationMarker();
      try {
        const result = await tools.execute(choice, before);
        if (result.dialog) receipt.dialog = result.dialog;
        if (result.popup) receipt.popup = result.popup;
        receipt.delivery = 'returned';
      } catch (error) { receipt.error = actionErrorText(error, choice); }
      try {
        observation = await tools.observe();
        attempt.observations.push(observation);
        receipt.afterId = observation.observationId;
        const change = observationChange(before, observation);
        if (change || receipt.popup) receipt.observedChange = change ??
          `Opened page ${receipt.popup!.url}`;
      } catch (error) {
        receipt.error = [receipt.error, `Observation: ${actionErrorText(error, choice)}`]
          .filter(Boolean).join('; ');
        try { receipt.diagnostic = await tools.failureDiagnostic(navigationMarker, error); }
        catch { /* The observation failure remains the authoritative stop. */ }
        attempt.receipts.push(receipt);
        throw new Error(actionErrorText(error, choice));
      }
      attempt.receipts.push(receipt);
      unchanged = receipt.delivery === 'returned' && receipt.observedChange ? 0 : unchanged + 1;
      if (unchanged >= 3) {
        attempt.stopReason = 'no_progress';
        attempt.stopDetail = 'Three actions without an observed effect'; break;
      }
      if (turn === options.task.maxModelTurns - 1) attempt.stopReason = 'budget';
    }
    // Give the independent evaluator one current visual witness even if the executor
    // completed from DOM evidence alone. This is a read-only, budgeted observation.
    if (phase === 'clean' && attempt.observations.length &&
        screenshots < options.task.maxScreenshots && Date.now() < deadline) {
      try {
        observation = await tools.screenshot(observation);
        attempt.observations.push(observation);
        screenshotsForEvaluation.push({ observationId: observation.observationId,
          dataUrl: tools.image(observation)! });
      } catch { /* Optional final visual evidence must not erase a completed attempt. */ }
    }
    if (attempt.stopReason === 'error' && !attempt.stopDetail) attempt.stopReason = 'budget';
  } catch (error) {
    attempt.stopReason = 'error'; attempt.stopDetail = errorText(error);
  } finally {
    try { await browser?.close(); }
    catch (error) { attempt.stopReason = 'error'; attempt.stopDetail = `Cleanup: ${errorText(error)}`; }
  }
  return { attempt, screenshots: screenshotsForEvaluation };
}

/** Independent evaluation sees only clean browser evidence, never the executing model's done reason. */
export async function runMinimalAdaptiveAgent(options: MinimalRunOptions): Promise<MinimalResult> {
  const task = options.task;
  if (!task.instruction.trim() || !['http:', 'https:'].includes(new URL(task.startUrl).protocol) ||
      !task.allowedOrigins.some(origin => new URL(origin).origin === new URL(task.startUrl).origin) ||
      !task.resetRef || !Number.isInteger(task.maxModelTurns) || task.maxModelTurns < 1 ||
      !Number.isInteger(task.maxActions) || task.maxActions < 1 ||
      !Number.isInteger(task.maxScreenshots) || task.maxScreenshots < 0 || task.maxElapsedMs < 1)
    throw new Error('MINIMAL_TASK_INVALID');
  const deadline = Date.now() + task.maxElapsedMs;
  const discovery = (await runAttempt(options, 'discovery', undefined, deadline)).attempt;
  const workflow = workflowFrom(discovery);
  if (discovery.stopReason === 'error' || Date.now() >= deadline)
    return { outcome: 'INCONCLUSIVE', explanation: discovery.stopDetail ?? 'Discovery could not continue',
      evidenceIds: [], workflow, discovery };
  const cleanRun = await runAttempt(options, 'clean', workflow, deadline);
  const clean = cleanRun.attempt;
  const finalObservation = clean.observations.at(-1);
  const finalImage = cleanRun.screenshots.find(item =>
    item.observationId === finalObservation?.observationId);
  if (finalImage && options.onCleanFinalScreenshot) {
    try { await options.onCleanFinalScreenshot(finalImage); }
    catch { /* Diagnostic artifact failure does not change execution or evaluation. */ }
  }
  if (discovery.observations[0]?.sessionId === clean.observations[0]?.sessionId)
    return { outcome: 'INCONCLUSIVE', explanation: 'Clean browser session was not fresh',
      evidenceIds: [], workflow, discovery, clean };
  if (!finalObservation || clean.stopReason === 'error' || Date.now() >= deadline)
    return { outcome: 'INCONCLUSIVE', explanation: clean.stopDetail ?? 'Clean attempt could not continue',
      evidenceIds: [], workflow, discovery, clean };
  try {
    const verdict = VerdictSchema.parse(await options.model.evaluate({ instruction: task.instruction,
      observations: clean.observations, receipts: clean.receipts, finalObservation,
      screenshots: cleanRun.screenshots,
      signal: AbortSignal.timeout(deadline - Date.now()) }));
    const valid = new Set([...clean.observations.map(item => item.observationId),
      ...clean.receipts.map(item => item.id)]);
    if (verdict.evidenceIds.some(id => !valid.has(id)) ||
        !verdict.evidenceIds.includes(finalObservation.observationId))
      throw new Error('EVALUATOR_EVIDENCE_INVALID');
    if (verdict.outcome === 'PASS' && clean.receipts.length > 0 &&
        !clean.receipts.some(item => item.delivery === 'returned' && item.observedChange &&
          verdict.evidenceIds.includes(item.id))) throw new Error('PASS_ACTION_EVIDENCE_MISSING');
    return { ...verdict, workflow, discovery, clean };
  } catch (error) {
    return { outcome: 'INCONCLUSIVE', explanation: `Evaluation unavailable: ${errorText(error)}`,
      evidenceIds: [], workflow, discovery, clean };
  }
}
