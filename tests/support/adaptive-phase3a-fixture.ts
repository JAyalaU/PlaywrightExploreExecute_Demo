import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StateResetProvider } from '../../app/adaptive/interfaces.js';
import type { TaskEnvelopeV1 } from '../../app/adaptive/contracts.js';

export type Phase3aFamily = 'activity' | 'security';
export interface Phase3aFixture {
  baseUrl: string;
  family: Phase3aFamily;
  reset: StateResetProvider;
  /** Hidden test oracle. Never supplied to the adaptive task, model, or verifier. */
  oracle: () => Promise<{ alertsEnabled: boolean; resetGeneration: number }>;
  close: () => Promise<void>;
}

export async function startPhase3aFixture(family: Phase3aFamily,
  browserCount: () => number): Promise<Phase3aFixture> {
  let alertsEnabled = false, resetGeneration = 0;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/reset' && request.method === 'POST') {
      alertsEnabled = false;
      resetGeneration++;
      response.writeHead(204).end();
      return;
    }
    if (path === '/security' && request.url?.includes('enable=1')) {
      alertsEnabled = true;
      response.writeHead(302, { Location: '/security' }).end();
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (family === 'activity') {
      if (path === '/activity') response.end(`<!doctype html><html><title>Activity</title>
        <main><h1>Activity</h1><p>Recent account activity</p></main></html>`);
      else response.end(`<!doctype html><html><title>Dashboard</title>
        <main><h1>Dashboard</h1><a href="/activity">Activity</a></main></html>`);
      return;
    }
    if (path === '/security') {
      response.end(`<!doctype html><html><title>Security</title><main><h1>Security</h1>
        <label><input type="checkbox" aria-label="Login alerts" ${alertsEnabled ? 'checked' : ''}
          onchange="if(this.checked) location.href='/security?enable=1'">Login alerts</label></main></html>`);
      return;
    }
    response.end(`<!doctype html><html><title>Home</title><main><h1>Home</h1>
      <button aria-label="Profile" onclick="document.getElementById('profile-menu').hidden=false">Profile</button>
      <nav id="profile-menu" hidden><a href="/security">Security</a></nav></main></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oracle = async () => ({ alertsEnabled, resetGeneration });
  let priorBrowserCount = -1;
  const reset: StateResetProvider = { async prepareCleanState(task: TaskEnvelopeV1) {
    if (task.stateResetRef !== 'phase3a_reset' || new URL(task.startUrl).origin !== baseUrl)
      throw new Error('RESET_AUTHORITY_DENIED');
    const response = await fetch(`${baseUrl}/reset`, { method: 'POST' });
    const freshBrowserContext = browserCount() > priorBrowserCount;
    priorBrowserCount = browserCount();
    const state = await oracle();
    return { freshBrowserContext,
      applicationStateVerified: response.ok && !state.alertsEnabled,
      resetRef: 'phase3a_reset', evidenceRef: `reset${state.resetGeneration}` };
  } };
  return { baseUrl, family, reset, oracle,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) };
}
