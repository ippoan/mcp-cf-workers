import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export interface CreateWorkerMcpOptions<E = unknown> {
  name: string;
  version: string;
  /**
   * Called once per request with a fresh `McpServer`. Register tools with
   * `server.registerTool(name, opts, handler)` from the SDK.
   *
   * The server is closed after the response is sent — do not retain it.
   */
  registerTools: (server: McpServer, env: E) => void;
  /**
   * If provided, every request gets a new `sessionIdGenerator()` value as
   * the MCP session id. Default `undefined` = stateless (no session).
   * Most Workers-based MCP servers should leave this stateless.
   */
  sessionIdGenerator?: () => string;
}

export type WorkerMcpHandler<E = unknown> = (request: Request, env: E) => Promise<Response>;

/**
 * Returns a `(request, env) => Response` function ready to mount on any
 * Workers entry point (Hono `app.all("/mcp", ...)`, raw `fetch`, etc).
 *
 * One `McpServer` + one `WebStandardStreamableHTTPServerTransport` is created
 * per request. Server-initiated push is not supported (use Durable Objects +
 * `@cloudflare/agents` if you need that).
 */
export function createWorkerMcp<E = unknown>(
  opts: CreateWorkerMcpOptions<E>,
): WorkerMcpHandler<E> {
  return async (request, env) => {
    const server = new McpServer({ name: opts.name, version: opts.version });
    opts.registerTools(server, env);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: opts.sessionIdGenerator,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
