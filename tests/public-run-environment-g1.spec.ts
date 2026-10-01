import { expect, test } from '@playwright/test';
import { restrictedBrowserEnvironment } from '../app/profile/browser-environment.js';

test('G1 public browser environment excludes provider and unrelated host variables', () => {
  const environment = restrictedBrowserEnvironment({
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    OPENAI_API_KEY: 'non-secret-g1-sentinel',
    OpenAi_Api_Key: 'another-non-secret-g1-sentinel',
    PRIVATE_HOST_VALUE: 'host-only',
  });
  expect(environment).toEqual({
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
  });
  expect(JSON.stringify(environment)).not.toContain('non-secret-g1-sentinel');
  expect(JSON.stringify(environment)).not.toContain('host-only');
});
