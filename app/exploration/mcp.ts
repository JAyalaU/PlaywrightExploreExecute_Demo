import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProtectedContextFactory, type ProtectedBrowserSession } from '../profile/local-context.js';
import type { NativeEffectiveProfile } from '../profile/native-profile.js';

const require = createRequire(import.meta.url);
export const MCP_VERSION = (require('@playwright/mcp/package.json') as { version: string }).version;

const requiredTools = [
  'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_generate_locator',
  'browser_click', 'browser_fill_form', 'browser_select_option', 'browser_wait_for',
] as const;
type ToolName = typeof requiredTools[number];
export type McpCallObserver = (event: { callId: string; tool: ToolName; state: 'started' | 'completed' | 'failed' }) => void;
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
  readonly #observeCall: McpCallObserver | undefined;
  #closed = false;
  #groundingRevision = 0;
  #activeCalls = 0;
  #groundingLocked = false;
  #lastNavigation: { requested: string; final: string; redirected: boolean; page: object } | undefined;

  /** A one-shot, runtime-owned receipt for an initial document request. */
  consumeMatchingBootstrapNavigation(url: string): boolean {
    const receipt = this.#lastNavigation;
    this.#lastNavigation = undefined;
    const pages = this.browserSession.context.pages();
    return !!receipt && receipt.requested === new URL(url).href && !receipt.redirected &&
      receipt.final === receipt.requested && pages.length === 1 && pages[0] === receipt.page &&
      !pages[0]!.isClosed() && pages[0]!.url() === receipt.final;
  }

  /** Additive private runtime coordination; old tool names and wire schemas are unchanged. */
  get groundingRevision(): number { return this.#groundingRevision; }
  async withExclusiveGrounding<T>(consume: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#activeCalls || this.#groundingLocked)
      throw new McpToolError('grounding', 'SESSION_BUSY_OR_CLOSED');
    this.#groundingLocked = true;
    try { return await consume(); } finally { this.#groundingLocked = false; }
  }

  private constructor(client: Client, server: Awaited<ReturnType<typeof createConnection>>,
    browserSession: ProtectedBrowserSession, toolInventory: string[], outputDir: string, observeCall?: McpCallObserver) {
    this.#client = client;
    this.#server = server;
    this.browserSession = browserSession;
    this.toolInventory = toolInventory;
    this.#outputDir = outputDir;
    this.#observeCall = observeCall;
  }

  static async open(factory: ProtectedContextFactory, profileRef: { id: string; version: string },
    expectedProfile: NativeEffectiveProfile, attemptId?: string, observeCall?: McpCallObserver): Promise<McpExplorationSession> {
    const browserSession = await factory.open(profileRef, expectedProfile,
      attemptId ? { observationOwner: { kind: 'attempt', id: attemptId } } : undefined);
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
      return new McpExplorationSession(client, server, browserSession, inventory, outputDir, observeCall);
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
    if (this.#groundingLocked) throw new McpToolError(name, 'SESSION_GROUNDING_LOCKED');
    if (!this.toolInventory.includes(name)) throw new McpToolError(name, 'Capability unavailable');
    this.#groundingRevision++;
    this.#activeCalls++;
    const callId = `mcp-${randomUUID()}`;
    try { this.#observeCall?.({ callId, tool: name, state: 'started' }); } catch { /* Observation is non-authoritative. */ }
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
      try { this.#observeCall?.({ callId, tool: name, state: 'completed' }); } catch { /* Observation is non-authoritative. */ }
      return response;
    } catch (error) {
      try { this.#observeCall?.({ callId, tool: name, state: 'failed' }); } catch { /* Observation is non-authoritative. */ }
      if (error instanceof McpToolError) throw error;
      throw new McpToolError(name, error instanceof Error ? error.message : String(error));
    } finally {
      this.#activeCalls--;
      this.#groundingRevision++;
    }
  }

  async navigate(url: string): Promise<string> {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new McpToolError('browser_navigate', 'Invalid navigation URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new McpToolError('browser_navigate', 'Unsupported navigation URL scheme');
    this.#lastNavigation = undefined;
    const responses: Array<{ final: string; redirected: boolean; page: object }> = [];
    const onResponse = (response: import('@playwright/test').Response) => {
      try {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame())
          responses.push({ final: response.url(), redirected: !!request.redirectedFrom(), page: request.frame().page() });
      } catch { /* A response without an owned frame cannot certify adoption. */ }
    };
    this.browserSession.context.on('response', onResponse);
    try {
      const result = await this.#call('browser_navigate', { url });
      const final = responses.at(-1);
      if (final) this.#lastNavigation = { requested: parsed.href, ...final };
      return result;
    } finally { this.browserSession.context.off('response', onResponse); }
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
