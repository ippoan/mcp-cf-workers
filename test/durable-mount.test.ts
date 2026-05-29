import { describe, it, expect, vi } from "vitest";
import { mountDurableMcp, type DurableMcpAgentLike } from "../src/durable-mount";

type Env = { SECRET: string };

function makeAgentStub() {
  const calls: {
    serve: Array<{ path: string; opts?: unknown }>;
    serveSSE: Array<{ path: string; opts?: unknown }>;
    ctxProps: unknown;
    env: unknown;
  } = { serve: [], serveSSE: [], ctxProps: undefined, env: undefined };

  const handler = (kind: "serve" | "serveSSE") => ({
    fetch: vi.fn(async (_request: Request, env: unknown, ctx: ExecutionContext) => {
      calls.env = env;
      calls.ctxProps = (ctx as { props?: unknown }).props;
      return new Response(`ok:${kind}`, { status: 200 });
    }),
  });

  const agent: DurableMcpAgentLike = {
    serve: vi.fn((path, opts) => {
      calls.serve.push({ path, opts });
      return handler("serve");
    }),
    serveSSE: vi.fn((path, opts) => {
      calls.serveSSE.push({ path, opts });
      return handler("serveSSE");
    }),
  };

  return { agent, calls };
}

const ctx = {} as ExecutionContext;
const req = () => new Request("https://example.com/mcp", { method: "POST" });

describe("mountDurableMcp", () => {
  it("defaults path=/mcp, binding=MCP_OBJECT, transport=streamable-http", async () => {
    const { agent, calls } = makeAgentStub();
    const handler = mountDurableMcp<Env>({ agent });

    const res = await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:serve");
    expect(calls.serve[0]).toEqual({
      path: "/mcp",
      opts: { binding: "MCP_OBJECT", transport: "streamable-http" },
    });
    expect(calls.serveSSE).toHaveLength(0);
  });

  it("honors custom path / binding / transport", async () => {
    const { agent, calls } = makeAgentStub();
    const handler = mountDurableMcp<Env>({
      agent,
      path: "/rpc",
      binding: "MY_DO",
      transport: "auto",
    });

    await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(calls.serve[0]).toEqual({
      path: "/rpc",
      opts: { binding: "MY_DO", transport: "auto" },
    });
  });

  it("routes to serveSSE when transport=sse", async () => {
    const { agent, calls } = makeAgentStub();
    const handler = mountDurableMcp<Env>({ agent, transport: "sse" });

    const res = await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(await res.text()).toBe("ok:serveSSE");
    expect(calls.serveSSE[0]).toEqual({ path: "/mcp", opts: { binding: "MCP_OBJECT" } });
    expect(calls.serve).toHaveLength(0);
  });

  it("attaches authenticate() result to ctx.props and passes env through", async () => {
    const { agent, calls } = makeAgentStub();
    const authenticate = vi.fn(async (_request: Request, env: Env) => ({
      scope: "mcp.write",
      secret: env.SECRET,
    }));
    const handler = mountDurableMcp<Env>({ agent, authenticate });

    const localCtx = {} as ExecutionContext;
    await handler(req(), { SECRET: "abc" }, localCtx);

    expect(authenticate).toHaveBeenCalledOnce();
    expect(calls.ctxProps).toEqual({ scope: "mcp.write", secret: "abc" });
    expect(calls.env).toEqual({ SECRET: "abc" });
  });

  it("does not touch ctx.props when no authenticate is given", async () => {
    const { agent, calls } = makeAgentStub();
    const handler = mountDurableMcp<Env>({ agent });

    await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(calls.ctxProps).toBeUndefined();
  });

  it("returns default 401 JSON and skips the agent when authenticate throws", async () => {
    const { agent, calls } = makeAgentStub();
    const handler = mountDurableMcp<Env>({
      agent,
      authenticate: () => {
        throw new Error("bad jwt");
      },
    });

    const res = await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "bad jwt" });
    expect(agent.serve).not.toHaveBeenCalled();
    expect(agent.serveSSE).not.toHaveBeenCalled();
    expect(calls.serve).toHaveLength(0);
  });

  it("uses a generic 401 message for non-Error throws", async () => {
    const { agent } = makeAgentStub();
    const handler = mountDurableMcp<Env>({
      agent,
      authenticate: () => {
        throw "nope";
      },
    });

    const res = await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("uses a custom onAuthError when provided", async () => {
    const { agent } = makeAgentStub();
    const handler = mountDurableMcp<Env>({
      agent,
      authenticate: () => {
        throw new Error("denied");
      },
      onAuthError: (err) =>
        new Response((err as Error).message, { status: 403 }),
    });

    const res = await handler(req(), { SECRET: "s" }, {} as ExecutionContext);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("denied");
  });
});

void ctx;
