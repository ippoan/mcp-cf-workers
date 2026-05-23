import { describe, it, expect, beforeEach } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK } from "jose";
import {
  verifyCfAccessJwt,
  CfAccessError,
  _resetJwksCacheForTests,
} from "../../src/auth/cf-access";

const TEAM = "example.cloudflareaccess.com";
const AUD = "test-aud-tag";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = "test-kid";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return { privateKey, jwks };
}

async function signToken(
  privateKey: CryptoKey,
  opts: { aud?: string; iss?: string; sub?: string } = {},
): Promise<string> {
  return await new SignJWT({ sub: opts.sub ?? "user-123", email: "u@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
}

function reqWith(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request("http://example.com/", { headers });
}

beforeEach(() => _resetJwksCacheForTests());

describe("verifyCfAccessJwt", () => {
  it("verifies a valid token and returns claims", async () => {
    const { privateKey, jwks } = await setup();
    const token = await signToken(privateKey);
    const claims = await verifyCfAccessJwt(reqWith(token), {
      teamDomain: TEAM,
      audience: AUD,
      jwksOverride: jwks,
    });
    expect(claims.sub).toBe("user-123");
    expect(claims.email).toBe("u@example.com");
  });

  it("throws CfAccessError when header is missing", async () => {
    const { jwks } = await setup();
    await expect(
      verifyCfAccessJwt(reqWith(null), {
        teamDomain: TEAM,
        audience: AUD,
        jwksOverride: jwks,
      }),
    ).rejects.toBeInstanceOf(CfAccessError);
  });

  it("rejects audience mismatch", async () => {
    const { privateKey, jwks } = await setup();
    const token = await signToken(privateKey, { aud: "other-aud" });
    await expect(
      verifyCfAccessJwt(reqWith(token), {
        teamDomain: TEAM,
        audience: AUD,
        jwksOverride: jwks,
      }),
    ).rejects.toThrow();
  });

  it("rejects issuer mismatch", async () => {
    const { privateKey, jwks } = await setup();
    const token = await signToken(privateKey, { iss: "https://evil.example.com" });
    await expect(
      verifyCfAccessJwt(reqWith(token), {
        teamDomain: TEAM,
        audience: AUD,
        jwksOverride: jwks,
      }),
    ).rejects.toThrow();
  });
});
