import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createWorkerMcp } from "../src/factory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  // streamable HTTP may return either JSON or SSE depending on negotiation;
  // with enableJsonResponse=true + accept: application/json we get JSON.
  return JSON.parse(text);
}

describe("createWorkerMcp", () => {
  it("registers tools and serves tools/list", async () => {
    const handler = createWorkerMcp<Env>({
      name: "test-server",
      version: "0.0.1",
      registerTools: (server) => {
        server.registerTool(
          "echo",
          {
            description: "echo back",
            inputSchema: { message: z.string() },
          },
          async ({ message }) => ({
            content: [{ type: "text", text: message }],
          }),
        );
      },
    });

    const res = await handler(
      jsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      { GREETING: "hi" },
    );

    expect(res.status).toBe(200);
    const body = await readJson(res);
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain("echo");
  });

  it("invokes the registered tool via tools/call", async () => {
    const handler = createWorkerMcp<Env>({
      name: "test-server",
      version: "0.0.1",
      registerTools: (server, env) => {
        server.registerTool(
          "greet",
          {
            description: "greet by name",
            inputSchema: { name: z.string() },
          },
          async ({ name }) => ({
            content: [{ type: "text", text: `${env.GREETING}, ${name}` }],
          }),
        );
      },
    });

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
    const body = await readJson(res);
    const text = body.result?.content?.[0]?.text;
    expect(text).toBe("hello, world");
  });

  it("returns a JSON-RPC error for malformed body", async () => {
    const handler = createWorkerMcp<Env>({
      name: "test-server",
      version: "0.0.1",
      registerTools: () => {},
    });

    const res = await handler(
      new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "not-json{{{",
      }),
      { GREETING: "hi" },
    );

    // Either an HTTP-level 4xx or a JSON-RPC parse-error envelope is acceptable.
    if (res.status >= 400 && res.status < 500) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    } else {
      const body = await readJson(res);
      expect(body.error).toBeDefined();
    }
  });

  it("closes McpServer + transport on each request (no retain)", async () => {
    const captured: { server?: McpServer } = {};
    const handler = createWorkerMcp<Env>({
      name: "test-server",
      version: "0.0.1",
      registerTools: (server) => {
        captured.server = server;
        const closeSpy = vi.spyOn(server, "close");
        (captured as any).closeSpy = closeSpy;
        server.registerTool(
          "noop",
          { description: "noop", inputSchema: {} },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
      },
    });

    await handler(
      jsonRpcRequest({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      { GREETING: "hi" },
    );

    expect((captured as any).closeSpy).toHaveBeenCalled();
  });
});
