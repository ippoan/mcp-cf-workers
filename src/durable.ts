import { McpAgent } from "agents/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  newDurableMcpServer,
  type CreateDurableMcpOptions,
} from "./durable-server";

export {
  DURABLE_MCP_CAPABILITIES,
  newDurableMcpServer,
  buildDurableMcpServer,
} from "./durable-server";
export type { CreateDurableMcpOptions } from "./durable-server";

export {
  mountDurableMcp,
} from "./durable-mount";
export type {
  MountDurableMcpOptions,
  DurableMcpAgentLike,
  DurableMcpTransport,
} from "./durable-mount";

/**
 * Constructor type of the Durable Object class returned by
 * {@link createDurableMcp}. Consumers `export` this and reference it from
 * `wrangler.toml` (`durable_objects.bindings` + a `new_sqlite_classes`
 * migration).
 */
export type DurableMcpClass<
  E extends Cloudflare.Env = Cloudflare.Env,
  P extends Record<string, unknown> = Record<string, unknown>,
> = {
  new (state: DurableObjectState, env: E): McpAgent<E, unknown, P>;
} & Pick<typeof McpAgent, "serve" | "serveSSE" | "mount">;

/**
 * Build a Durable Object class (subclass of the agents SDK `McpAgent`) that
 * serves a stateful MCP session over DO + WebSocket (hibernatable).
 *
 * Why DO + WebSocket: the stateless {@link createWorkerMcp} freezes a client's
 * `tools/list` for the life of the session — a deploy that changes the tool-set
 * is invisible until the client reconnects (ippoan/secrets-inventory#70). With a
 * DO-backed WebSocket, a deploy drops the connection, the client auto-reconnects
 * and re-runs `initialize` / `tools/list`, and runtime tool changes can be
 * pushed live via `notifications/tools/list_changed` (advertised through
 * {@link DURABLE_MCP_CAPABILITIES}).
 *
 * Pair this with {@link mountDurableMcp} for the edge fetch handler + auth.
 *
 * @example
 * ```ts
 * export const EchoMcp = createDurableMcp<Env>({
 *   name: "echo",
 *   version: "1.0.0",
 *   registerTools(server) {
 *     server.registerTool("echo", { inputSchema: { msg: z.string() } },
 *       async ({ msg }) => ({ content: [{ type: "text", text: msg }] }));
 *   },
 * });
 *
 * export default {
 *   fetch: mountDurableMcp<Env>({ agent: EchoMcp, path: "/mcp" }),
 * };
 * ```
 */
export function createDurableMcp<
  E extends Cloudflare.Env = Cloudflare.Env,
  P extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateDurableMcpOptions<E, P>): DurableMcpClass<E, P> {
  class DurableMcp extends McpAgent<E, unknown, P> {
    // Field initializer mirrors `buildDurableMcpServer`: same capabilities,
    // tools registered later in init(). `McpAgent.server` accepts a MaybePromise
    // but a ready instance is fine.
    server: McpServer = newDurableMcpServer(opts);

    async init(): Promise<void> {
      await opts.registerTools(this.server, this.env, (this.props ?? {}) as P);
    }
  }

  return DurableMcp as unknown as DurableMcpClass<E, P>;
}
