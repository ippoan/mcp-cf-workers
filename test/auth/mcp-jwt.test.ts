import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { verifyMcpJwt, McpJwtError } from "../../src/auth/mcp-jwt";

const SECRET = "test-shared-secret-at-least-32-bytes-long!!";
const AUD = "ref-files-mcp-server-rs";

function key(secret = SECRET): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function sign(
  claims: Record<string, unknown> = {},
  opts: { aud?: string; alg?: string; expIn?: string; nbfOffset?: number; secret?: string } = {},
): Promise<string> {
  let jwt = new SignJWT({
    sub: "github:yhonda-ohishi",
    github_login: "yhonda-ohishi",
    scope: "mcp.read mcp.write",
    ...claims,
  })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setIssuedAt()
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.expIn ?? "5m");
  if (opts.nbfOffset !== undefined) {
    jwt = jwt.setNotBefore(Math.floor(Date.now() / 1000) + opts.nbfOffset);
  }
  return await jwt.sign(key(opts.secret));
}

function reqWith(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request("http://example.com/mcp", { method: "POST", headers });
}

describe("verifyMcpJwt", () => {
  it("verifies a valid token and returns claims", async () => {
    const claims = await verifyMcpJwt(reqWith(await sign()), {
      secret: SECRET,
      audience: AUD,
    });
    expect(claims.sub).toBe("github:yhonda-ohishi");
    expect(claims.github_login).toBe("yhonda-ohishi");
    expect(claims.scope).toBe("mcp.read mcp.write");
  });

  it("throws missing_bearer when the header is absent", async () => {
    await expect(
      verifyMcpJwt(reqWith(null), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "missing_bearer" });
  });

  it("throws missing_bearer when the scheme is not Bearer", async () => {
    const headers = new Headers({ Authorization: await sign() });
    const req = new Request("http://example.com/mcp", { method: "POST", headers });
    await expect(
      verifyMcpJwt(req, { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "missing_bearer" });
  });

  it("rejects a bad signature (wrong secret)", async () => {
    const token = await sign({}, { secret: "a-totally-different-secret-value-xx" });
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "signature" });
  });

  it("rejects audience mismatch", async () => {
    const token = await sign({}, { aud: "some-other-aud" });
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "audience" });
  });

  it("rejects an expired token", async () => {
    const token = await sign({}, { expIn: "-1m" });
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD, clockToleranceSec: 0 }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a non-HS256 alg", async () => {
    // HS512-signed token must be refused because we pin algorithms: ["HS256"].
    const token = await new SignJWT({ sub: "x", github_login: "x" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(key());
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "alg" });
  });

  it("rejects a malformed token", async () => {
    await expect(
      verifyMcpJwt(reqWith("not-a-jwt"), { secret: SECRET, audience: AUD }),
    ).rejects.toBeInstanceOf(McpJwtError);
  });

  it("rejects a token missing github_login", async () => {
    const token = await new SignJWT({ sub: "github:x", scope: "mcp.read" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(key());
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "github_login" });
  });

  it("rejects a token missing sub", async () => {
    const token = await new SignJWT({ github_login: "yhonda-ohishi", scope: "mcp.read" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(key());
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD }),
    ).rejects.toMatchObject({ reason: "sub" });
  });

  it("honours nbf with the configured skew", async () => {
    // nbf 10s in the future, skew 0 → not yet valid.
    const token = await sign({}, { nbfOffset: 10 });
    await expect(
      verifyMcpJwt(reqWith(token), { secret: SECRET, audience: AUD, clockToleranceSec: 0 }),
    ).rejects.toBeInstanceOf(McpJwtError);
  });
});
