import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Capabilities advertised by every durable (DO + WebSocket) MCP server built
 * through this module.
 *
 * `tools.listChanged: true` tells the client we *may* push
 * `notifications/tools/list_changed`. Unlike the stateless
 * `WebStandardStreamableHTTPServerTransport` (which can never push), the durable
 * transport keeps a live connection through the Durable Object, so this is an
 * honest declaration: Claude Code (and other consumers) can re-fetch
 * `tools/list` without reconnecting when the tool-set changes at runtime.
 *
 * Refs ippoan/mcp-cf-workers#6, ippoan/secrets-inventory#70.
 */
export const DURABLE_MCP_CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: true },
};

export interface CreateDurableMcpOptions<E = unknown, P extends Record<string, unknown> = Record<string, unknown>> {
  /** MCP server name reported in the `initialize` response. */
  name: string;
  /** MCP server version reported in the `initialize` response. */
  version: string;
  /**
   * Called once per Durable Object instance (from `init()`), with the freshly
   * built `McpServer`. Register tools with `server.registerTool(...)`.
   *
   * `props` carries the authenticated context attached at the edge by
   * {@link mountDurableMcp} (e.g. CF Access claims, binding_jwt `scope`). Use it
   * to gate write tools — there is no separate per-request authorization step
   * inside the DO, so scope checks belong here.
   */
  registerTools: (server: McpServer, env: E, props: P) => void | Promise<void>;
}

/**
 * Build a bare `McpServer` advertising {@link DURABLE_MCP_CAPABILITIES} but with
 * no tools registered yet. Used both by the Durable Object class field
 * initializer ({@link createDurableMcp}) and by tests, so the capability
 * declaration is single-sourced.
 */
export function newDurableMcpServer<E, P extends Record<string, unknown>>(
  opts: CreateDurableMcpOptions<E, P>,
): McpServer {
  return new McpServer(
    { name: opts.name, version: opts.version },
    { capabilities: DURABLE_MCP_CAPABILITIES },
  );
}

/**
 * Build the `McpServer` and run `registerTools` against it. This is the exact
 * sequence the Durable Object performs in `init()`, factored out so it can be
 * exercised without a Workers runtime (the DO class itself imports
 * `agents/mcp`, which only loads under workerd).
 */
export async function buildDurableMcpServer<E, P extends Record<string, unknown>>(
  opts: CreateDurableMcpOptions<E, P>,
  env: E,
  props: P,
): Promise<McpServer> {
  const server = newDurableMcpServer(opts);
  await opts.registerTools(server, env, props);
  return server;
}
