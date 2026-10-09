import { expect, test } from '@playwright/test';
import { MAX_DEMO_ACTION_PAUSE_MS, parseDemoActionPauseMs,
  pauseAfterSuccessfulAction } from '../app/runner/demo-action-pacing.js';

test('trusted pause setting is closed and bounded', () => {
  expect(parseDemoActionPauseMs(undefined)).toBe(0);
  expect(parseDemoActionPauseMs('0')).toBe(0);
  expect(parseDemoActionPauseMs('750')).toBe(750);
  expect(parseDemoActionPauseMs(String(MAX_DEMO_ACTION_PAUSE_MS))).toBe(MAX_DEMO_ACTION_PAUSE_MS);
  for (const raw of ['', '-1', '+1', ' 1', '1 ', '0.5', '01', '1e3', 'NaN',
    String(MAX_DEMO_ACTION_PAUSE_MS + 1), '999999999999999999999'])
    expect(() => parseDemoActionPauseMs(raw)).toThrow('Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS');
});

test('absent and zero pacing do not schedule a timer; positive pacing uses a controlled clock', async () => {
  let now = 100, waits = 0;
  const clock = { now: () => now, wait: async (ms: number) => { waits++; now += ms; } };
  expect(await pauseAfterSuccessfulAction(parseDemoActionPauseMs(undefined), clock)).toBe(0);
  expect(await pauseAfterSuccessfulAction(parseDemoActionPauseMs('0'), clock)).toBe(0);
  expect(waits).toBe(0);
  expect(await pauseAfterSuccessfulAction(parseDemoActionPauseMs('750'), clock)).toBe(750);
  expect(waits).toBe(1);
});
