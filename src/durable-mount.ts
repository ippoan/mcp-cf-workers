/**
 * Edge wiring for a durable (DO + WebSocket) MCP server.
 *
 * `McpAgent.serve(path)` reads its props from `ctx.props` and routes the request
 * to the Durable Object identified by the `binding` env key. This module wraps
 * that with an optional `authenticate` step that runs at the edge — before the
 * DO is reached — so CF Access / binding_jwt verification gates the connection
 * and its result travels into the session as `props`.
 *
 * This file deliberately does NOT import `agents/mcp`: the agent class is passed
 * in by the caller. That keeps the wiring testable under plain Node (the agents
 * SDK pulls in `cloudflare:workers`, which only resolves under workerd).
 */

/** Transport exposed to MCP clients. Mirrors the agents SDK `ServeOptions`. */
export type DurableMcpTransport = "streamable-http" | "sse" | "auto";

/**
 * Minimal shape of the class returned by `createDurableMcp`. Only the static
 * handler factories are needed here, so tests can pass a lightweight stub.
 */
export interface DurableMcpAgentLike {
  serve(
    path: string,
    opts?: { binding?: string; transport?: DurableMcpTransport },
  ): { fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> };
  serveSSE(
    path: string,
    opts?: { binding?: string },
  ): { fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> };
}

export interface MountDurableMcpOptions<E = unknown> {
  /** The Durable Object class returned by `createDurableMcp`. */
  agent: DurableMcpAgentLike;
  /** Route the MCP endpoint is mounted at. Default `"/mcp"`. */
  path?: string;
  /** `wrangler.toml` Durable Object binding name. Default `"MCP_OBJECT"`. */
  binding?: string;
  /** Client-facing transport. Default `"streamable-http"`. */
  transport?: DurableMcpTransport;
  /**
   * Authenticate the request at the edge and return the props to attach to the
   * session (becomes `props` in `registerTools`). Throw to reject the
   * connection. Runs before the Durable Object is reached, so an auth failure
   * never spins up a DO.
   */
  authenticate?: (request: Request, env: E) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Build the rejection `Response` when `authenticate` throws.
   * Default: `401` with a JSON `{ error }` body.
   */
  onAuthError?: (err: unknown, request: Request) => Response;
}

function defaultAuthError(err: unknown): Response {
  const message = err instanceof Error ? err.message : "unauthorized";
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Returns a `(request, env, ctx) => Response` fetch handler that authenticates
 * at the edge, attaches the result as `ctx.props`, then delegates to the agent's
 * `serve` / `serveSSE` handler.
 */
export function mountDurableMcp<E = unknown>(
  opts: MountDurableMcpOptions<E>,
): (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> {
  const path = opts.path ?? "/mcp";
  const binding = opts.binding ?? "MCP_OBJECT";
  const transport = opts.transport ?? "streamable-http";

  return async (request, env, ctx) => {
    if (opts.authenticate) {
      let props: Record<string, unknown>;
      try {
        props = await opts.authenticate(request, env);
      } catch (err) {
        return (opts.onAuthError ?? defaultAuthError)(err, request);
      }
      // `ctx.props` is the agents SDK's hand-off slot: McpAgent.serve() reads it
      // and persists it as the DO's `props`. It is not part of the standard
      // ExecutionContext type, so we attach it via a narrow cast.
      (ctx as ExecutionContext & { props?: Record<string, unknown> }).props = props;
    }

    const handler =
      transport === "sse"
        ? opts.agent.serveSSE(path, { binding })
        : opts.agent.serve(path, { binding, transport });

    return handler.fetch(request, env, ctx);
  };
}
