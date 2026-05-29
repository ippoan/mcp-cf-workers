import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// `agents/mcp` imports `cloudflare:workers`, which does not resolve under Node.
// Replace it with a minimal stand-in that captures `env` and exposes a settable
// `props`, mirroring how the agents runtime drives `McpAgent`.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    env: unknown;
    props: unknown;
    constructor(_state: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { createDurableMcp } from "../src/durable";

type Env = { GREETING: string };
type Props = { scope: string };

interface DurableMcpInstance {
  server: { connect: (t: unknown) => Promise<void> };
  props?: unknown;
  init: () => Promise<void>;
}

// The runtime constructor is the mocked McpAgent (state, env). Take the class as
// `unknown` so the production `E extends Cloudflare.Env` constraint doesn't leak
// into the test's loose Env type.
function instantiate(Cls: unknown, env: unknown, props: unknown): DurableMcpInstance {
  const Ctor = Cls as new (state: unknown, env: unknown) => DurableMcpInstance;
  const instance = new Ctor({}, env);
  instance.props = props;
  return instance;
}

async function connect(instance: { server: { connect: (t: unknown) => Promise<void> } }) {
  const client = new Client({ name: "c", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("createDurableMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a class whose server advertises listChanged and exposes registered tools", async () => {
    const Cls = createDurableMcp<Env, Props>({
      name: "durable-echo",
      version: "2.0.0",
      registerTools: (server) => {
        server.registerTool(
          "echo",
          { description: "echo", inputSchema: { msg: z.string() } },
          async ({ msg }) => ({ content: [{ type: "text", text: msg }] }),
        );
      },
    });

    const instance = instantiate(Cls, { GREETING: "hi" }, { scope: "mcp.read" });
    await instance.init();

    const client = await connect(instance);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(client.getServerVersion()).toMatchObject({ name: "durable-echo", version: "2.0.0" });

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    const res = await client.callTool({ name: "echo", arguments: { msg: "yo" } });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("yo");
  });

  it("passes env and props from the instance into registerTools", async () => {
    const seen: { env?: Env; props?: Props } = {};
    const Cls = createDurableMcp<Env, Props>({
      name: "capture",
      version: "0.0.1",
      registerTools: (_server, env, props) => {
        seen.env = env;
        seen.props = props;
      },
    });

    const instance = instantiate(Cls, { GREETING: "hello" }, { scope: "mcp.write" });
    await instance.init();

    expect(seen.env).toEqual({ GREETING: "hello" });
    expect(seen.props).toEqual({ scope: "mcp.write" });
  });

  it("defaults props to {} when the instance has none", async () => {
    const seen: { props?: Props } = {};
    const Cls = createDurableMcp<Env, Props>({
      name: "no-props",
      version: "0.0.1",
      registerTools: (_server, _env, props) => {
        seen.props = props;
      },
    });

    const Ctor = Cls as unknown as new (state: unknown, env: Env) => {
      props?: Props;
      init: () => Promise<void>;
    };
    const instance = new Ctor({}, { GREETING: "x" });
    // props left undefined on purpose
    await instance.init();

    expect(seen.props).toEqual({});
  });
});
