import { jwtVerify, errors as joseErrors } from "jose";

/**
 * HS256 MCP-JWT verification — the symmetric counterpart to `cf-access.ts`.
 *
 * Verifies the `Authorization: Bearer <jwt>` token that `auth-worker` mints
 * and `ref-files-worker` consumes on its `/v1/*` routes (see
 * `ref-files-worker/src/lib/jwt.ts`). The shared `MCP_JWT_SECRET` HMAC key is
 * the trust anchor; `jose` handles the constant-time HMAC compare, `alg`
 * pinning, and `aud` / `exp` / `nbf` enforcement.
 *
 * Kept thin on purpose: no test-env bypass (a consumer concern), no scope
 * gating (the caller inspects `claims.scope`). Just verify + surface claims.
 */

export interface McpJwtConfig {
  /** Shared HMAC secret (`MCP_JWT_SECRET`), identical to the minting worker. */
  secret: string;
  /** Expected `aud` claim (`MCP_JWT_AUDIENCE`). */
  audience: string;
  /** Clock skew tolerance in seconds for `exp` / `nbf`. Default 30. */
  clockToleranceSec?: number;
}

/** Claim shape emitted by `auth-worker` (`src/lib/mcp-jwt.ts`). */
export interface McpJwtClaims {
  sub: string;
  github_login: string;
  scope: string;
  aud: string;
  exp: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  [key: string]: unknown;
}

export class McpJwtError extends Error {
  constructor(public readonly reason: string) {
    super("mcp_jwt_verify_failed");
    this.name = "McpJwtError";
  }
}

const DEFAULT_SKEW_SEC = 30;

/**
 * Extract + verify the bearer MCP-JWT on `request`.
 *
 * @throws {McpJwtError} with a coarse `reason` (`missing_bearer`, `alg`,
 *   `expired`, `audience`, `signature`, `sub`, `github_login`, `verify`) — the
 *   wire layer should not leak which check failed.
 */
export async function verifyMcpJwt(
  request: Request,
  config: McpJwtConfig,
): Promise<McpJwtClaims> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new McpJwtError("missing_bearer");
  }
  const token = header.slice(7).trim();
  if (!token) throw new McpJwtError("missing_bearer");

  const key = new TextEncoder().encode(config.secret);

  let payload: McpJwtClaims;
  try {
    const result = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: config.audience,
      clockTolerance: config.clockToleranceSec ?? DEFAULT_SKEW_SEC,
    });
    payload = result.payload as McpJwtClaims;
  } catch (err) {
    throw new McpJwtError(classifyJoseError(err));
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new McpJwtError("sub");
  }
  if (typeof payload.github_login !== "string" || payload.github_login.length === 0) {
    throw new McpJwtError("github_login");
  }

  return payload;
}

function classifyJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "expired";
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return err.claim === "aud" ? "audience" : "claim";
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "signature";
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return "alg";
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return "malformed";
  }
  return "verify";
}
