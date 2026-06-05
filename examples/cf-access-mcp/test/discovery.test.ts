import { describe, expect, it } from "vitest";
import { handleDiscovery } from "../src/discovery";
import type { Env } from "../src/env";

const env = { AUTH_WORKER_ORIGIN: "https://auth-staging.test" } as Env;

/** 呼ばれた URL / init を記録しつつ固定レスポンスを返す fake fetch。 */
function fakeFetch(
  status: number,
  body: string,
  contentType = "application/json",
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("handleDiscovery", () => {
  it("AS metadata を auth-staging に proxy する", async () => {
    const f = fakeFetch(200, '{"issuer":"https://auth-staging.test"}');
    const req = new Request("https://cf-access-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe("https://auth-staging.test/.well-known/oauth-authorization-server");
    expect(await res!.json()).toEqual({ issuer: "https://auth-staging.test" });
  });

  it("protected-resource metadata (slug 無し) を slug 付き upstream に proxy する", async () => {
    const f = fakeFetch(200, '{"resource":"https://cf-access-mcp.ippoan.org"}');
    const req = new Request("https://cf-access-mcp.test/.well-known/oauth-protected-resource");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.test/.well-known/oauth-protected-resource/cf-access-mcp",
    );
  });

  it("protected-resource metadata (slug 付き) も受ける", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request(
      "https://cf-access-mcp.test/.well-known/oauth-protected-resource/cf-access-mcp",
    );
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.test/.well-known/oauth-protected-resource/cf-access-mcp",
    );
  });

  it("POST /register を auth-staging/mcp/register に body 透過 proxy する", async () => {
    const f = fakeFetch(201, '{"client_id":"abc"}');
    const req = new Request("https://cf-access-mcp.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}',
    });
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(201);
    expect(f.calls[0]!.url).toBe("https://auth-staging.test/mcp/register");
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(String(f.calls[0]!.init?.body)).toContain("redirect_uris");
    expect(await res!.json()).toEqual({ client_id: "abc" });
  });

  it("upstream の status / content-type を透過する (404 もそのまま)", async () => {
    const f = fakeFetch(404, "nope", "text/plain");
    const req = new Request("https://cf-access-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(404);
    expect(res!.headers.get("Content-Type")).toBe("text/plain");
  });

  it("CORS header は付けない (稼働サーバーと parity)", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request("https://cf-access-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("discovery 対象外の path は null (通常 routing に委譲)", async () => {
    const f = fakeFetch(200, "{}");
    for (const [method, path] of [
      ["GET", "/mcp"],
      ["GET", "/healthz"],
      ["GET", "/register"], // GET /register は DCR ではない
      ["POST", "/.well-known/oauth-authorization-server"], // POST は対象外
      ["GET", "/.well-known/unknown"],
    ] as const) {
      const req = new Request(`https://cf-access-mcp.test${path}`, { method });
      const res = await handleDiscovery(req, env, f.fetch);
      expect(res, `${method} ${path}`).toBeNull();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("AUTH_WORKER_ORIGIN 未設定なら staging default を使う", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request("https://cf-access-mcp.test/.well-known/oauth-authorization-server");
    await handleDiscovery(req, {} as Env, f.fetch);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.ippoan.org/.well-known/oauth-authorization-server",
    );
  });
});
