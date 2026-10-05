/** P4-G2: a disposable, view-only gateway for one headed protected session. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { restrictedBrowserEnvironment } from '../profile/browser-environment.js';
import type { ProtectedBrowserSession } from '../profile/context.js';

const MAX_WS_FRAME = 64 * 1024;
const MAX_RFB_MESSAGE = 8 * 1024 * 1024;
const MAX_ASSET = 1024 * 1024;
const TOKEN_MS = 60_000;
const MAX_SESSION_MS = 10 * 60_000;
const MAX_DEFERRED_SESSION_MS = 20 * 60_000;
const ORIGIN = 'http://127.0.0.1:8501';
const assetScript = String.raw`
const fs = require('node:fs/promises'), path = require('node:path');
(async () => {
  const root = '/opt/public-browser/novnc', input = process.argv[1];
  if (!/^(?:core|vendor|app)\/[a-zA-Z0-9_./-]+\.(?:js|mjs|css|svg|png|woff2?)$/.test(input) || input.includes('..')) process.exit(78);
  const file = await fs.realpath(path.join(root, input));
  if (!file.startsWith(root + '/')) process.exit(78);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > ${MAX_ASSET}) process.exit(78);
  process.stdout.write(await fs.readFile(file));
})().catch(() => process.exit(78));`;

function dockerEnv(): NodeJS.ProcessEnv {
  const env = restrictedBrowserEnvironment(process.env);
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DOCKER_(HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)$/i.test(key) && value) env[key] = value;
  }
  return env;
}

async function pinnedAsset(container: string, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', container, 'node', '-e', assetScript, name],
      { env: dockerEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ASSET) child.kill(); else parts.push(chunk);
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('Pinned viewer asset unavailable')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= MAX_ASSET) resolve(Buffer.concat(parts));
      else reject(new Error('Pinned viewer asset unavailable'));
    });
  });
}

function fixedTimeEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function mime(name: string): string {
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  return 'font/woff2';
}

/** Byte-stream parser for only the reviewed client-side RFB messages. */
export class ViewOnlyClientRfb {
  #pending = Buffer.alloc(0);
  #phase: 'version' | 'security' | 'init' | 'normal' = 'version';

  consume(bytes: Buffer): Buffer[] {
    if (this.#pending.length + bytes.length > MAX_WS_FRAME) throw new Error('RFB client message too large');
    this.#pending = Buffer.concat([this.#pending, bytes]);
    const output: Buffer[] = [];
    while (this.#pending.length) {
      let length: number;
      if (this.#phase === 'version') {
        length = 12;
        if (this.#pending.length < length) break;
        if (!/^RFB 003\.(?:003|007|008)\n$/.test(this.#pending.subarray(0, 12).toString('ascii')))
          throw new Error('RFB version denied');
        this.#phase = 'security';
      } else if (this.#phase === 'security') {
        length = 1;
        if (this.#pending.length < length) break;
        if (this.#pending[0] !== 1) throw new Error('RFB security denied');
        this.#phase = 'init';
      } else if (this.#phase === 'init') {
        length = 1;
        if (this.#pending.length < length) break;
        this.#phase = 'normal';
      } else {
        const type = this.#pending[0];
        if (type === 0) length = 20;
        else if (type === 2) {
          if (this.#pending.length < 4) break;
          const count = this.#pending.readUInt16BE(2);
          if (count > 64) throw new Error('RFB encoding list denied');
          length = 4 + count * 4;
        } else if (type === 3) length = 10;
        else throw new Error('RFB input denied');
        if (this.#pending.length < length) break;
        if (type === 0 && (this.#pending[4] !== 32 || this.#pending[7] !== 1))
          throw new Error('RFB pixel format denied');
        if (type === 3 && (this.#pending.readUInt16BE(6) > 1280 ||
            this.#pending.readUInt16BE(8) > 800)) throw new Error('RFB update bounds denied');
        if (type === 2) {
          output.push(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
          this.#pending = this.#pending.subarray(length);
          continue;
        }
      }
      output.push(this.#pending.subarray(0, length));
      this.#pending = this.#pending.subarray(length);
    }
    return output;
  }
}

/** Reject server clipboard/extension messages before any byte reaches noVNC. */
export class ViewOnlyServerRfb {
  #pending = Buffer.alloc(0);
  #phase: 'version' | 'security' | 'result' | 'init' | 'normal' = 'version';
  #bytesPerPixel = 4;

  consume(bytes: Buffer): Buffer[] {
    if (this.#pending.length + bytes.length > MAX_RFB_MESSAGE) throw new Error('RFB server message too large');
    this.#pending = Buffer.concat([this.#pending, bytes]);
    const output: Buffer[] = [];
    while (this.#pending.length) {
      let length: number;
      if (this.#phase === 'version') {
        length = 12;
        if (this.#pending.length < length) break;
        if (!/^RFB 003\.008\n$/.test(this.#pending.subarray(0, 12).toString('ascii')))
          throw new Error('RFB server version denied');
        this.#phase = 'security';
      } else if (this.#phase === 'security') {
        const count = this.#pending[0]!;
        if (count !== 1) throw new Error('RFB security list denied');
        length = 2;
        if (this.#pending.length < length) break;
        if (this.#pending[1] !== 1) throw new Error('RFB security type denied');
        this.#phase = 'result';
      } else if (this.#phase === 'result') {
        length = 4;
        if (this.#pending.length < length) break;
        if (this.#pending.readUInt32BE(0) !== 0) throw new Error('RFB security failed');
        this.#phase = 'init';
      } else if (this.#phase === 'init') {
        if (this.#pending.length < 24) break;
        const width = this.#pending.readUInt16BE(0), height = this.#pending.readUInt16BE(2);
        const nameBytes = this.#pending.readUInt32BE(20);
        if (width < 1 || width > 1280 || height < 1 || height > 800 ||
            this.#pending[4] !== 32 || nameBytes > 1024) throw new Error('RFB display bounds denied');
        length = 24 + nameBytes;
        if (this.#pending.length < length) break;
        this.#bytesPerPixel = 4;
        this.#phase = 'normal';
      } else {
        const type = this.#pending[0];
        if (type === 2) length = 1;
        else if (type === 0) {
          if (this.#pending.length < 4) break;
          const count = this.#pending.readUInt16BE(2);
          if (count > 1024) throw new Error('RFB rectangle count denied');
          length = 4;
          let incomplete = false;
          for (let index = 0; index < count; index++) {
            if (this.#pending.length < length + 12) { incomplete = true; break; }
            const width = this.#pending.readUInt16BE(length + 4);
            const height = this.#pending.readUInt16BE(length + 6);
            const encoding = this.#pending.readInt32BE(length + 8);
            if (encoding !== 0 || width > 1280 || height > 800) throw new Error('RFB encoding denied');
            length += 12 + width * height * this.#bytesPerPixel;
            if (length > MAX_RFB_MESSAGE) throw new Error('RFB frame too large');
            if (this.#pending.length < length) { incomplete = true; break; }
          }
          if (incomplete) break;
        } else throw new Error('RFB server data denied');
        if (this.#pending.length < length) break;
      }
      output.push(this.#pending.subarray(0, length));
      this.#pending = this.#pending.subarray(length);
    }
    return output;
  }
}

function websocketPacket(data: Buffer): Buffer {
  const head = data.length < 126 ? Buffer.from([0x82, data.length])
    : Buffer.from([0x82, 126, data.length >>> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

/** One-use WebSocket frame decoder. No fragmentation, text, compression or unmasked input. */
export class MaskedWebSocketFrames {
  #pending = Buffer.alloc(0);
  consume(bytes: Buffer): Buffer[] {
    if (this.#pending.length + bytes.length > MAX_WS_FRAME + 14) throw new Error('WebSocket buffer exceeded');
    this.#pending = Buffer.concat([this.#pending, bytes]);
    const output: Buffer[] = [];
    while (this.#pending.length >= 2) {
      const first = this.#pending[0]!;
      if ((first & 0xf0) !== 0x80 && first !== 0x88 && first !== 0x89)
        throw new Error('WebSocket opcode denied');
      const lengthCode = this.#pending[1]!;
      if (!(lengthCode & 0x80)) throw new Error('Unmasked WebSocket input');
      if (this.#pending.length < 6) break;
      let dataLength = lengthCode & 0x7f, header = 2;
      if (dataLength === 127) throw new Error('Oversized WebSocket input');
      if (dataLength === 126) {
        if (this.#pending.length < 8) break;
        dataLength = this.#pending.readUInt16BE(2); header = 4;
      }
      if (dataLength > MAX_WS_FRAME || this.#pending.length < header + 4 + dataLength) break;
      if (first === 0x88) throw new Error('WebSocket closed');
      if (first === 0x89) throw new Error('WebSocket ping unsupported');
      const mask = this.#pending.subarray(header, header + 4);
      const payload = Buffer.from(this.#pending.subarray(header + 4, header + 4 + dataLength));
      for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index & 3]!;
      output.push(payload);
      this.#pending = this.#pending.subarray(header + 4 + dataLength);
    }
    return output;
  }
}

export class ViewerGateway {
  readonly #session: ProtectedBrowserSession;
  readonly #server: http.Server;
  readonly #port: number;
  readonly #deadline: ReturnType<typeof setTimeout>;
  readonly #onVacant: (() => void) | undefined;
  readonly #onUnavailable: (() => void) | undefined;
  #capability = randomBytes(32).toString('hex');
  #expiresAt = Date.now() + TOKEN_MS;
  #active: Duplex | undefined;
  #bridge: ReturnType<ProtectedBrowserSession['openRfbBridge']> | undefined;
  #closed = false;

  private constructor(session: ProtectedBrowserSession, server: http.Server, port: number,
    onVacant?: () => void, options: { sessionLifetimeMs?: number; onUnavailable?: () => void } = {}) {
    this.#session = session; this.#server = server; this.#port = port;
    this.#onVacant = onVacant; this.#onUnavailable = options.onUnavailable;
    this.#deadline = setTimeout(() => this.#unavailable(), options.sessionLifetimeMs ?? MAX_SESSION_MS);
  }

  get port(): number { return this.#port; }
  get capability(): string { return this.#capability; }
  get expiresAt(): string { return new Date(this.#expiresAt).toISOString(); }
  get path(): '/rfb' { return '/rfb'; }

  static async start(session: ProtectedBrowserSession, onVacant?: () => void,
    options: { sessionLifetimeMs?: number; onUnavailable?: () => void } = {}): Promise<ViewerGateway> {
    if (!session.isViewerHeaded || !session.isolationContainerId)
      throw new Error('Headed isolated session required');
    if (options.sessionLifetimeMs !== undefined &&
        (!Number.isSafeInteger(options.sessionLifetimeMs) || options.sessionLifetimeMs < 1 ||
          options.sessionLifetimeMs > MAX_DEFERRED_SESSION_MS))
      throw new Error('Viewer lifetime invalid');
    // The view-only server must already be live before the task uses Chromium.
    // This private preflight never publishes a port or forwards RFB to a client.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const bridge = session.openRfbBridge();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); bridge.kill();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Headed RFB service unavailable')), 5000);
      bridge.stdout.once('data', (bytes: Buffer) => {
        if (bytes.subarray(0, 4).toString('ascii') !== 'RFB ') finish(new Error('Headed RFB service invalid'));
        else finish();
      });
      bridge.once('error', () => finish(new Error('Headed RFB service unavailable')));
      bridge.once('exit', () => finish(new Error('Headed RFB service stopped')));
    });
    const server = http.createServer();
    const ready = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('Viewer bind unavailable'));
        else resolve(address.port);
      });
    });
    const gateway = new ViewerGateway(session, server, ready, onVacant, options);
    server.on('request', (request, response) => { void gateway.#serve(request, response); });
    server.on('upgrade', (request, socket, head) => gateway.#upgrade(request, socket, head));
    server.on('error', () => gateway.#unavailable());
    return gateway;
  }

  #unavailable(): void {
    if (this.#closed) return;
    this.close();
    try { this.#onUnavailable?.(); } catch { /* Viewer failure has no QA authority. */ }
  }

  #headers(): Record<string, string> {
    return {
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': ORIGIN,
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ws://127.0.0.1:${this.#port}; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors ${ORIGIN}`,
    };
  }

  #validHost(request: IncomingMessage): boolean {
    return request.headers.host === `127.0.0.1:${this.#port}` &&
      (request.headers.origin === undefined || request.headers.origin === ORIGIN);
  }

  async #serve(request: IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (this.#closed || !this.#validHost(request) || request.headers.origin !== ORIGIN ||
        request.method !== 'GET' ||
        !request.url || request.url.includes('?') || request.url.includes('#')) {
      response.writeHead(403, this.#headers()).end(); return;
    }
    const name = request.url.slice(1);
    if (!/^(?:core|vendor|app)\/[a-zA-Z0-9_./-]+\.(?:js|mjs|css|svg|png|woff2?)$/.test(name) ||
        name.includes('..')) { response.writeHead(404, this.#headers()).end(); return; }
    let data: Buffer;
    try { data = await pinnedAsset(this.#session.isolationContainerId!, name); }
    catch { response.writeHead(404, this.#headers()).end(); return; }
    const contentType = mime(name);
    if (this.#closed) { response.writeHead(410, this.#headers()).end(); return; }
    response.writeHead(200, { ...this.#headers(), 'Content-Type': contentType,
      'Content-Length': String(data.length) }).end(data);
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const protocols = request.headers['sec-websocket-protocol'];
    const requested = typeof protocols === 'string' ? protocols.split(',').map((item) => item.trim()) : [];
    const presented = requested.find((item) => /^viewer\.[a-f0-9]{64}$/.test(item))?.slice(7) ?? '';
    const key = request.headers['sec-websocket-key'];
    if (this.#closed || !this.#validHost(request) || request.headers.origin !== ORIGIN ||
        request.method !== 'GET' || request.url !== '/rfb' || this.#active ||
        Date.now() >= this.#expiresAt || !this.#capability ||
        !fixedTimeEqual(presented, this.#capability) ||
        !requested.includes('binary') || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || head.length) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    this.#capability = ''; // consumed before the RFB bridge opens
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
    this.#active = socket;
    try { this.#bridge = this.#session.openRfbBridge(); }
    catch { socket.destroy(); return; }
    const bridge = this.#bridge;
    const client = new ViewOnlyClientRfb(), server = new ViewOnlyServerRfb();
    const websocket = new MaskedWebSocketFrames();
    let disposed = false;
    let reconnectAllowed = true;
    let clientDrainPending = false;
    const outbound: Buffer[] = [];
    let outboundBytes = 0;
    let serverDrainPending = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true; socket.destroy(); bridge.kill();
      outbound.length = 0; outboundBytes = 0;
      this.#active = undefined; this.#bridge = undefined;
      if (reconnectAllowed && !this.#closed) this.#onVacant?.();
    };
    const flushOutbound = (): void => {
      if (disposed || serverDrainPending) return;
      while (outbound.length) {
        const packet = outbound.shift()!;
        outboundBytes -= packet.length;
        if (!socket.write(packet)) {
          serverDrainPending = true;
          bridge.stdout.pause();
          socket.once('drain', () => {
            serverDrainPending = false;
            flushOutbound();
            if (!disposed && !serverDrainPending) bridge.stdout.resume();
          });
          return;
        }
      }
    };
    socket.on('data', (bytes: Buffer) => {
      try {
        for (const payload of websocket.consume(bytes)) for (const part of client.consume(payload)) {
          if (!bridge.stdin.write(part) && !clientDrainPending) {
            clientDrainPending = true;
            socket.pause();
            bridge.stdin.once('drain', () => {
              clientDrainPending = false;
              if (!disposed) socket.resume();
            });
          }
        }
      } catch { reconnectAllowed = false; dispose(); }
    });
    bridge.stdout.on('data', (bytes: Buffer) => {
      try {
        for (const part of server.consume(bytes)) {
          for (let offset = 0; offset < part.length; offset += 16 * 1024) {
            const packet = websocketPacket(part.subarray(offset, offset + 16 * 1024));
            outboundBytes += packet.length;
            if (outboundBytes + socket.writableLength > MAX_RFB_MESSAGE + 64 * 1024)
              throw new Error('Viewer output buffer exceeded');
            outbound.push(packet);
          }
        }
        flushOutbound();
      } catch { reconnectAllowed = false; dispose(); }
    });
    socket.once('close', dispose); socket.once('error', dispose);
    bridge.once('close', () => { if (disposed) return; reconnectAllowed = false; dispose(); this.#unavailable(); });
    bridge.once('error', () => { if (disposed) return; reconnectAllowed = false; dispose(); this.#unavailable(); });
  }

  /** A reconnect requires a fresh capability from the authenticated lifecycle channel. */
  issueReconnect(): { capability: string; expiresAt: string } {
    if (this.#closed || this.#active) throw new Error('Viewer unavailable');
    this.#capability = randomBytes(32).toString('hex');
    this.#expiresAt = Date.now() + TOKEN_MS;
    return { capability: this.#capability, expiresAt: this.expiresAt };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#capability = '';
    clearTimeout(this.#deadline);
    this.#active?.destroy(); this.#bridge?.kill();
    this.#server.closeAllConnections(); this.#server.close();
  }
}
