import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from "jose";
import { cfAccessMiddleware } from "../../src/auth/cf-access-hono";
import type { CfAccessClaims } from "../../src/auth/cf-access";

const TEAM = "example.cloudflareaccess.com";
const AUD = "test-aud-tag";

type Env = { CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string };

async function buildApp(jwksOverride?: ReturnType<typeof createLocalJWKSet>) {
  const app = new Hono<{ Bindings: Env; Variables: { cfAccess: CfAccessClaims } }>();
  app.use("*", cfAccessMiddleware(jwksOverride ? { jwksOverride } : undefined));
  app.get("/whoami", (c) => c.json({ sub: c.get("cfAccess").sub }));
  return app;
}

async function setupKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = "test-kid";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return { privateKey, jwks };
}

async function signToken(privateKey: CryptoKey): Promise<string> {
  return await new SignJWT({ sub: "user-xyz" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("cfAccessMiddleware", () => {
  it("returns 401 when JWT header is missing", async () => {
    const { jwks } = await setupKeys();
    const app = await buildApp(jwks);
    const res = await app.request("/whoami", {}, {
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 and exposes claims when JWT is valid", async () => {
    const { privateKey, jwks } = await setupKeys();
    const app = await buildApp(jwks);
    const token = await signToken(privateKey);
    const res = await app.request(
      "/whoami",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "user-xyz" });
  });

  it("returns 500 when env is misconfigured", async () => {
    const { jwks } = await setupKeys();
    const app = await buildApp(jwks);
    const res = await app.request("/whoami", {}, {
      CF_ACCESS_TEAM_DOMAIN: "",
      CF_ACCESS_AUD: "",
    });
    expect(res.status).toBe(500);
  });
});
