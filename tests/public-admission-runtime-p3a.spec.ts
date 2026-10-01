import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { approvePublicInspection, inspectPublicUrl, ProfileCatalog,
  ProtectedContextFactory, ProtectedProxy, publicTargetGate } from '../app/profile/index.js';
import { IsolatedBrowser } from '../app/profile/isolated-browser.js';

test.skip(process.env.PUBLIC_BROWSER_P3A_RUNTIME !== '1', 'Opt-in Docker/public-network proof');
const run = promisify(execFile);
const targets = [
  'https://the-internet.herokuapp.com/challenging_dom',
  'https://www.columbia.edu/~fdc/sample.html',
];

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 15_000, windowsHide: true });
  return stdout.trim();
}

async function residualContainers(): Promise<string> {
  return docker(['ps', '-a', '--filter', 'name=public-browser-g1-', '--format', '{{.ID}}']);
}

test('P3-A admitted public profiles retain isolated, pinned, proxy-only sessions and dispose', async () => {
  for (const target of targets) {
    const inspection = await inspectPublicUrl(target);
    const bundle = await approvePublicInspection(inspection, inspection.canonicalUrl);
    const catalog = new ProfileCatalog([bundle.profile], [bundle.policy]);
    const factory = new ProtectedContextFactory(catalog, undefined, publicTargetGate(bundle.approval));
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'P3_A_NON_SECRET_SENTINEL';
    try {
      const session = await factory.open(bundle.approval.executionProfileRef);
      try {
        expect(session.effectiveProfile.fingerprint).toBe(bundle.approval.profileFingerprint);
        const container = session.isolationContainerId;
        expect(container).toBeTruthy();
        const environment = await docker(['exec', container!, 'env']);
        expect(environment).not.toContain('P3_A_NON_SECRET_SENTINEL');
        const page = await session.context.newPage();
        const response = await page.goto(target, { waitUntil: 'commit', timeout: 30_000 });
        expect(response?.status()).toBeGreaterThanOrEqual(200);
        await expect(page.goto('https://unapproved.example.net/', { timeout: 5000 }))
          .rejects.toThrow();
      } finally { await session.close(); }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    expect(await residualContainers()).toBe('');
  }
});

test('P3-A refused proxy cannot start an isolated browser and leaves no container', async () => {
  const inspection = await inspectPublicUrl(targets[0]!);
  const bundle = await approvePublicInspection(inspection, inspection.canonicalUrl);
  const proxy = await ProtectedProxy.start(bundle.policy);
  await proxy.close();
  await expect(IsolatedBrowser.open(proxy)).rejects.toThrow('Proxy is closed');
  expect(await residualContainers()).toBe('');
});
