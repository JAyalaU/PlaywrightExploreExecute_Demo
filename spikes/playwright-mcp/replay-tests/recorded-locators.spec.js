const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'replays');
const manifest = require(path.join(ROOT, 'replay-manifest.json'));

function recordedLocator(page, scenario) {
  // This dispatcher reproduces the exact recorded MCP locator expression. It
  // intentionally does not select a preferred alternative or add refinements.
  switch (scenario.id) {
    case 1: return page.getByRole('button', { name: 'Save' });
    case 2: return page.getByRole('link', { name: 'Settings' });
    case 3: return page.getByRole('menuitem', { name: 'Admin' });
    case 4: return page.getByLabel('Role', { exact: true });
    case 5: return page.getByRole('dialog', { name: 'Edit profile dialog' }).getByRole('button', { name: 'Save' });
    case 6: return page.getByRole('button', { name: 'Continue' });
    case 7: return page.getByRole('button', { name: 'Search' });
    case 8: return page.getByText('☰');
    case 9: return page.getByRole('row', { name: 'Billing row' }).getByRole('button', { name: 'Edit' });
    case 10: return page.locator('iframe[title="payment frame"]').contentFrame().getByRole('button', { name: 'Submit' });
    case 11: return page.getByRole('option', { name: 'High' });
    case 12: return page.getByRole('button', { name: 'Apply' });
    default: throw new Error(`No recorded locator for scenario ${scenario.id}`);
  }
}

async function prepare(page, scenario) {
  if (scenario.prerequisite === 'openTopRightMenu') {
    await page.getByRole('button', { name: 'Account menu' }).click();
  } else if (scenario.prerequisite === 'openEditProfile') {
    await page.getByRole('button', { name: 'Edit profile' }).click();
  } else if (scenario.prerequisite === 'waitForContinue') {
    await page.getByRole('button', { name: 'Load next step' }).click();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  } else if (scenario.prerequisite === 'openPriority') {
    await page.getByRole('button', { name: 'Priority Low' }).click();
  }
}

async function state(page, scenario, locator) {
  const expected = scenario.expected;
  const result = {};
  if (expected.urlPath !== undefined) result.urlPath = new URL(page.url()).pathname;
  if (expected.value !== undefined) {
    const control = scenario.id === 4
      ? page.getByLabel('Role', { exact: true })
      : page.getByRole('button', { name: 'Priority High' });
    result.value = scenario.id === 4 ? await control.inputValue() : await control.textContent();
  }
  if (expected.saveState !== undefined) result.saveState = await page.getByText(expected.saveState, { exact: true }).textContent();
  if (expected.editState !== undefined) result.editState = await page.getByText(expected.editState, { exact: true }).textContent();
  if (expected.dialogOpen !== undefined) result.dialogOpen = await page.getByRole('dialog', { name: 'Edit profile dialog' }).isVisible();
  if (expected.frameResult !== undefined) {
    const frameText = await locator.evaluate(element => element.ownerDocument.body.innerText);
    result.frameResult = frameText.includes(expected.frameResult) ? expected.frameResult : frameText;
  }
  if (expected.shadowResult !== undefined) result.shadowResult = await page.getByText(expected.shadowResult, { exact: true }).textContent();
  return result;
}

async function targetIdentity(locator) {
  // Post-exploration oracle evidence only: this reads the resolved element's
  // existing id without using it to construct or refine any locator.
  return locator.evaluate(element => ({
    id: element.id || null,
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || null,
    accessibleName: element.getAttribute('aria-label') || element.textContent.trim() || null
  }));
}

function writeEvidence(scenario, run, data) {
  const dir = path.join(ARTIFACTS, `scenario-${String(scenario.id).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `run-${run}.json`), JSON.stringify(data, null, 2) + '\n');
}

for (const scenario of manifest.scenarios) {
  for (const run of [1, 2]) {
    test(`scenario ${scenario.id} recorded locator fresh context run ${run}`, async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const evidence = { scenario: scenario.id, run, locator: scenario.locator, route: scenario.route, status: 'FAIL' };
      try {
        await page.goto(`${manifest.baseURL}${scenario.route}`);
        await prepare(page, scenario);
        const locator = recordedLocator(page, scenario);
        evidence.matchCount = await locator.count();
        evidence.observedTarget = await targetIdentity(locator);
        if (scenario.operation === 'click') await locator.click();
        if (scenario.operation === 'selectOption') await locator.selectOption(scenario.value);
        if (scenario.operation === 'assertVisible') await expect(locator).toBeVisible();
        evidence.resultingState = await state(page, scenario, locator);
        evidence.actionOk = true;
        evidence.status = 'PASS';
        expect(evidence.matchCount).toBe(1);
        for (const [key, value] of Object.entries(scenario.expected)) expect(evidence.resultingState[key]).toBe(value);
      } catch (error) {
        evidence.failure = String(error && error.stack || error);
        await page.screenshot({ path: path.join(ARTIFACTS, `scenario-${String(scenario.id).padStart(2, '0')}`, `run-${run}-failure.png`), fullPage: true }).catch(() => {});
        throw error;
      } finally {
        writeEvidence(scenario, run, evidence);
        await context.close();
      }
    });
  }
}
