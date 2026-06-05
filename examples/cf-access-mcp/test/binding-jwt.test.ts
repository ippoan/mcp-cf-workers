import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  introspectBindingJwt,
  bindingJwtMiddleware,
  BindingJwtError,
  wwwAuthenticate,
  type BindingJwtClaims,
} from "../src/middleware/binding-jwt";
import type { Env } from "../src/env";

const env = { AUTH_WORKER_ORIGIN: "https://auth.test" } as unknown as Env;

/** 固定 Response を返す fetch fake。 */
function respondWith(resp: Response): typeof fetch {
  return (async () => resp) as unknown as typeof fetch;
}
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const activeBody = {
  active: true,
  sub: "u1",
  github_login: "octocat",
  scope: "mcp.read mcp.write",
  exp: 9999999999,
};

describe("introspectBindingJwt", () => {
  it("returns claims for an active token", async () => {
    const claims = await introspectBindingJwt("Bearer abc", env, {
      introspectFetch: respondWith(jsonResp(activeBody)),
    });
    expect(claims).toEqual({
      sub: "u1",
      github_login: "octocat",
      scope: "mcp.read mcp.write",
      exp: 9999999999,
    });
  });

  it("401 on missing / malformed / empty / wrong-scheme header", async () => {
    // Bearer 不在/不正は `error="invalid_request"` (= request 形式の問題)。
    // 動いている ref-files-worker の実 wire と一致させる (Refs #26)。
    // token が「あるが無効」な場合だけ invalid_token (下の active:false テスト)。
    for (const h of [null, undefined, "", "Basic xyz", "Bearer "]) {
      const err = await introspectBindingJwt(h, env).catch((e) => e);
      expect(err).toBeInstanceOf(BindingJwtError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe("invalid_request");
    }
  });

  it("401 when introspect responds 401", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, { introspectFetch: respondWith(jsonResp({}, 401)) }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("503 when introspect responds 503", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, { introspectFetch: respondWith(jsonResp({}, 503)) }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("503 on other non-ok status (fail-closed)", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, { introspectFetch: respondWith(jsonResp({}, 500)) }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("503 on non-JSON body", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(new Response("oops", { status: 200 })),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("503 when fetch itself rejects", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(
      introspectBindingJwt("Bearer x", env, { introspectFetch: f }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("401 when token not active", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(jsonResp({ active: false })),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("503 when required claims are missing", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(jsonResp({ active: true, sub: "u" })),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("401 on aud mismatch when expectedAud is set", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(jsonResp({ ...activeBody, aud: "other" })),
        expectedAud: ["cf-access-mcp"],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("passes when aud is in the allowlist", async () => {
    const claims = await introspectBindingJwt("Bearer x", env, {
      introspectFetch: respondWith(jsonResp({ ...activeBody, aud: "cf-access-mcp" })),
      expectedAud: ["cf-access-mcp"],
    });
    expect(claims.sub).toBe("u1");
  });

  it("uses authWorkerOrigin override for the introspect URL", async () => {
    let seenUrl = "";
    const f = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return jsonResp(activeBody);
    }) as unknown as typeof fetch;
    await introspectBindingJwt("Bearer x", env, {
      introspectFetch: f,
      authWorkerOrigin: "https://auth-staging.test",
    });
    expect(seenUrl).toBe("https://auth-staging.test/mcp/introspect");
  });
});

describe("wwwAuthenticate", () => {
  it("points resource_metadata at the cf-access-mcp slug", () => {
    const h = wwwAuthenticate("https://auth.test", "invalid_token");
    expect(h).toContain(
      'resource_metadata="https://auth.test/.well-known/oauth-protected-resource/cf-access-mcp"',
    );
    expect(h).toContain('error="invalid_token"');
  });
});

describe("bindingJwtMiddleware (Hono)", () => {
  function appWith(opts: Parameters<typeof bindingJwtMiddleware>[0]) {
    const app = new Hono<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>();
    app.use("/mcp", bindingJwtMiddleware(opts));
    app.all("/mcp", (c) => c.json({ scope: c.get("bindingJwt").scope }));
    return app;
  }

  it("sets claims and calls next on success", async () => {
    const app = appWith({ introspectFetch: respondWith(jsonResp(activeBody)) });
    const res = await app.request("/mcp", { method: "POST", headers: { Authorization: "Bearer x" } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "mcp.read mcp.write" });
  });

  it("returns 401 + WWW-Authenticate on missing header", async () => {
    const app = appWith({});
    const res = await app.request("/mcp", { method: "POST" }, env);
    expect(res.status).toBe(401);
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    expect(wa).toContain("resource_metadata");
    expect(wa).toContain("cf-access-mcp");
    // parity lock: ref-files-worker と同じく Bearer 不在は error="invalid_request"。
    expect(wa).toContain('error="invalid_request"');
  });

  it("returns 503 (no WWW-Authenticate) when auth-worker is down", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const app = appWith({ introspectFetch: f });
    const res = await app.request("/mcp", { method: "POST", headers: { Authorization: "Bearer x" } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
