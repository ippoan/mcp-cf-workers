/**
 * Phase 0 PoC — echo MCP server over Durable Object + WebSocket (hibernatable).
 *
 * Purpose: verify the #6 / secrets-inventory#70 hard gate on real infra —
 * "deploy → WS drop → Claude Code auto-reconnects → tools/list re-fetched".
 * See README.md in this directory for the step-by-step runbook.
 *
 * This worker is intentionally tiny: it imports the lib's durable building
 * blocks and registers two tools — a plain `echo`, and `bump_version` which
 * mutates the tool-set at runtime and pushes `notifications/tools/list_changed`
 * to prove the listChanged path works without a reconnect.
 */
import { z } from "zod";
import { createDurableMcp, mountDurableMcp } from "@ippoan/mcp-cf-workers/durable";

export interface Env {
  // Durable Object binding (see wrangler.toml). The agents SDK looks this up by
  // name; the default expected by mountDurableMcp is `MCP_OBJECT`.
  MCP_OBJECT: DurableObjectNamespace;
  // Bump this (or just redeploy) to observe the deploy → reconnect behavior.
  BUILD_TAG?: string;
}

// Tracks runtime tool-set mutations within a single live DO instance.
let extraToolRegistered = false;

export const EchoMcp = createDurableMcp<Env>({
  name: "echo-do-ws",
  version: "0.1.0",
  registerTools(server, env) {
    server.registerTool(
      "echo",
      {
        description: "Echo back the supplied message.",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `${env.BUILD_TAG ?? "dev"}: ${message}` }],
      }),
    );

    server.registerTool(
      "bump_version",
      {
        description:
          "Register an extra tool at runtime and push notifications/tools/list_changed. " +
          "Use this to confirm the client re-fetches tools/list WITHOUT reconnecting.",
        inputSchema: {},
      },
      async () => {
        if (!extraToolRegistered) {
          server.registerTool(
            "echo_v2",
            {
              description: "Runtime-added echo (proves listChanged push).",
              inputSchema: { message: z.string(), shout: z.boolean().optional() },
            },
            async ({ message, shout }) => ({
              content: [{ type: "text", text: shout ? message.toUpperCase() : message }],
            }),
          );
          extraToolRegistered = true;
        }
        // McpServer pushes notifications/tools/list_changed to connected clients.
        server.sendToolListChanged();
        return { content: [{ type: "text", text: "registered echo_v2; pushed list_changed" }] };
      },
    );
  },
});

export default {
  fetch: mountDurableMcp<Env>({
    agent: EchoMcp,
    path: "/mcp",
    // PoC: no auth. Real consumers pass `authenticate` to verify CF Access /
    // binding_jwt and return scope props (see secrets-inventory migration).
  }),
};
