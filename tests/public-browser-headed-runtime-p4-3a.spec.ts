import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const repo = new URL('../', import.meta.url);
const image = 'playwright-demo-public-browser-headed:1.63.0-p4-3a';
const runtimeEnabled = process.env.P4_3A_CONTAINER_RUNTIME === '1';

function docker(args: string[], input?: string, timeout = 8_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8', input, timeout, windowsHide: true,
    env: {
      PATH: process.env.PATH,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
      ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
    },
  }).trim();
}

test('P4-3A keeps a distinct headed image and preserves the unchanged headless entrypoint', async () => {
  const dockerfile = await readFile(new URL('infra/public-browser/Dockerfile.headed', repo), 'utf8');
  const rawPatch = await readFile(new URL('infra/public-browser/patch-novnc-raw.cjs', repo), 'utf8');
  const headed = await readFile(new URL('infra/public-browser/headed-entrypoint.sh', repo), 'utf8');
  const headless = await readFile(new URL('infra/public-browser/entrypoint.sh', repo), 'utf8');
  expect(dockerfile).toContain('mcr.microsoft.com/playwright:v1.63.0-noble');
  expect(dockerfile).toMatch(/xvfb=[^\s]+/);
  expect(dockerfile).toMatch(/x11vnc=[^\s]+/);
  expect(dockerfile).toMatch(/novnc=[^\s]+/);
  expect(dockerfile).toContain('/opt/public-browser/novnc');
  expect(dockerfile).toContain('node /tmp/patch-novnc-raw.cjs');
  expect(rawPatch).toContain('data[index + i * 4 + 3] = 255;');
  expect(headed).toContain('Xvfb "$DISPLAY"');
  expect(headed).toContain('-localhost -rfbport 5900');
  expect(headed).toContain('-viewonly -noclipboard -nosel');
  expect(headed).toContain('--proxy-server="$PUBLIC_BROWSER_PROXY"');
  expect(headed).toContain('--proxy-bypass-list=\'<-loopback>\'');
  expect(headed).not.toContain('--headless');
  expect(headless).toContain('--headless=new');
  expect(headless).not.toContain('x11vnc');
});

test('P4-3A headed compose keeps the compartment mountless and unpublished', async () => {
  const compose = await readFile(new URL('infra/public-browser/compose-headed.yaml', repo), 'utf8');
  expect(compose).toContain('playwright-demo-public-browser-headed:1.63.0-p4-3a');
  expect(compose).toContain('read_only: true');
  expect(compose).toContain('cap_drop:');
  expect(compose).toContain('no-new-privileges:true');
  expect(compose).toContain('internal: true');
  expect(compose).not.toMatch(/^\s*ports:/m);
  expect(compose).not.toMatch(/^\s*volumes:/m);
  expect(compose).not.toContain('OPENAI_API_KEY');
});

test('P4-3A runs headed Chromium in the isolated display and rejects forged RFB input', async () => {
  test.setTimeout(90_000);
  test.skip(!runtimeEnabled, 'Set P4_3A_CONTAINER_RUNTIME=1 after building the headed image.');
  const suffix = randomUUID().replaceAll('-', '');
  const name = `public-browser-headed-p4-3a-${suffix}`;
  const token = randomUUID();
  try {
    docker(['run', '-d', '--rm', '--name', name, '--init', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m', '--shm-size', '256m', '-e', 'HOME=/tmp',
      '-e', 'XDG_CACHE_HOME=/tmp', '-e', 'XDG_CONFIG_HOME=/tmp', '-e', 'XDG_RUNTIME_DIR=/tmp',
      '-e', `PUBLIC_BROWSER_CONTROL_TOKEN=${token}`, '-e', 'PUBLIC_BROWSER_PROXY=http://127.0.0.1:9',
      image, '--no-sandbox']);

    const inspect = JSON.parse(docker(['inspect', name]))[0] as {
      Mounts: unknown[];
      Config: { Env: string[]; ExposedPorts?: Record<string, unknown> | null };
      NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
    };
    expect(inspect.Mounts).toEqual([]);
    expect(inspect.Config.Env.some((value) => value.startsWith('OPENAI_API_KEY='))).toBe(false);
    expect(inspect.Config.ExposedPorts ?? null).toBeNull();
    expect(Object.values(inspect.NetworkSettings.Ports).flat().filter(Boolean)).toEqual([]);

    const probe = String.raw`
const net = require('node:net');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'cdp_wait';
const deadline = setTimeout(() => {
  process.stdout.write('P4_3A_PROBE_FAILED:'+stage+':timeout');
  process.exit(0);
}, 20_000);
async function waitForPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await pause(100);
  }
  throw Error('CDP page unavailable');
}
async function rfbProbe() {
  const socket = net.connect(5900, '127.0.0.1');
  let chunks = [], available = 0, readers = [];
  socket.on('data', data => { chunks.push(data); available += data.length; readers.splice(0).forEach(resolve => resolve()); });
  socket.on('error', error => readers.splice(0).forEach(resolve => resolve(error)));
  socket.on('end', () => readers.splice(0).forEach(resolve => resolve(Error('RFB socket ended'))));
  const read = async size => {
    while (available < size) await new Promise((resolve, reject) => {
      readers.push(error => error ? reject(error) : resolve()); socket.once('error', reject);
    });
    const result = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      const first = chunks[0], count = Math.min(first.length, size - offset);
      first.copy(result, offset, 0, count); offset += count; available -= count;
      if (count === first.length) chunks.shift(); else chunks[0] = first.subarray(count);
    }
    return result;
  };
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const version = await read(12);
  if (!version.toString('ascii').startsWith('RFB 003.')) throw Error('Unexpected RFB protocol');
  socket.write(version);
  const count = (await read(1))[0];
  const types = await read(count);
  if (!types.includes(1)) throw Error('View-only RFB must not require reusable credentials');
  socket.write(Buffer.from([1]));
  if ((await read(4)).readUInt32BE(0) !== 0) throw Error('RFB handshake failed');
  socket.write(Buffer.from([1]));
  const serverInit = await read(24);
  const nameLength = serverInit.readUInt32BE(20);
  if (nameLength) await read(nameLength);
  // Forged keyboard, pointer, and clipboard events must not reach the page.
  socket.write(Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]));
  socket.write(Buffer.from([5, 1, 0, 50, 0, 50]));
  const clip = Buffer.from('forged-test');
  const header = Buffer.alloc(8); header[0] = 6; header.writeUInt32BE(clip.length, 4);
  socket.write(Buffer.concat([header, clip]));
  await pause(400);
  if (socket.destroyed) throw Error('RFB server rejected the viewer session unexpectedly');
  socket.destroy();
}
(async () => {
  const page = await waitForPage();
  stage = 'cdp_connect';
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let next = 1;
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.id && pending.has(frame.id)) {
      const entry = pending.get(frame.id); pending.delete(frame.id);
      frame.error ? entry.reject(Error('CDP request failed')) : entry.resolve(frame.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const call = (method, params={}) => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params}));
  });
  const html = '<button id="p4test" style="position:absolute;left:20px;top:20px;width:200px;height:100px">test</button>';
  stage = 'page_setup';
  await call('Runtime.evaluate', {expression: 'document.open();document.write('+JSON.stringify(html)+');document.close()'});
  await call('Runtime.evaluate', {expression: 'window.__p4Input=0;for(const n of ["keydown","mousedown","pointerdown","click"])addEventListener(n,()=>window.__p4Input++);document.getElementById("p4test").focus()'});
  const before = await call('Runtime.evaluate', {expression:'window.__p4Input', returnByValue:true});
  if (before.result.value !== 0) throw Error('COUNTER_SETUP_FAILED');
  stage = 'rfb_probe';
  await rfbProbe();
  stage = 'input_assertion';
  const after = await call('Runtime.evaluate', {expression:'window.__p4Input', returnByValue:true});
  ws.close();
  if (after.result.value !== 0) throw Error('RFB_INPUT_REACHED_CHROMIUM');
  const processes = require('node:child_process').execFileSync('ps',['-eo','comm,args'],{encoding:'utf8'});
  stage = 'process_assertion';
  const rows = processes.split('\n');
  const display = rows.find(line => /^\s*Xvfb\s/.test(line)) || '';
  const rfb = rows.find(line => /^\s*x11vnc\s/.test(line)) || '';
  const chrome = rows.filter(line => /^\s*chrome\s/.test(line));
  if (!display || !rfb || chrome.length === 0) throw Error('MISSING_HEADED_PROCESS');
  if (!rfb.includes('-localhost') || !rfb.includes('-viewonly') || !rfb.includes('-noclipboard') || !rfb.includes('-nosel')) throw Error('RFB_FLAGS_MISSING');
  if (chrome.some(line => line.includes('--headless'))) throw Error('HEADLESS_CHROME');
  if (!require('node:fs').existsSync('/opt/public-browser/novnc/vnc.html')) throw Error('NOVNC_ASSETS_MISSING');
  clearTimeout(deadline);
  process.stdout.write('P4_3A_HEADED_RFB_INPUT_DENIAL_PASSED');
})().catch(error => {
  clearTimeout(deadline);
  const reason = ['COUNTER_SETUP_FAILED', 'RFB_INPUT_REACHED_CHROMIUM', 'MISSING_HEADED_PROCESS',
    'RFB_FLAGS_MISSING', 'HEADLESS_CHROME', 'NOVNC_ASSETS_MISSING'].includes(error?.message)
    ? error.message : (error?.name || 'Error');
  process.stdout.write('P4_3A_PROBE_FAILED:'+stage+':'+reason);
  process.exitCode=0;
});
`;
    let processes = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        processes = docker(['exec', name, 'ps', '-eo', 'comm,args']);
        if (processes.includes('Xvfb') && processes.includes('x11vnc')) break;
      } catch { /* Wait for the disposable compartment's startup sequence. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(processes.includes('Xvfb') && processes.includes('x11vnc')).toBe(true);
    const lastProbe = docker(['exec', name, 'node', '-e', probe], undefined, 30_000);
    expect(lastProbe).toBe('P4_3A_HEADED_RFB_INPUT_DENIAL_PASSED');
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* The daemon may have removed --rm container already. */ }
  }
  expect(docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).toBe('');
});
