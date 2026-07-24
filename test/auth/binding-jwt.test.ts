import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  introspectBindingJwt,
  BindingJwtError,
  wwwAuthenticate,
  DEFAULT_AUTH_WORKER_ORIGIN,
  type BindingJwtClaims,
  type BindingJwtEnv,
} from "../../src/auth/binding-jwt";
import { bindingJwtMiddleware } from "../../src/auth/binding-jwt-hono";

const env: BindingJwtEnv = { AUTH_WORKER_ORIGIN: "https://auth.test" };

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

const activeGoogleBody = {
  active: true,
  sub: "google:u1@example.com",
  email: "u1@example.com",
  scope: "mcp.read mcp.write",
  exp: 9999999999,
};

describe("introspectBindingJwt", () => {
  it("returns claims for an active token (GitHub flow)", async () => {
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

  it("returns claims for an active token (Google flow, no github_login)", async () => {
    const claims = await introspectBindingJwt("Bearer abc", env, {
      introspectFetch: respondWith(jsonResp(activeGoogleBody)),
    });
    expect(claims).toEqual({
      sub: "google:u1@example.com",
      email: "u1@example.com",
      scope: "mcp.read mcp.write",
      exp: 9999999999,
    });
  });

  it("401 invalid_request on missing / malformed / empty / wrong-scheme header", async () => {
    for (const h of [null, undefined, "", "Basic xyz", "Bearer "]) {
      const err = await introspectBindingJwt(h, env).catch((e) => e);
      expect(err).toBeInstanceOf(BindingJwtError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe("invalid_request");
    }
  });

  it("401 invalid_token when introspect responds 401", async () => {
    const err = await introspectBindingJwt("Bearer x", env, {
      introspectFetch: respondWith(jsonResp({}, 401)),
    }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.errorCode).toBe("invalid_token");
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

  it("503 when neither github_login nor email is present", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(
          jsonResp({ active: true, sub: "u", scope: "mcp.read", exp: 9999999999 }),
        ),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("401 on aud mismatch when expectedAud is set", async () => {
    await expect(
      introspectBindingJwt("Bearer x", env, {
        introspectFetch: respondWith(jsonResp({ ...activeBody, aud: "other" })),
        expectedAud: ["my-mcp"],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("passes when aud is in the allowlist", async () => {
    const claims = await introspectBindingJwt("Bearer x", env, {
      introspectFetch: respondWith(jsonResp({ ...activeBody, aud: "my-mcp" })),
      expectedAud: ["my-mcp"],
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

  it("falls back to env.AUTH_WORKER_ORIGIN then the default", async () => {
    let seenUrl = "";
    const f = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return jsonResp(activeBody);
    }) as unknown as typeof fetch;
    await introspectBindingJwt("Bearer x", {}, { introspectFetch: f });
    expect(seenUrl).toBe(`${DEFAULT_AUTH_WORKER_ORIGIN}/mcp/introspect`);
  });

  it("uses authWorkerBinding.fetch instead of the global fetch when set", async () => {
    let called = false;
    const binding = {
      fetch: (async () => {
        called = true;
        return jsonResp(activeBody);
      }) as unknown as typeof fetch,
    };
    const claims = await introspectBindingJwt("Bearer x", env, { authWorkerBinding: binding });
    expect(called).toBe(true);
    expect(claims.sub).toBe("u1");
  });

  it("introspectFetch takes precedence over authWorkerBinding when both are set", async () => {
    let bindingCalled = false;
    const binding = {
      fetch: (async () => {
        bindingCalled = true;
        return jsonResp(activeBody);
      }) as unknown as typeof fetch,
    };
    const f = respondWith(jsonResp(activeBody));
    await introspectBindingJwt("Bearer x", env, { authWorkerBinding: binding, introspectFetch: f });
    expect(bindingCalled).toBe(false);
  });

  it("authWorkerBinding takes precedence over authWorkerOrigin/env for the fetch target", async () => {
    let seenUrl = "";
    const binding = {
      fetch: (async (input: RequestInfo | URL) => {
        seenUrl = String(input);
        return jsonResp(activeBody);
      }) as unknown as typeof fetch,
    };
    await introspectBindingJwt("Bearer x", env, {
      authWorkerBinding: binding,
      authWorkerOrigin: "https://auth-staging.test",
    });
    expect(seenUrl).not.toContain("auth-staging.test");
    expect(seenUrl).toContain("/mcp/introspect");
  });

  it("propagates a 503 when authWorkerBinding.fetch rejects (fail-closed)", async () => {
    const binding = {
      fetch: (async () => {
        throw new Error("binding down");
      }) as unknown as typeof fetch,
    };
    await expect(
      introspectBindingJwt("Bearer x", env, { authWorkerBinding: binding }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("wwwAuthenticate", () => {
  it("points resource_metadata at the given slug, with error attr", () => {
    const h = wwwAuthenticate("https://auth.test", "my-mcp", "invalid_token");
    expect(h).toContain(
      'resource_metadata="https://auth.test/.well-known/oauth-protected-resource/my-mcp"',
    );
    expect(h).toContain('error="invalid_token"');
  });

  it("omits the error attribute when error is undefined", () => {
    const h = wwwAuthenticate("https://auth.test", "my-mcp");
    expect(h).not.toContain("error=");
  });
});

describe("bindingJwtMiddleware (Hono)", () => {
  function appWith(opts: Parameters<typeof bindingJwtMiddleware>[0]) {
    const app = new Hono<{ Bindings: BindingJwtEnv; Variables: { bindingJwt: BindingJwtClaims } }>();
    app.use("/mcp", bindingJwtMiddleware(opts));
    app.all("/mcp", (c) => c.json({ scope: c.get("bindingJwt").scope }));
    return app;
  }

  it("sets claims and calls next on success", async () => {
    const app = appWith({ introspectFetch: respondWith(jsonResp(activeBody)) });
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "mcp.read mcp.write" });
  });

  it("returns 401 + WWW-Authenticate on missing header", async () => {
    const app = appWith({ resourceMetadataSlug: "my-mcp" });
    const res = await app.request("/mcp", { method: "POST" }, env);
    expect(res.status).toBe(401);
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    expect(wa).toContain("resource_metadata");
    expect(wa).toContain("my-mcp");
    expect(wa).toContain('error="invalid_request"');
  });

  it("returns 401 + WWW-Authenticate (invalid_token) on aud mismatch", async () => {
    const app = appWith({
      introspectFetch: respondWith(jsonResp({ ...activeBody, aud: "other" })),
      expectedAud: ["my-mcp"],
      resourceMetadataSlug: "my-mcp",
    });
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("returns 503 (no WWW-Authenticate) when auth-worker is down", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const app = appWith({ introspectFetch: f });
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("uses the default slug 'mcp' when none is given", async () => {
    const app = appWith({});
    const res = await app.request("/mcp", { method: "POST" }, env);
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    expect(wa).toContain("/.well-known/oauth-protected-resource/mcp");
  });
});
