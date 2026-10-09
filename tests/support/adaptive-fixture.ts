import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StateResetProvider } from '../../app/adaptive/interfaces.js';
import type { TaskEnvelopeV1 } from '../../app/adaptive/contracts.js';

export interface AdaptiveFixture { baseUrl: string; variant: 'a' | 'b' | 'c';
  reset: StateResetProvider; state: () => Promise<boolean>; close: () => Promise<void>;
  setDrift: (value: boolean) => void; setFailReset: (value: boolean) => void;
  setClearOnReload: (value: boolean) => void; setDestinationDrift: (value: boolean) => void }

export async function startAdaptiveFixture(variant: 'a' | 'b' | 'c', browserCount: () => number): Promise<AdaptiveFixture> {
  let enabled = false, generation = 0;
  let drift = false, failReset = false, clearOnReload = false, servedEnabled = false;
  let destinationDrift = false;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/reset' && request.method === 'POST') {
      if (failReset) { response.writeHead(500).end(); return; }
      enabled = false; generation++;
      servedEnabled = false;
      response.writeHead(204).end(); return;
    }
    if (path === '/state') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ enabled, generation })); return;
    }
    if (path === '/settings' && request.url?.includes('enable=1')) {
      enabled = true; response.writeHead(302, { Location: '/settings' }).end(); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/settings') {
      if (clearOnReload && servedEnabled) enabled = false;
      if (enabled) servedEnabled = true;
      response.end(`<!doctype html><html><title>Account settings</title><main><h1>Account settings</h1>
        <label><input type="checkbox" aria-label="Email notifications" ${enabled ? 'checked' : ''}
          onchange="if(this.checked) location.href='/settings?enable=1'">Email notifications</label>
        <p role="status">Email notifications ${enabled ? 'enabled' : 'disabled'}</p></main></html>`); return;
    }
    if (variant === 'a') response.end(`<!doctype html><html><title>Home</title><main><h1>Home</h1>
      <a href="${destinationDrift ? '/other-settings' : '/settings'}">${drift ? 'Preferences' : 'Account settings'}</a></main></html>`);
    else if (variant === 'b') response.end(`<!doctype html><html><title>Home</title><main><h1>Home</h1>
      <button aria-label="Profile" onclick="document.getElementById('menu').hidden=false">Profile</button>
      <nav id="menu" hidden><a href="/settings">Settings</a></nav></main></html>`);
    else response.end(`<!doctype html><html><title>Home</title><style>
      body{font-family:Arial,sans-serif;margin:0;background:#f7f8fa;color:#172235}
      header{height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 ${generation % 2 ? 95 : 30}px;background:#fff;border-bottom:1px solid #d8dde5}
      button{width:46px;height:46px;display:grid;place-items:center;background:#fff;border:1px solid #c7cfda;border-radius:9px;cursor:pointer}
      button:hover{background:#eef2f8}svg{width:28px;height:28px;fill:#334e70}
      main{padding:32px}
      </style><header><strong>My account</strong><button onclick="location.href='${destinationDrift ? '/other-settings' : '/settings'}'">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.5-2-3.5-2.3.9a8 8 0 0 0-1.7-1L15 3h-4l-.4 2.9a8 8 0 0 0-1.7 1L6.6 6l-2 3.5 2 1.5a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.5 2.3-.9a8 8 0 0 0 1.7 1L11 21h4l.4-2.9a8 8 0 0 0 1.7-1l2.3.9 2-3.5-2-1.5ZM13 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>
      </button></header><main><h1>Welcome back</h1><p>Manage your account from the controls above.</p></main></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const state = async () => (await (await fetch(`${baseUrl}/state`)).json() as { enabled: boolean }).enabled;
  let priorBrowserCount = -1;
  const reset: StateResetProvider = { async prepareCleanState(task: TaskEnvelopeV1) {
    if (task.stateResetRef !== 'fixture_reset' || new URL(task.startUrl).origin !== baseUrl)
      throw new Error('RESET_AUTHORITY_DENIED');
    const response = await fetch(`${baseUrl}/reset`, { method: 'POST' });
    const fresh = browserCount() > priorBrowserCount;
    priorBrowserCount = browserCount();
    const verified = response.ok && !await state();
    return { freshBrowserContext: fresh, applicationStateVerified: verified,
      resetRef: 'fixture_reset', evidenceRef: `reset${generation}` };
  } };
  return { baseUrl, variant, reset, state,
    setDrift: value => { drift = value; }, setFailReset: value => { failReset = value; },
    setClearOnReload: value => { clearOnReload = value; },
    setDestinationDrift: value => { destinationDrift = value; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
