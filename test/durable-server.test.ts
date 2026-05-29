import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DURABLE_MCP_CAPABILITIES,
  newDurableMcpServer,
  buildDurableMcpServer,
} from "../src/durable-server";

type Env = { GREETING: string };
type Props = { scope: string };

async function connectClient(server: Awaited<ReturnType<typeof buildDurableMcpServer>>) {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("DURABLE_MCP_CAPABILITIES", () => {
  it("advertises tools.listChanged = true", () => {
    expect(DURABLE_MCP_CAPABILITIES).toEqual({ tools: { listChanged: true } });
  });
});

describe("newDurableMcpServer", () => {
  it("builds an McpServer advertising listChanged before any tool is registered", async () => {
    // A high-level McpServer only wires the tools/list handler once a tool is
    // registered, but the listChanged capability is declared up-front via the
    // constructor option — so it shows in `initialize` regardless.
    const server = newDurableMcpServer<Env, Props>({
      name: "bare",
      version: "9.9.9",
      registerTools: () => {},
    });
    const client = await connectClient(server);

    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(client.getServerVersion()).toMatchObject({ name: "bare", version: "9.9.9" });
  });
});

describe("buildDurableMcpServer", () => {
  it("registers tools and passes env + props through", async () => {
    const seen: { env?: Env; props?: Props } = {};
    const server = await buildDurableMcpServer<Env, Props>(
      {
        name: "greeter",
        version: "1.2.3",
        registerTools: (s, env, props) => {
          seen.env = env;
          seen.props = props;
          s.registerTool(
            "greet",
            { description: "greet", inputSchema: { name: z.string() } },
            async ({ name }) => ({ content: [{ type: "text", text: `${env.GREETING}, ${name}` }] }),
          );
        },
      },
      { GREETING: "hi" },
      { scope: "mcp.read" },
    );

    expect(seen.env).toEqual({ GREETING: "hi" });
    expect(seen.props).toEqual({ scope: "mcp.read" });

    const client = await connectClient(server);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("greet");

    const result = await client.callTool({ name: "greet", arguments: { name: "world" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("hi, world");
  });

  it("awaits async registerTools", async () => {
    const server = await buildDurableMcpServer<Env, Props>(
      {
        name: "async",
        version: "0.0.1",
        registerTools: async (s) => {
          await Promise.resolve();
          s.registerTool(
            "ping",
            { description: "ping", inputSchema: {} },
            async () => ({ content: [{ type: "text", text: "pong" }] }),
          );
        },
      },
      { GREETING: "x" },
      { scope: "" },
    );

    const client = await connectClient(server);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
  });
});
