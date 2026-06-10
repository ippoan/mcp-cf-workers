import { describe, it, expect } from "vitest";
import { verifyHs256Jwt, Hs256JwtError } from "../../src/auth/hs256-jwt";
import { bytesToB64url, stringToB64url } from "../../src/auth/crypto";

const SECRET = "test-shared-secret-at-least-32-bytes-long!!";

async function hmac(input: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
}

/** Mint a compact HS256 JWT with the given payload + header alg. */
async function sign(
  payload: Record<string, unknown>,
  opts: { alg?: string; secret?: string } = {},
): Promise<string> {
  const header = stringToB64url(JSON.stringify({ alg: opts.alg ?? "HS256", typ: "JWT" }));
  const body = stringToB64url(JSON.stringify(payload));
  const sig = bytesToB64url(await hmac(`${header}.${body}`, opts.secret ?? SECRET));
  return `${header}.${body}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);

describe("verifyHs256Jwt", () => {
  it("verifies a valid token and returns generic claims", async () => {
    type Claims = { email: string; tenant_id: string; exp: number };
    const token = await sign({ email: "a@b.com", tenant_id: "t1", exp: now() + 300 });
    const claims = await verifyHs256Jwt<Claims & { exp: number }>(token, SECRET);
    expect(claims.email).toBe("a@b.com");
    expect(claims.tenant_id).toBe("t1");
  });

  it("rejects empty secret", async () => {
    const token = await sign({ exp: now() + 300 });
    await expect(verifyHs256Jwt(token, "")).rejects.toMatchObject({ reason: "no_secret" });
  });

  it("rejects a malformed (non-3-part) token", async () => {
    await expect(verifyHs256Jwt("not-a-jwt", SECRET)).rejects.toMatchObject({ reason: "shape" });
  });

  it("rejects a non-HS256 alg", async () => {
    const token = await sign({ exp: now() + 300 }, { alg: "HS512" });
    await expect(verifyHs256Jwt(token, SECRET)).rejects.toMatchObject({ reason: "alg" });
  });

  it("rejects a bad signature (wrong secret)", async () => {
    const token = await sign({ exp: now() + 300 }, { secret: "a-totally-different-secret-value-xx" });
    await expect(verifyHs256Jwt(token, SECRET)).rejects.toMatchObject({ reason: "signature" });
  });

  it("rejects an expired token", async () => {
    const token = await sign({ exp: now() - 120 });
    await expect(
      verifyHs256Jwt(token, SECRET, { clockToleranceSec: 0 }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a token with no exp", async () => {
    const token = await sign({ email: "x@y.com" });
    await expect(verifyHs256Jwt(token, SECRET)).rejects.toMatchObject({ reason: "expired" });
  });

  it("honours clock skew for exp", async () => {
    // exp 10s in the past, default 30s skew → still valid.
    const token = await sign({ exp: now() - 10 });
    await expect(verifyHs256Jwt(token, SECRET)).resolves.toMatchObject({ exp: expect.any(Number) });
  });

  it("rejects a not-yet-valid token (nbf in future, skew 0)", async () => {
    const token = await sign({ exp: now() + 300, nbf: now() + 60 });
    await expect(
      verifyHs256Jwt(token, SECRET, { clockToleranceSec: 0 }),
    ).rejects.toMatchObject({ reason: "not_yet_valid" });
  });

  it("checks aud allowlist when audience is set", async () => {
    const token = await sign({ exp: now() + 300, aud: "other" });
    await expect(
      verifyHs256Jwt(token, SECRET, { audience: ["my-mcp"] }),
    ).rejects.toMatchObject({ reason: "audience" });
  });

  it("passes when aud is in the allowlist (comma-separated string form)", async () => {
    const token = await sign({ exp: now() + 300, aud: "my-mcp" });
    await expect(
      verifyHs256Jwt(token, SECRET, { audience: "a, my-mcp, b" }),
    ).resolves.toMatchObject({ aud: "my-mcp" });
  });

  it('accepts any aud when allowlist contains "*"', async () => {
    const token = await sign({ exp: now() + 300, aud: "whatever-connector-minted" });
    await expect(
      verifyHs256Jwt(token, SECRET, { audience: ["*"] }),
    ).resolves.toMatchObject({ aud: "whatever-connector-minted" });
  });

  it("matches aud arrays", async () => {
    const token = await sign({ exp: now() + 300, aud: ["x", "my-mcp"] });
    await expect(
      verifyHs256Jwt(token, SECRET, { audience: ["my-mcp"] }),
    ).resolves.toBeTruthy();
  });

  it("skips aud check entirely when audience is omitted", async () => {
    const token = await sign({ exp: now() + 300, aud: "anything" });
    await expect(verifyHs256Jwt(token, SECRET)).resolves.toMatchObject({ aud: "anything" });
  });

  it("runs validateClaims and rejects on false return", async () => {
    type Claims = { exp: number; email?: string };
    const token = await sign({ exp: now() + 300 }); // no email
    await expect(
      verifyHs256Jwt<Claims>(token, SECRET, {
        validateClaims: (c) => typeof c.email === "string" && c.email.length > 0,
      }),
    ).rejects.toMatchObject({ reason: "claims" });
  });

  it("passes validateClaims when the required claim is present", async () => {
    type Claims = { exp: number; github_login?: string };
    const token = await sign({ exp: now() + 300, github_login: "octocat" });
    const claims = await verifyHs256Jwt<Claims>(token, SECRET, {
      validateClaims: (c) => !!c.github_login,
    });
    expect(claims.github_login).toBe("octocat");
  });

  it("propagates a custom error thrown by validateClaims", async () => {
    const token = await sign({ exp: now() + 300 });
    await expect(
      verifyHs256Jwt(token, SECRET, {
        validateClaims: () => {
          throw new Hs256JwtError("custom_reason");
        },
      }),
    ).rejects.toMatchObject({ reason: "custom_reason" });
  });

  it("rejects a token whose payload is not JSON", async () => {
    const header = stringToB64url(JSON.stringify({ alg: "HS256" }));
    const body = bytesToB64url(new Uint8Array([0xff, 0xfe, 0xfd])); // not valid utf8 json
    const sig = bytesToB64url(await hmac(`${header}.${body}`, SECRET));
    await expect(verifyHs256Jwt(`${header}.${body}.${sig}`, SECRET)).rejects.toBeInstanceOf(
      Hs256JwtError,
    );
  });

  it("rejects a token whose header is not JSON", async () => {
    const header = bytesToB64url(new Uint8Array([0xff, 0xfe]));
    const body = stringToB64url(JSON.stringify({ exp: now() + 300 }));
    const sig = bytesToB64url(await hmac(`${header}.${body}`, SECRET));
    await expect(verifyHs256Jwt(`${header}.${body}.${sig}`, SECRET)).rejects.toMatchObject({
      reason: "header_parse",
    });
  });
});
