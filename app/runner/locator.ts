import type { FrameLocator, Locator, Page } from '@playwright/test';
import type { CompiledLocatorV1, LocatorForm, OrdinaryLocator, PageLocator } from '../domain/index.js';

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
  if (form.type === 'rowWithCell') {
    return root.getByRole('row').filter({ has: root.getByRole('cell', { name: form.cellName, exact: true }) });
  }
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

/** V6 frame ancestry is verified in order; runtime frame IDs are never inputs. */
export function bindCompiledLocator(page: Page, compiled: CompiledLocatorV1): {
  locator: Locator; anchors: readonly Locator[]; scopes: readonly Locator[];
} {
  const scoped = (root: LocatorRoot, form: PageLocator): { locator: Locator; scopes: Locator[] } => {
    if (form.type !== 'within') return { locator: pageLocator(root, form), scopes: [] };
    const scope = pageLocator(root, form.scope);
    const nested = scoped(scope, form.target);
    return { locator: nested.locator, scopes: [scope, ...nested.scopes] };
  };
  if (!compiled.framePath) {
    const frame = frameIdentity(page, compiled.validatedForm);
    if (compiled.validatedForm.type === 'frame')
      return { locator: bindLocator(page, compiled.validatedForm), anchors: frame ? [frame] : [], scopes: [] };
    const target = scoped(page, compiled.validatedForm);
    return { ...target, anchors: frame ? [frame] : [] };
  }
  if (compiled.validatedForm.type === 'frame') throw new Error('Nested compiled frame form is unsupported');
  let root: Page | FrameLocator = page;
  const anchors: Locator[] = [];
  for (const identity of compiled.framePath) {
    const anchor = root.locator('iframe').and(identity.kind === 'title'
      ? root.getByTitle(identity.value, { exact: true })
      : root.getByTestId(identity.value));
    anchors.push(anchor);
    root = anchor.contentFrame();
  }
  return { ...scoped(root, compiled.validatedForm), anchors };
}
