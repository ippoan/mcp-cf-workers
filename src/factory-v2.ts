import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type {
  CreateMcpHandlerOptions,
  McpHandlerRequestOptions,
  McpHttpHandler,
  McpRequestContext,
} from "@modelcontextprotocol/server";

/**
 * MCP 2026-07-28 ("modern era") factory built on SDK v2
 * (`@modelcontextprotocol/server`), the successor of {@link ./factory}'s
 * v1-SDK `createWorkerMcp`. Both live side by side so consumers migrate one
 * at a time (Refs ippoan/mcp-cf-workers#66).
 *
 * `createMcpHandler` serves both protocol eras from the same factory: modern
 * (2026-07-28, `_meta` envelope) requests natively, and legacy (2024-10-07 …
 * 2025-11-25, `initialize` handshake) requests through its built-in stateless
 * fallback — the same per-request/no-session posture v1 `createWorkerMcp`
 * always had, so existing claude.ai connectors keep working unchanged.
 *
 * Migration notes for consumers coming from v1:
 * - `registerTool`'s `inputSchema` is a Standard Schema value in SDK v2:
 *   pass `z.object({ ... })`, not the bare `{ ... }` raw shape.
 * - The returned handler takes an optional third argument
 *   (`{ authInfo, parsedBody }`); pass the binding-jwt verification result
 *   as `authInfo` to read it back in tool handlers via `ctx.http.authInfo`.
 */
export interface CreateWorkerMcpV2Options<E = unknown> {
  name: string;
  version: string;
  /**
   * Called once per request with a fresh `McpServer`. Register tools with
   * `server.registerTool(name, opts, handler)` from SDK v2.
   *
   * `ctx` is the SDK's request context (`era`, `authInfo`, `requestInfo`) —
   * `era` tells whether this instance serves a modern or legacy request.
   */
  registerTools: (server: McpServer, env: E, ctx: McpRequestContext) => void | Promise<void>;
  /**
   * Passed through to `createMcpHandler` verbatim. Notables:
   * - `legacy`: `'stateless'` (default) serves 2025-era clients per-request
   *   with no session; `'reject'` makes the endpoint 2026-07-28-only.
   * - `responseMode`: `'auto'` (default) | `'json'` | `'sse'`.
   */
  handlerOptions?: CreateMcpHandlerOptions;
}

export type WorkerMcpV2Handler<E = unknown> = (
  request: Request,
  env: E,
  requestOptions?: McpHandlerRequestOptions,
) => Promise<Response>;

/**
 * Returns a `(request, env, requestOptions?) => Response` function ready to
 * mount on any Workers entry point, same shape as v1 `createWorkerMcp` plus
 * the optional `requestOptions` pass-through.
 *
 * Unlike v1 (one transport per request), SDK v2's `createMcpHandler` is
 * designed to be constructed once and reused — its factory already runs once
 * per request. Workers hands the same `env` object to every fetch in an
 * isolate, so the handler is memoized on `env` identity: built on first
 * request, rebuilt only if a different `env` object shows up (test suites).
 * Interleaving requests with distinct `env` objects would thrash the memo —
 * don't do that outside tests.
 */
export function createWorkerMcpV2<E = unknown>(
  opts: CreateWorkerMcpV2Options<E>,
): WorkerMcpV2Handler<E> {
  let handler: McpHttpHandler | undefined;
  let boundEnv: E | undefined;

  return (request, env, requestOptions) => {
    if (handler === undefined || boundEnv !== env) {
      boundEnv = env;
      handler = createMcpHandler(async (ctx) => {
        const server = new McpServer({ name: opts.name, version: opts.version });
        await opts.registerTools(server, env, ctx);
        return server;
      }, opts.handlerOptions);
    }
    return handler.fetch(request, requestOptions);
  };
}
