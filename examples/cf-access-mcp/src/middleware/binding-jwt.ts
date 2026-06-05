import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";

// `Authorization: Bearer <binding_jwt>` を auth-worker (`AUTH_WORKER_ORIGIN`)
// の `POST /mcp/introspect` (Mode 1 — Bearer JWT 自己 introspect) に forward
// して検証する。secrets-inventory/src/middleware/binding-jwt.ts を踏襲。
//
// binding_jwt は auth-worker の `/mcp/pair/grant-via-oat` 等で mint され、HS256
// で `MCP_JWT_SECRET` 署名された短命 (24h) JWT。caller (Claude Code 等) →
// この MCP の per-tool-call 認証に使い、`scope` を write tool の gating に使う。
//
// 利点 (Refs ippoan/secrets-inventory#43):
// 1. MCP 標準 OAuth 2.1: WWW-Authenticate header で claude.ai connector の
//    auto-discovery (RFC 9728 resource_metadata) を起動させる
// 2. per-client revoke: auth-worker 側で JWT を invalidate するだけで蹴れる
// 3. provisioning ゼロ: 本 worker は shared bearer を持たない

const SCHEME_PREFIX = "Bearer ";

const DEFAULT_AUTH_WORKER_ORIGIN = "https://auth.ippoan.org";

// 本 worker (`cf-access-mcp.ippoan.org`) は独立した RS なので、auth-worker の
// per-resource metadata endpoint
// (`/.well-known/oauth-protected-resource/cf-access-mcp`) を指す。slug は
// allowlist 内 URL の hostname 先頭 label と一致させる規約
// (Refs ippoan/auth-worker#195)。auth-worker 側 `MCP_RESOURCE_ORIGINS_ALLOWLIST`
// に `https://cf-access-mcp.ippoan.org` を追加する作業は PR4 (auth-worker repo)。
const RESOURCE_METADATA_SLUG = "cf-access-mcp";

export { DEFAULT_AUTH_WORKER_ORIGIN };

/** `/mcp/introspect` の active response 形状 (RFC 7662 §2.2 + ippoan ext)。 */
export interface IntrospectActive {
  active: true;
  scope: string;
  sub: string;
  github_login: string;
  exp: number;
}

export interface BindingJwtClaims {
  sub: string;
  github_login: string;
  scope: string;
  exp: number;
}

export interface BindingJwtMiddlewareOptions {
  /** テスト用 override。本番は global `fetch` 経由で auth-worker に問い合わせる。 */
  introspectFetch?: typeof fetch;
  /** auth-worker origin override (テスト / staging 切替用)。未指定なら env.AUTH_WORKER_ORIGIN。 */
  authWorkerOrigin?: string;
  /**
   * 受理する aud allowlist。`null` (= default) は aud check を skip し、
   * auth-worker `/mcp/introspect` の判定に委譲する。strict にしたい場合は
   * `["cf-access-mcp"]` などを渡す。
   */
  expectedAud?: readonly string[] | null;
}

/**
 * binding_jwt 検証失敗を表す error。`status` は HTTP status (401 / 503)、
 * `errorCode` は RFC 6750 の `error=` パラメータ (401 のみ; 503 は null)。
 */
export class BindingJwtError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "BindingJwtError";
  }
}

export function wwwAuthenticate(authOrigin: string, error?: string): string {
  // RFC 6750 + RFC 9728 (Protected Resource Metadata)。claude.ai connector は
  // `resource_metadata` を辿って AS を auto-discover する。
  const base = `Bearer realm="MCP", resource_metadata="${authOrigin}/.well-known/oauth-protected-resource/${RESOURCE_METADATA_SLUG}"`;
  return error ? `${base}, error="${error}"` : base;
}

function unauthorized(
  c: Context<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>,
  authOrigin: string,
  errorCode: string,
  message: string,
  status: 401 | 503 = 401,
): Response {
  if (status === 401) {
    c.header("WWW-Authenticate", wwwAuthenticate(authOrigin, errorCode));
  }
  return c.json({ error: message }, status);
}

/**
 * `Authorization: Bearer <binding_jwt>` を auth-worker `/mcp/introspect` で検証し
 * claims を返す。framework 非依存。失敗時は {@link BindingJwtError} を throw する。
 *
 * - header 欠落 / scheme 不正 / empty → 401 invalid_token
 * - fetch 失敗 / introspect 503 / 非 ok / 不正 JSON / claims 欠落 → 503 (fail-closed)
 * - active:false / 401 / aud mismatch → 401 invalid_token
 */
export async function introspectBindingJwt(
  authHeader: string | null | undefined,
  env: Env,
  options: BindingJwtMiddlewareOptions = {},
): Promise<BindingJwtClaims> {
  const authOrigin =
    options.authWorkerOrigin ?? env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;

  if (!authHeader || !authHeader.startsWith(SCHEME_PREFIX)) {
    throw new BindingJwtError(
      401,
      "invalid_token",
      "missing or malformed Authorization: Bearer header",
    );
  }
  const token = authHeader.slice(SCHEME_PREFIX.length);
  if (!token) {
    throw new BindingJwtError(401, "invalid_token", "empty bearer token");
  }

  const fetchImpl = options.introspectFetch ?? fetch;
  let resp: Response;
  try {
    resp = await fetchImpl(`${authOrigin}/mcp/introspect`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BindingJwtError(503, null, `introspect fetch failed: ${msg}`);
  }

  if (resp.status === 503) {
    throw new BindingJwtError(503, null, "auth-worker introspect 503 (server misconfigured)");
  }
  if (resp.status === 401) {
    throw new BindingJwtError(401, "invalid_token", "invalid bearer token");
  }
  if (!resp.ok) {
    throw new BindingJwtError(503, null, `introspect failed: HTTP ${resp.status}`);
  }

  let body: {
    active?: unknown;
    scope?: unknown;
    sub?: unknown;
    github_login?: unknown;
    exp?: unknown;
    aud?: unknown;
  };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    throw new BindingJwtError(503, null, "introspect returned invalid JSON");
  }

  if (body.active !== true) {
    throw new BindingJwtError(401, "invalid_token", "token not active");
  }

  if (
    typeof body.sub !== "string" ||
    typeof body.github_login !== "string" ||
    typeof body.scope !== "string" ||
    typeof body.exp !== "number"
  ) {
    throw new BindingJwtError(503, null, "introspect response missing required claims");
  }

  if (options.expectedAud && typeof body.aud === "string" && !options.expectedAud.includes(body.aud)) {
    throw new BindingJwtError(401, "invalid_token", "aud not in allowlist");
  }

  return {
    sub: body.sub,
    github_login: body.github_login,
    scope: body.scope,
    exp: body.exp,
  };
}

/**
 * binding_jwt (auth-worker mint) を `/mcp/introspect` 経由で検証する Hono
 * middleware。検証ロジック本体は {@link introspectBindingJwt} に集約し、ここでは
 * Hono Context への WWW-Authenticate / claims set だけを担う。
 *
 * - header 欠落 / scheme 不正 → 401 + WWW-Authenticate
 * - introspect 503 / fetch 失敗 → 503 (fail-closed)
 * - active:false / aud mismatch → 401 + WWW-Authenticate
 * - 成功時は `c.set("bindingJwt", { sub, github_login, scope, exp })`
 */
export function bindingJwtMiddleware(
  options: BindingJwtMiddlewareOptions = {},
): MiddlewareHandler<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}> {
  return async (c, next) => {
    const authOrigin =
      options.authWorkerOrigin ?? c.env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;

    let claims: BindingJwtClaims;
    try {
      claims = await introspectBindingJwt(c.req.header("Authorization"), c.env, options);
    } catch (err) {
      if (err instanceof BindingJwtError) {
        if (err.status === 401) {
          return unauthorized(c, authOrigin, err.errorCode ?? "invalid_token", err.message);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    c.set("bindingJwt", claims);
    await next();
  };
}
