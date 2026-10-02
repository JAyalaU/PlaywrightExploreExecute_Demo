import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chromium, type Browser } from '@playwright/test';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { restrictedBrowserEnvironment } from './browser-environment.js';

const IMAGE = 'playwright-demo-public-browser:1.63.0';
const HEADED_IMAGE = 'playwright-demo-public-browser-headed:1.63.0-p4-3a';
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_DOCKER_OUTPUT = 1024 * 1024;

/** Docker gets its own configuration, but never the provider process environment. */
function dockerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = restrictedBrowserEnvironment(process.env);
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DOCKER_(HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)$/i.test(key) && value) result[key] = value;
  }
  return result;
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: dockerEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => fail(), timeout);
    function finish(error?: Error): void {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(output.trim());
    }
    function fail(): void { child.kill(); finish(new Error('Docker control command unavailable')); }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > MAX_DOCKER_OUTPUT) fail();
    });
    child.stdout.on('error', fail);
    child.stderr.on('data', () => {});
    child.stderr.on('error', fail);
    child.once('error', fail);
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('Docker control command failed')));
  });
}

async function disposeContainer(container: string): Promise<void> {
  const filter = /^[a-f0-9]{64}$/.test(container) ? `id=${container}` : `name=^/${container}$`;
  // A Docker Desktop connection reset may race with a successful daemon-side
  // create. Retry removal by the reserved name, then verify the final state.
  for (let attempt = 0; attempt < 6; attempt++) {
    await docker(['rm', '-f', container], 5000).catch(() => undefined);
    try {
      const remaining = await docker(['ps', '-a', '--filter', filter, '--format', '{{.ID}}'], 5000);
      if (!remaining && attempt > 0) return;
    } catch { /* The daemon must become reachable before cleanup can be verified. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Isolated browser container cleanup unverified');
}

function dockerStream(container: string, script: string): ChildProcessWithoutNullStreams {
  const child = spawn('docker', ['exec', '-i', container, 'node', '-e', script], {
    env: dockerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Docker diagnostics are not normal evidence. Drain them so the pipe cannot block.
  child.stderr.resume();
  child.stderr.on('error', () => child.kill());
  child.stdin.on('error', () => child.kill());
  child.stdout.on('error', () => child.kill());
  return child;
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void,
  onInvalid: () => void): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    if (pending.length > MAX_FRAME) { onInvalid(); return; }
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.length > MAX_FRAME) { onInvalid(); return; }
      onLine(line);
    }
  });
}

const controlScript = String.raw`
const readline = require('node:readline');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let endpoint;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version');
      if (response.ok) { endpoint = (await response.json()).webSocketDebuggerUrl; break; }
    } catch {}
    await pause(250);
  }
  if (!endpoint || !endpoint.startsWith('ws://127.0.0.1:9222/')) throw Error('CDP unavailable');
  const socket = new WebSocket(endpoint);
  socket.onopen = () => process.stdout.write(JSON.stringify({type:'ready',token:process.env.PUBLIC_BROWSER_CONTROL_TOKEN}) + '\n');
  socket.onmessage = event => {
    process.stdout.write(JSON.stringify({type:'message',message:JSON.parse(String(event.data))}) + '\n');
    if (process.stdout.writableLength > ${MAX_FRAME}) process.exit(78);
  };
  socket.onclose = () => process.exit(0);
  socket.onerror = () => process.exit(78);
  readline.createInterface({input:process.stdin}).on('line', line => {
    try { socket.send(line); } catch { process.exit(78); }
  });
  process.stdin.on('end', () => socket.close());
})().catch(() => process.exit(78));
`;

function awaitReady(child: ChildProcessWithoutNullStreams, onFrame: (frame: Record<string, unknown>) => void,
  timeoutMs: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(), timeoutMs);
    function finish(error?: Error): void {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    function fail(): void { child.kill(); finish(new Error('Isolated browser control unavailable')); }
    child.once('error', fail);
    child.once('exit', () => finish(new Error('Isolated browser control stopped')));
    lineReader(child.stdout, (line) => {
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === 'ready') frame.token === token ? finish() : fail();
        else onFrame(frame);
      } catch { fail(); }
    }, fail);
  });
}

export class IsolatedBrowser {
  readonly browser: Browser;
  readonly #container: string;
  readonly #control: ChildProcessWithoutNullStreams;
  readonly #headed: boolean;
  #closePromise: Promise<void> | undefined;

  private constructor(browser: Browser, container: string,
    control: ChildProcessWithoutNullStreams, headed: boolean) {
    this.browser = browser; this.#container = container;
    this.#control = control; this.#headed = headed;
  }

  /** Runtime proof only; never persist this Docker identity in TestSpec artifacts. */
  get containerId(): string { return this.#container; }

  static async open(presentationMode: 'headless' | 'headed' = 'headless'): Promise<IsolatedBrowser> {
    const name = `public-browser-g1-${randomUUID().replaceAll('-', '')}`;
    const token = randomUUID();
    let container: string | undefined;
    let control: ChildProcessWithoutNullStreams | undefined;
    try {
      container = name;
      const started = await docker([
        'run', '-d', '--rm', '--name', name, '--init', '--network', 'bridge', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=512m', '--shm-size', '256m',
        '-e', 'HOME=/tmp', '-e', 'XDG_CACHE_HOME=/tmp',
        '-e', 'XDG_CONFIG_HOME=/tmp', '-e', 'XDG_RUNTIME_DIR=/tmp',
        '-e', `PUBLIC_BROWSER_CONTROL_TOKEN=${token}`,
        // Docker Desktop's default user-namespace policy cannot start Chrome's
        // inner sandbox under the required cap-drop/no-new-privileges boundary.
        // The disposable container is the reviewed host isolation boundary.
        presentationMode === 'headed' ? HEADED_IMAGE : IMAGE, '--no-sandbox',
      ]);
      if (!/^[a-f0-9]{64}$/.test(started)) throw new Error('Invalid isolated browser container identity');
      container = started;
      control = dockerStream(container, controlScript);
      const transport: ConnectOverCDPTransport = {
        open(): void {},
        send(message: object): void {
          if (!control || !control.stdin.writable) {
            control?.kill();
            throw new Error('Isolated browser control unavailable');
          }
          control.stdin.write(JSON.stringify(message) + '\n');
          if (control.stdin.writableLength > MAX_FRAME) {
            control.kill();
            throw new Error('Isolated browser control exceeded bounded buffer');
          }
        },
        close(): void { control?.stdin.end(); },
      };
      await awaitReady(control, (frame) => {
        if (frame.type === 'message' && frame.message && typeof frame.message === 'object') transport.onmessage?.(frame.message);
        else control?.kill();
      }, 25_000, token);
      control.once('exit', () => transport.onclose?.('Isolated browser control stopped'));
      // Headed runs are observational. Give the local view time to connect and
      // make browser actions visible; the separately approved headless proof
      // keeps its original timing and remains the autonomous result.
      const browser = await chromium.connectOverCDP(transport, {
        isLocal: false, timeout: 10_000,
        ...(presentationMode === 'headed' ? { slowMo: 750 } : {}),
      });
      return new IsolatedBrowser(browser, container, control, presentationMode === 'headed');
    } catch (error) {
      control?.kill();
      if (container) await disposeContainer(container).catch(() => {
        throw new AggregateError([error], 'Isolated browser startup and cleanup failed');
      });
      throw error;
    }
  }

  /** A private, per-session RFB standard-stream bridge; never a published port. */
  openRfbBridge(): ChildProcessWithoutNullStreams {
    if (!this.#headed || this.#closePromise) throw new Error('Headed RFB session unavailable');
    const script = String.raw`
const net = require('node:net');
const socket = net.connect({ host: '127.0.0.1', port: 5900 });
socket.setTimeout(5000, () => socket.destroy());
socket.once('connect', () => socket.setTimeout(0));
socket.on('error', () => process.exit(78));
socket.on('close', () => process.exit(0));
process.stdin.pipe(socket); socket.pipe(process.stdout);
process.stdin.on('error', () => socket.destroy());
process.stdout.on('error', () => socket.destroy());
`;
    return dockerStream(this.#container, script);
  }

  close(): Promise<void> {
    return this.#closePromise ??= Promise.resolve().then(() => this.#close());
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.browser.close(); } catch (error) { errors.push(error); }
    this.#control.kill();
    try { await disposeContainer(this.#container); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Isolated browser cleanup unverified');
  }
}
