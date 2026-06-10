/**
 * Minimal HS256 JWT verifier — Web Crypto self-contained, no `jose`, no node
 * deps. The symmetric (shared-secret) counterpart to `cf-access.ts` (RS256).
 *
 * This is the lib-side home for the hand-copied verifier that lived in four
 * consumers verbatim:
 *   - cdp-relay        `src/lib/jwt.ts`     (`verifyMcpJwt`, github_login claims)
 *   - ref-files-worker `src/lib/jwt.ts`     (same)
 *   - HealthConnectReaderWorker `src/jwt.ts` (`verifyJwt`, `email` claim, null-on-fail)
 *   - auth-worker      `src/lib/jwt.ts`     (`verifyJwt`, `env` claim, null-on-fail)
 *
 * Why Web Crypto and not `jose`: every consumer above deliberately avoids the
 * `jose` dependency for this trivially-implementable check (a single
 * HMAC-SHA256 + base64url decode). The existing jose-based `verifyMcpJwt`
 * (`./mcp-jwt.ts`) is kept for the github_login-specific MCP path; this generic
 * verifier follows the consumers' Web-Crypto convention so it stays importable
 * from node (vitest) without dragging `jose` into the durable bundle.
 *
 * Claim-shape differences (`email` vs `tenant_id` vs `github_login`) are
 * absorbed two ways:
 *   - the generic `<TClaims>` type parameter on the return value, and
 *   - an optional `validateClaims` hook that runs after signature + exp/nbf and
 *     can reject (throw / return false) on consumer-specific required claims.
 *
 * Verified unconditionally:
 *   - alg pinned to HS256 (header.alg compared exactly)
 *   - signature recomputed via HMAC-SHA256, constant-time compared
 *   - exp present and > now (within `clockToleranceSec`, default 30s)
 *   - nbf <= now (within skew) when present
 *
 * Every failure throws {@link Hs256JwtError} with a coarse `reason` so the wire
 * layer can't distinguish "bad signature" from "expired" by message. Consumers
 * that prefer the null-on-failure shape (auth-worker / HealthConnectReaderWorker)
 * wrap this in a try/catch → null.
 */

import {
  b64urlToBytes,
  b64urlToString,
  bytesToB64url,
  constantTimeEqualBytes,
} from "./crypto";

const DEFAULT_SKEW_SEC = 30;

/** Baseline claims every HS256 token carries; extend via the type parameter. */
export interface Hs256BaseClaims {
  exp: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  scope?: string;
  [key: string]: unknown;
}

export class Hs256JwtError extends Error {
  constructor(public readonly reason: string) {
    super("hs256_jwt_verify_failed");
    this.name = "Hs256JwtError";
  }
}

export interface VerifyHs256Options<TClaims extends Hs256BaseClaims = Hs256BaseClaims> {
  /**
   * Expected `aud` allowlist. A single value, a comma-separated string, or a
   * `string[]`. A `"*"` entry disables the aud check entirely (accept any
   * audience) — used because the claude.ai connector mints a varying `aud` and
   * the shared-secret signature already proves the issuer.
   *
   * When omitted, the `aud` claim is not checked at all (consumers like
   * auth-worker / HealthConnectReaderWorker don't gate on aud).
   */
  audience?: string | readonly string[];
  /** Clock skew tolerance in seconds for exp / nbf. Default 30. */
  clockToleranceSec?: number;
  /**
   * Consumer-specific claim validator, run after signature + exp/nbf + aud.
   * Throw {@link Hs256JwtError} (or any error) to reject with a custom reason,
   * or return `false` to reject with reason `claims`. Use this to require
   * `email` / `tenant_id` / `github_login` etc. Return `true` / `void` to pass.
   */
  validateClaims?: (claims: TClaims) => boolean | void;
}

/**
 * Verify a compact HS256 JWT string. Returns the decoded claims (typed as
 * `TClaims`) on success; throws {@link Hs256JwtError} on any failure.
 *
 * @param token  compact JWS (`header.payload.signature`)
 * @param secret shared HMAC secret (same value as the minting worker)
 */
export async function verifyHs256Jwt<TClaims extends Hs256BaseClaims = Hs256BaseClaims>(
  token: string,
  secret: string,
  options: VerifyHs256Options<TClaims> = {},
): Promise<TClaims> {
  if (!secret) throw new Hs256JwtError("no_secret");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Hs256JwtError("shape");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlToString(headerB64));
  } catch {
    throw new Hs256JwtError("header_parse");
  }
  if (header.alg !== "HS256") throw new Hs256JwtError("alg");

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput));
  const actual = b64urlToBytes(sigB64);
  if (!constantTimeEqualBytes(expected, actual)) throw new Hs256JwtError("signature");

  let claims: TClaims;
  try {
    claims = JSON.parse(b64urlToString(payloadB64)) as TClaims;
  } catch {
    throw new Hs256JwtError("payload_parse");
  }

  const skew = options.clockToleranceSec ?? DEFAULT_SKEW_SEC;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new Hs256JwtError("expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new Hs256JwtError("not_yet_valid");
  }

  if (options.audience !== undefined) {
    const allowed = (
      Array.isArray(options.audience)
        ? options.audience
        : String(options.audience).split(",")
    )
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (!allowed.includes("*")) {
      const aud = claims.aud;
      const audValues = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
      if (!audValues.some((a) => allowed.includes(a))) {
        throw new Hs256JwtError("audience");
      }
    }
  }

  if (options.validateClaims) {
    if (options.validateClaims(claims) === false) {
      throw new Hs256JwtError("claims");
    }
  }

  return claims;
}

/** Re-export base64url byte encoder for callers building their own HS256 tokens (tests). */
export { bytesToB64url };
