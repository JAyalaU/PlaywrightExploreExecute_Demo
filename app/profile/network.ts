import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { NetworkPolicy } from './contracts.js';

const UPSTREAM_TIMEOUT_MS = 30_000;

export class NetworkPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkPolicyError'; }
}

function normalizeAddress(value: string): string {
  if (net.isIP(value) === 4) return new URL(`http://${value}/`).hostname;
  if (net.isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  throw new NetworkPolicyError('Invalid destination address');
}

function destination(url: URL): { host: string; port: number } {
  if (url.username || url.password || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new NetworkPolicyError('Unsupported destination URL');
  }
  return { host: url.hostname.toLowerCase(), port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)) };
}

/** Resolve on every request/tunnel and pin the socket to an approved address. */
export async function resolveApprovedAddress(
  url: URL,
  policy: NetworkPolicy,
  resolve: (host: string) => Promise<readonly string[]> = async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((item) => item.address),
): Promise<string> {
  const { host, port } = destination(url);
  const rule = policy.destinations.find((item) => item.host === host && item.ports.includes(port));
  if (!rule) throw new NetworkPolicyError(`Destination denied: ${host}:${port}`);
  const allowed = new Set(rule.addresses.map(normalizeAddress));
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const resolved = net.isIP(literal) ? [literal] : await resolve(host);
  if (!resolved.length || resolved.some((address) => !allowed.has(normalizeAddress(address)))) {
    throw new NetworkPolicyError(`Destination address denied: ${host}:${port}`);
  }
  return normalizeAddress(resolved[0]!);
}

function errorStatus(error: unknown): number { return error instanceof NetworkPolicyError ? 403 : 502; }
function denyResponse(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(errorStatus(error), { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.end(error instanceof NetworkPolicyError ? 'Network policy denied request' : 'Upstream request failed');
}
function denySocket(socket: Duplex, error: unknown): void {
  if (socket.destroyed) return;
  const status = errorStatus(error);
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function absoluteUrl(request: IncomingMessage): URL {
  if (!request.url || !/^https?:\/\//i.test(request.url)) throw new NetworkPolicyError('Proxy requires an absolute HTTP URL');
  const url = new URL(request.url);
  if (url.protocol !== 'http:') throw new NetworkPolicyError('HTTPS requires a CONNECT tunnel');
  return url;
}

function tunnelUrl(authority: string | undefined): URL {
  if (!authority || /[/@?#]/.test(authority)) throw new NetworkPolicyError('Invalid CONNECT authority');
  const url = new URL(`https://${authority}/`);
  if (!url.port || authority.toLowerCase() !== url.host.toLowerCase()) throw new NetworkPolicyError('Invalid CONNECT authority');
  return url;
}

export class ProtectedProxy {
  readonly #policy: NetworkPolicy;
  readonly #server: http.Server;
  readonly #sockets = new Set<Duplex>();
  #closed = false;
  #closePromise?: Promise<void>;

  private constructor(policy: NetworkPolicy) {
    this.#policy = structuredClone(policy);
    this.#server = http.createServer((request, response) => { void this.#forward(request, response); });
    this.#server.on('connect', (request, socket, head) => { void this.#connect(request, socket, head); });
    this.#server.on('upgrade', (request, socket, head) => { void this.#upgrade(request, socket, head); });
    this.#server.on('connection', (socket) => this.#track(socket));
  }

  static async start(policy: NetworkPolicy): Promise<ProtectedProxy> {
    const proxy = new ProtectedProxy(policy);
    proxy.#server.listen(0, '127.0.0.1');
    await once(proxy.#server, 'listening');
    return proxy;
  }

  get url(): string {
    const address = this.#server.address();
    if (!address || typeof address === 'string' || this.#closed) throw new Error('Proxy is closed');
    return `http://127.0.0.1:${address.port}`;
  }

  #track(socket: Duplex): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = absoluteUrl(request);
      const address = await resolveApprovedAddress(url, this.#policy);
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: url.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = http.request({ host: address, port: Number(url.port || 80), path: `${url.pathname}${url.search}`, method: request.method, headers, agent: false },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          upstreamResponse.on('error', () => response.destroy());
        });
      upstream.on('error', () => denyResponse(response, new Error('Upstream request failed')));
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('Upstream request timed out')));
      request.on('error', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) { denyResponse(response, error); }
  }

  async #connect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    try {
      const url = tunnelUrl(request.url);
      const address = await resolveApprovedAddress(url, this.#policy);
      const upstream = net.connect({ host: address, port: Number(url.port) });
      this.#track(upstream);
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('Tunnel timed out')));
      let connected = false;
      upstream.once('error', () => { if (connected) client.destroy(); });
      await once(upstream, 'connect');
      connected = true;
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch (error) { denySocket(client, error); }
  }

  async #upgrade(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    try {
      const url = absoluteUrl(request);
      const address = await resolveApprovedAddress(url, this.#policy);
      const upstream = net.connect({ host: address, port: Number(url.port || 80) });
      this.#track(upstream);
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('WebSocket upstream timed out')));
      let connected = false;
      upstream.once('error', () => { if (connected) client.destroy(); });
      await once(upstream, 'connect');
      connected = true;
      const headers = Object.entries(request.headers)
        .filter(([name]) => name !== 'host' && name !== 'proxy-connection' && name !== 'proxy-authorization')
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}\r\n`).join('');
      upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch (error) { denySocket(client, error); }
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      for (const socket of this.#sockets) socket.destroy();
      this.#closePromise = new Promise<void>((resolve, reject) =>
        this.#server.close((error) => error ? reject(error) : resolve()));
    }
    await this.#closePromise;
  }
}
