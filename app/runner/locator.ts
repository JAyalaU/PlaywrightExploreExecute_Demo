import type { FrameLocator, Locator, Page } from '@playwright/test';
import type { LocatorForm, OrdinaryLocator, PageLocator } from '../domain/index.js';

type LocatorRoot = Page | Locator | FrameLocator;

function ordinary(root: LocatorRoot, form: OrdinaryLocator): Locator {
  switch (form.type) {
    case 'role': return root.getByRole(form.role as Parameters<Page['getByRole']>[0], { name: form.name, ...(form.exact ? { exact: true } : {}) });
    case 'label': return root.getByLabel(form.value, form.exact ? { exact: true } : {});
    case 'placeholder': return root.getByPlaceholder(form.value, form.exact ? { exact: true } : {});
    case 'text': return root.getByText(form.value, form.exact ? { exact: true } : {});
    case 'testId': return root.getByTestId(form.value);
  }
}

function pageLocator(root: LocatorRoot, form: PageLocator): Locator {
  if (form.type === 'within') return pageLocator(pageLocator(root, form.scope), form.target);
  return ordinary(root, form);
}

/** Build Playwright locators only from the M1 closed locator form. */
export function bindLocator(page: Page, form: LocatorForm): Locator {
  if (form.type !== 'frame') return pageLocator(page, form);
  const frame = page.locator('iframe').and(form.frame.type === 'title'
    ? page.getByTitle(form.frame.value, { exact: true })
    : page.getByTestId(form.frame.value));
  return pageLocator(frame.contentFrame(), form.target);
}

export function frameIdentity(page: Page, form: LocatorForm): Locator | undefined {
  if (form.type !== 'frame') return undefined;
  return page.locator('iframe').and(form.frame.type === 'title'
    ? page.getByTitle(form.frame.value, { exact: true })
    : page.getByTestId(form.frame.value));
}
