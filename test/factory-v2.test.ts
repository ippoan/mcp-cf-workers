import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createWorkerMcpV2 } from "../src/factory-v2";

type Env = { GREETING: string };

function jsonRpcRequest(body: unknown): Request {
  return new Request("http://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

/**
 * SDK v2's handler answers either as plain JSON or as a single-event SSE
 * stream depending on negotiation; accept both.
 */
async function readRpc(res: Response): Promise<any> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`no data line in SSE body: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function makeHandler(handlerOptions?: Parameters<typeof createWorkerMcpV2>[0]["handlerOptions"]) {
  return createWorkerMcpV2<Env>({
    name: "test-server",
    version: "0.0.1",
    registerTools: (server, env) => {
      server.registerTool(
        "greet",
        {
          description: "greet by name",
          inputSchema: z.object({ name: z.string() }),
        },
        async ({ name }) => ({
          content: [{ type: "text", text: `${env.GREETING}, ${name}` }],
        }),
      );
    },
    handlerOptions,
  });
}

describe("createWorkerMcpV2", () => {
  it("registers tools and serves tools/list", async () => {
    const handler = makeHandler();
    const res = await handler(
      jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      { GREETING: "hi" },
    );

    expect(res.status).toBe(200);
    const body = await readRpc(res);
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("greet");
  });

  it("invokes the registered tool with env via tools/call", async () => {
    const handler = makeHandler();
    const res = await handler(
      jsonRpcRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "greet", arguments: { name: "world" } },
      }),
      { GREETING: "hello" },
    );

    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect(body.result?.content?.[0]?.text).toBe("hello, world");
  });

  it("serves legacy (2025-06-18) clients: initialize completes by default", async () => {
    const handler = makeHandler();
    const res = await handler(
      jsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.1" },
        },
      }),
      { GREETING: "hi" },
    );

    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect(body.result?.protocolVersion).toBe("2025-06-18");
    expect(body.result?.serverInfo?.name).toBe("test-server");
  });

  it("rejects legacy clients under legacy: 'reject'", async () => {
    const handler = makeHandler({ legacy: "reject" });
    const res = await handler(
      jsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.1" },
        },
      }),
      { GREETING: "hi" },
    );

    expect(res.status).toBe(400);
    const body = await readRpc(res);
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toContain("2026-07-28");
  });

  it("rebuilds the memoized handler when a different env object arrives", async () => {
    const handler = makeHandler();
    const call = (env: Env) =>
      handler(
        jsonRpcRequest({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "x" } },
        }),
        env,
      );

    const first = await readRpc(await call({ GREETING: "hi" }));
    expect(first.result?.content?.[0]?.text).toBe("hi, x");

    const second = await readRpc(await call({ GREETING: "yo" }));
    expect(second.result?.content?.[0]?.text).toBe("yo, x");
  });
});
