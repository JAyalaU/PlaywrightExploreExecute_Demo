import type { Frame, Locator, Page } from '@playwright/test';
import type { DeterministicVerificationAssertionV1, SemanticObservationQueryV1 } from '../domain/index.js';

type Outcome = { status: 'QA_ASSERTION_PASSED' | 'QA_ASSERTION_FAILED' |
  'LOCATOR_BINDING_FAILED' | 'BROWSER_EXECUTION_FAILED' | 'TEST_BUILD_FAILED';
  reason?: string; retryable: false };
class QueryFailure extends Error {
  constructor(readonly reason: string) { super(reason); }
}
const passed = (): Outcome => ({ status: 'QA_ASSERTION_PASSED', retryable: false });
const failed = (): Outcome => ({ status: 'QA_ASSERTION_FAILED', reason: 'VERIFICATION_FALSE', retryable: false });
const MAX_FRAMES = 8;
const MAX_IFRAMES_PER_LEVEL = 80;
const MAX_COUNT = 10_000;

/** Only durable, closed frame anchors from the accepted v7 query are used. */
async function frameFor(page: Page, query: SemanticObservationQueryV1): Promise<Frame> {
  if (page.frames().length > MAX_FRAMES) throw new QueryFailure('FRAME_RESOLUTION_FAILED');
  if (query.frame.kind === 'main') return page.mainFrame();
  let frame = page.mainFrame();
  for (const anchor of query.frame.anchors) {
    const iframes = frame.locator('iframe');
    const count = await iframes.count();
    if (count > MAX_IFRAMES_PER_LEVEL) throw new QueryFailure('FRAME_RESOLUTION_FAILED');
    let found: Frame | undefined;
    for (let index = 0; index < count; index++) {
      if (await iframes.nth(index).getAttribute(anchor.kind === 'title' ? 'title' : 'data-testid') !==
          anchor.value) continue;
      if (found) throw new QueryFailure('FRAME_RESOLUTION_FAILED');
      const handle = await iframes.nth(index).elementHandle();
      try {
        found = await handle?.contentFrame() ?? undefined;
      } finally { await handle?.dispose(); }
    }
    if (!found || found.parentFrame() !== frame) throw new QueryFailure('FRAME_RESOLUTION_FAILED');
    frame = found;
  }
  return frame;
}

/** Matches WP2's exact accessible name, includeHidden, and unique-scope semantics. */
async function queryTarget(page: Page, query: SemanticObservationQueryV1):
  Promise<{ locator: Locator; frame: Frame }> {
  const frame = await frameFor(page, query);
  let parent: Frame | Locator = frame;
  for (const scope of query.within ?? []) {
    const scoped: Locator = scope.kind === 'row'
      ? parent.getByRole('row', { includeHidden: true }).filter({ has: frame.getByRole('cell',
        { name: scope.cellName, exact: true, includeHidden: true }) })
      : parent.getByRole(scope.kind, { name: scope.name, exact: true, includeHidden: true });
    if (await scoped.count() !== 1) throw new QueryFailure('INVALID_SCOPE');
    parent = scoped;
  }
  return { frame, locator: parent.getByRole(query.role,
    { ...(query.name ? { name: query.name, exact: true } : {}), includeHidden: true }) };
}

function compareCount(actual: number, operator: 'equal' | 'greater_than' | 'at_least' | 'at_most',
  expected: number): boolean {
  switch (operator) {
    case 'equal': return actual === expected;
    case 'greater_than': return actual > expected;
    case 'at_least': return actual >= expected;
    case 'at_most': return actual <= expected;
  }
}

async function propertyValue(locator: Locator, property: 'visible' | 'enabled' | 'checked' |
  'expanded' | 'selected' | 'text' | 'value', role: SemanticObservationQueryV1['role']):
  Promise<boolean | string> {
  if (property === 'visible') return locator.isVisible();
  if (property === 'enabled') return locator.isEnabled();
  if (property === 'checked') {
    if (!['checkbox', 'radio', 'switch'].includes(role)) throw new QueryFailure('UNSUPPORTED_PROPERTY');
    return locator.isChecked();
  }
  if (property === 'expanded' || property === 'selected') {
    if (property === 'expanded' && !['button', 'combobox', 'menuitem', 'row'].includes(role) ||
        property === 'selected' && !['option', 'tab', 'row'].includes(role))
      throw new QueryFailure('UNSUPPORTED_PROPERTY');
    const value = await locator.getAttribute(`aria-${property}`);
    if (value !== 'true' && value !== 'false') throw new QueryFailure('UNSUPPORTED_PROPERTY');
    return value === 'true';
  }
  if (property === 'value' && !['textbox', 'combobox'].includes(role))
    throw new QueryFailure('UNSUPPORTED_PROPERTY');
  const value = property === 'text' ? await locator.textContent({ timeout: 3000 }) :
    await locator.inputValue({ timeout: 3000 });
  if (value === null) throw new QueryFailure('UNSUPPORTED_PROPERTY');
  if (value.length > 2048) throw new QueryFailure('RESULT_LIMIT');
  return value;
}

/** Execute one accepted closed predicate. A false, evaluable predicate is a QA step failure. */
export async function executeVerificationAssertionV7(page: Page,
  assertion: DeterministicVerificationAssertionV1): Promise<Outcome> {
  try {
    if (assertion.kind === 'url') {
      const actual = page.url();
      if (actual.length > 2048) throw new QueryFailure('RESULT_LIMIT');
      const expected = assertion.operator === 'equal' ? new URL(assertion.expected).href : undefined;
      const prefix = assertion.operator === 'url_prefix' ? new URL(assertion.expected.slice(0, -1)) : undefined;
      const matched = expected !== undefined ? actual === expected : prefix !== undefined &&
        new URL(actual).origin === prefix.origin && new URL(actual).pathname.startsWith(prefix.pathname);
      if (page.url() !== actual) throw new QueryFailure('QUERY_UNEVALUABLE');
      return matched ? passed() : failed();
    }
    const { locator, frame } = await queryTarget(page, assertion.query);
    const count = await locator.count();
    if (count > MAX_COUNT) throw new QueryFailure('RESULT_LIMIT');
    const stable = async () => {
      const renewed = await queryTarget(page, assertion.query);
      if (renewed.frame !== frame || await renewed.locator.count() !== count)
        throw new QueryFailure('QUERY_UNEVALUABLE');
    };
    if (assertion.kind === 'semantic_count') {
      await stable();
      return compareCount(count, assertion.operator, assertion.expected) ? passed() : failed();
    }
    if (count !== 1) throw new QueryFailure(count === 0 ? 'NO_MATCH' : 'NON_UNIQUE');
    const value = await propertyValue(locator, assertion.property, assertion.query.role);
    await stable();
    if (assertion.kind === 'unique_boolean_property') {
      if (typeof value !== 'boolean') throw new QueryFailure('UNSUPPORTED_PROPERTY');
      return value === assertion.expected ? passed() : failed();
    }
    if (typeof value !== 'string') throw new QueryFailure('UNSUPPORTED_PROPERTY');
    return (assertion.operator === 'equal' ? value === assertion.expected :
      value.includes(assertion.expected)) ? passed() : failed();
  } catch (error) {
    if (error instanceof QueryFailure) return { status: 'LOCATOR_BINDING_FAILED',
      reason: error.reason, retryable: false };
    return { status: 'BROWSER_EXECUTION_FAILED',
      reason: page.isClosed() ? 'PAGE_CLOSED' : 'QUERY_EVALUATION_FAILED', retryable: false };
  }
}
