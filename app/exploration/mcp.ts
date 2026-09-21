import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type EffectiveProfile, ProtectedContextFactory, type ProtectedBrowserSession, resolveApprovedAddress } from '../profile/index.js';

const require = createRequire(import.meta.url);
export const MCP_VERSION = (require('@playwright/mcp/package.json') as { version: string }).version;

const requiredTools = [
  'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_generate_locator',
  'browser_click', 'browser_fill_form', 'browser_select_option', 'browser_wait_for',
] as const;
type ToolName = typeof requiredTools[number];
type McpBrowserContext = Awaited<ReturnType<NonNullable<Parameters<typeof createConnection>[1]>>>;

export interface McpCallRecord {
  name: ToolName;
  arguments: Record<string, unknown>;
  response: string;
}

export class McpToolError extends Error {
  constructor(readonly tool: string, readonly reason: string) {
    super(`${tool}: ${reason}`);
    this.name = 'McpToolError';
  }
}

export function assertMcpCapabilities(inventory: readonly string[]): void {
  const missing = requiredTools.filter((name) => !inventory.includes(name));
  if (missing.length) throw new McpToolError('capability-check', `Missing required tools: ${missing.join(', ')}`);
}

/** An MCP connection bound to one protected, disposable M3 browser context. */
export class McpExplorationSession {
  readonly #client: Client;
  readonly #server: Awaited<ReturnType<typeof createConnection>>;
  readonly browserSession: ProtectedBrowserSession;
  readonly #outputDir: string;
  readonly toolInventory: readonly string[];
  readonly calls: McpCallRecord[] = [];
  #closed = false;

  private constructor(client: Client, server: Awaited<ReturnType<typeof createConnection>>,
    browserSession: ProtectedBrowserSession, toolInventory: string[], outputDir: string) {
    this.#client = client;
    this.#server = server;
    this.browserSession = browserSession;
    this.toolInventory = toolInventory;
    this.#outputDir = outputDir;
  }

  static async open(factory: ProtectedContextFactory, profileRef: { id: string; version: string },
    expectedProfile: EffectiveProfile): Promise<McpExplorationSession> {
    const browserSession = await factory.open(profileRef, expectedProfile);
    let outputDir: string | undefined;
    let server: Awaited<ReturnType<typeof createConnection>> | undefined;
    let client: Client | undefined;
    try {
      outputDir = await mkdtemp(path.join(tmpdir(), 'qa-mcp-output-'));
      // The pinned MCP version accepts a contextGetter. MCP never launches a
      // second browser or obtains a persistent profile through this adapter.
      server = await createConnection({
        capabilities: ['core', 'testing'],
        browser: { browserName: 'chromium', isolated: false },
        webmcp: false,
        saveSession: false,
        outputDir,
        outputMaxSize: 131_072,
        timeouts: {
          action: browserSession.effectiveProfile.profile.timeoutPolicy.actionMs,
          navigation: browserSession.effectiveProfile.profile.timeoutPolicy.navigationMs,
        },
      }, async () => browserSession.context as unknown as McpBrowserContext);
      client = new Client({ name: 'qa-m6-resolver', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = (await client.listTools()).tools.map((tool) => tool.name);
      assertMcpCapabilities(inventory);
      return new McpExplorationSession(client, server, browserSession, inventory, outputDir);
    } catch (error) {
      await client?.close().catch(() => {});
      await server?.close().catch(() => {});
      await browserSession.close();
      if (outputDir) await rm(outputDir, { recursive: true, force: true });
      throw error;
    }
  }

  async #call(name: ToolName, args: Record<string, unknown>): Promise<string> {
    if (this.#closed) throw new McpToolError(name, 'Exploration session is closed');
    if (!this.toolInventory.includes(name)) throw new McpToolError(name, 'Capability unavailable');
    const mainFrameDenials: Promise<boolean>[] = [];
    const onResponse = (response: import('@playwright/test').Response): void => {
      if (response.status() !== 403 || !response.request().isNavigationRequest()) return;
      try {
        if (response.frame().parentFrame() === null) {
          mainFrameDenials.push(response.text().then((body) => body === 'Network policy denied request').catch(() => false));
        }
      } catch { /* A detached frame cannot establish a main-frame denial. */ }
    };
    this.browserSession.context.on('response', onResponse);
    try {
      const timeout = name === 'browser_navigate'
        ? this.browserSession.effectiveProfile.profile.timeoutPolicy.navigationMs + 5_000
        : this.browserSession.effectiveProfile.profile.timeoutPolicy.actionMs + 5_000;
      const result = await this.#client.callTool({ name, arguments: args }, undefined, { timeout });
      if (!Array.isArray(result.content)) throw new McpToolError(name, 'Malformed tool response');
      const response = result.content.filter((item): item is { type: 'text'; text: string } =>
        !!item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text).join('\n');
      if (response.length > 131_072) throw new McpToolError(name, 'Tool response exceeds bounded size');
      this.calls.push({ name, arguments: args, response });
      if (result.isError) throw new McpToolError(name, response || 'Tool returned an error');
      if ((await Promise.all(mainFrameDenials)).some(Boolean)) throw new McpToolError(name, 'NETWORK_POLICY_DENIED');
      return response;
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      throw new McpToolError(name, error instanceof Error ? error.message : String(error));
    } finally {
      this.browserSession.context.off('response', onResponse);
    }
  }

  async navigate(url: string): Promise<string> {
    try { await resolveApprovedAddress(new URL(url), this.browserSession.effectiveProfile.policy); }
    catch { throw new McpToolError('browser_navigate', 'NETWORK_POLICY_DENIED'); }
    return this.#call('browser_navigate', { url });
  }
  snapshot(): Promise<string> { return this.#call('browser_snapshot', {}); }
  find(text: string): Promise<string> { return this.#call('browser_find', { text }); }
  generateLocator(ref: string, element: string): Promise<string> {
    return this.#call('browser_generate_locator', { target: ref, element });
  }
  click(ref: string, element: string): Promise<string> { return this.#call('browser_click', { target: ref, element }); }
  fill(ref: string, element: string, value: string): Promise<string> {
    return this.#call('browser_fill_form', { fields: [{ target: ref, element, name: element, type: 'textbox', value }] });
  }
  select(ref: string, element: string, value: string): Promise<string> {
    return this.#call('browser_select_option', { target: ref, element, values: [value] });
  }
  waitForText(text: string): Promise<string> { return this.#call('browser_wait_for', { text }); }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    try { await this.#client.close(); } catch (error) { errors.push(error); }
    try { await this.#server.close(); } catch (error) { errors.push(error); }
    try { await this.browserSession.close(); } catch (error) { errors.push(error); }
    try { await rm(this.#outputDir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'MCP exploration cleanup failed');
  }
}
