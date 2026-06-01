import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { mcpJwtMiddleware } from "../../src/auth/mcp-jwt-hono";
import type { McpJwtClaims } from "../../src/auth/mcp-jwt";

const SECRET = "test-shared-secret-at-least-32-bytes-long!!";
const AUD = "ref-files-mcp-server-rs";

type Env = { MCP_JWT_SECRET: string; MCP_JWT_AUDIENCE: string };

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: { mcpJwt: McpJwtClaims } }>();
  app.use("*", mcpJwtMiddleware());
  app.get("/whoami", (c) =>
    c.json({ sub: c.get("mcpJwt").sub, login: c.get("mcpJwt").github_login }),
  );
  return app;
}

async function sign(): Promise<string> {
  return await new SignJWT({
    sub: "github:yhonda-ohishi",
    github_login: "yhonda-ohishi",
    scope: "mcp.read mcp.write",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

const env: Env = { MCP_JWT_SECRET: SECRET, MCP_JWT_AUDIENCE: AUD };

describe("mcpJwtMiddleware", () => {
  it("returns 401 when the bearer is missing", async () => {
    const res = await buildApp().request("/whoami", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized", reason: "missing_bearer" });
  });

  it("returns 200 and exposes claims when the JWT is valid", async () => {
    const res = await buildApp().request(
      "/whoami",
      { headers: { Authorization: `Bearer ${await sign()}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "github:yhonda-ohishi", login: "yhonda-ohishi" });
  });

  it("returns 401 with a coarse reason on a bad signature", async () => {
    const bad = await new SignJWT({ sub: "x", github_login: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("wrong-secret-wrong-secret-wrong!!"));
    const res = await buildApp().request(
      "/whoami",
      { headers: { Authorization: `Bearer ${bad}` } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "signature" });
  });

  it("returns 500 when env is misconfigured", async () => {
    const res = await buildApp().request("/whoami", {}, {
      MCP_JWT_SECRET: "",
      MCP_JWT_AUDIENCE: "",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_misconfigured" });
  });
});
