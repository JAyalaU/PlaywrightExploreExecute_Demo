import { expect, test } from '@playwright/test';
import { editRefInIuvaretRow } from '../app/subprocess/test-harness-support.js';

test('test harness resolves the exact edit link only inside the unique Iuvaret1 row', () => {
  const snapshot = [
    '- table:',
    '  - rowgroup:',
    '    - row "header":',
    '      - columnheader "Number"',
    '      - columnheader "Action"',
    '    - row:',
    '      - cell "Iuvaret10"',
    '      - cell:',
    '        - link "edit" [ref=e20]',
    '    - row:',
    '      - cell "Iuvaret1"',
    '      - cell:',
    '        - link "edit" [ref=e21]',
    '        - link "delete" [ref=e22]',
    '    - row:',
    '      - cell "Iuvaret2"',
    '      - cell:',
    '        - link "edit" [ref=e23]',
  ].join('\n');

  expect(editRefInIuvaretRow(snapshot)).toBe('e21');
});

test('test harness fails closed when the scoped row or its unique edit ref is missing or ambiguous', () => {
  expect(editRefInIuvaretRow('- table:\n  - row:\n    - cell "Iuvaret10"\n    - link "edit" [ref=e1]')).toBeUndefined();
  expect(editRefInIuvaretRow('- table:\n  - row:\n    - cell "Iuvaret1"')).toBeUndefined();
  expect(editRefInIuvaretRow([
    '- table:', '  - row:', '    - cell "Iuvaret1"',
    '    - link "edit" [ref=e1]', '    - link "edit" [ref=e2]',
  ].join('\n'))).toBeUndefined();
  expect(editRefInIuvaretRow([
    '- table:', '  - row:', '    - cell "Iuvaret1"', '    - link "edit" [ref=e1]',
    '  - row:', '    - cell "Iuvaret1"', '    - link "edit" [ref=e2]',
  ].join('\n'))).toBeUndefined();
});
