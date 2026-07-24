/**
 * binding_jwt verification via auth-worker `POST /mcp/introspect` (Mode 1 —
 * Bearer JWT self-introspect). Framework-agnostic core; the Hono adapter lives
 * in `./binding-jwt-hono.ts`.
 *
 * Promoted verbatim from `examples/cf-access-mcp/src/middleware/binding-jwt.ts`
 * (which was a ~175-line copy of `secrets-inventory/src/middleware/
 * binding-jwt.ts`). This is now the single source for both.
 *
 * binding_jwt is a short-lived (24h) HS256 JWT minted by auth-worker
 * (`/mcp/pair/grant-via-oat` etc., signed with `MCP_JWT_SECRET`). Forwarding it
 * to `/mcp/introspect` instead of verifying locally buys, per
 * ippoan/secrets-inventory#43:
 *   1. MCP-standard OAuth 2.1 discovery: the `WWW-Authenticate` header drives
 *      the claude.ai connector's RFC 9728 `resource_metadata` auto-discovery
 *   2. per-client revoke: auth-worker invalidates the JWT to kick a caller
 *   3. zero provisioning: the consuming worker holds no shared bearer secret
 */

const SCHEME_PREFIX = "Bearer ";

export const DEFAULT_AUTH_WORKER_ORIGIN = "https://auth.ippoan.org";

/**
 * `/mcp/introspect` active response shape (RFC 7662 §2.2 + ippoan ext).
 *
 * `github_login` / `email` are IdP-specific and mutually exclusive: auth-worker's
 * GitHub flow sets `github_login` (no `email`), its Google flow sets `email`
 * (no `github_login` — Refs ippoan/auth-worker#414). Exactly one is present on
 * any active token; callers that only need `sub` for identity don't have to
 * branch on IdP.
 */
export interface BindingJwtClaims {
  sub: string;
  github_login?: string;
  email?: string;
  scope: string;
  exp: number;
}

export interface IntrospectBindingJwtOptions {
  /**
   * auth-worker origin. Resolution order:
   *   `authWorkerOrigin` → `env.AUTH_WORKER_ORIGIN` → {@link DEFAULT_AUTH_WORKER_ORIGIN}.
   *
   * Used as the fetch target unless {@link authWorkerBinding} is set; always
   * used (regardless of `authWorkerBinding`) as the public URL advertised in
   * the `WWW-Authenticate` `resource_metadata` attribute, since that must be
   * reachable by the caller (claude.ai etc.), not just by this Worker.
   */
  authWorkerOrigin?: string;
  /** Test override; takes precedence over both `authWorkerBinding` and the global `fetch`. */
  introspectFetch?: typeof fetch;
  /**
   * Cloudflare Service Binding to auth-worker (e.g. `env.AUTH_WORKER`, a
   * `[[services]]` binding in `wrangler.toml`). Resolution order:
   *   `authWorkerBinding` → `env.AUTH_WORKER` → (falls back to origin-based fetch).
   * When resolved, the introspect request goes through `.fetch()` instead of
   * a DNS/TLS HTTP call to `authWorkerOrigin` — the binding config in
   * `wrangler.toml` is then the only thing that decides which auth-worker
   * instance (prod/staging) is targeted, structurally removing the "forgot
   * to set `AUTH_WORKER_ORIGIN`, silently defaulted to prod" footgun (Refs
   * ippoan/auth-worker#435). Same account only — cross-account consumers
   * must keep using `authWorkerOrigin`.
   *
   * Reading `env.AUTH_WORKER` (rather than requiring every caller to thread
   * it through `options` explicitly) matters for the Hono middleware
   * ({@link ../binding-jwt-hono.ts}): its `options` are fixed once at
   * `app.use(...)` registration time, before any request (and its `c.env`)
   * exists, so a per-request Cloudflare binding can only reach this function
   * via `env`, the same way `AUTH_WORKER_ORIGIN` already does.
   */
  authWorkerBinding?: { fetch: typeof fetch };
  /**
   * Accepted `aud` allowlist. `null` / omitted skips the aud check and defers
   * to auth-worker's `/mcp/introspect` decision. Pass e.g. `["my-mcp"]` to be
   * strict.
   */
  expectedAud?: readonly string[] | null;
  /**
   * RFC 9728 resource-metadata slug used in the `WWW-Authenticate` header
   * (`/.well-known/oauth-protected-resource/<slug>`). Defaults to the URL
   * hostname's first label is the consumer's job — pass the slug explicitly.
   */
  resourceMetadataSlug?: string;
}

/** Minimal env shape this helper reads. Consumers pass their own `Env`. */
export interface BindingJwtEnv {
  AUTH_WORKER_ORIGIN?: string;
  /** Service Binding to auth-worker. See {@link IntrospectBindingJwtOptions.authWorkerBinding}. */
  AUTH_WORKER?: { fetch: typeof fetch };
}

/**
 * binding_jwt verification failure. `status` is the HTTP status (401 / 503);
 * `errorCode` is the RFC 6750 `error=` parameter (401 only; 503 → null).
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

const DEFAULT_RESOURCE_METADATA_SLUG = "mcp";

/**
 * Build the `WWW-Authenticate` header value (RFC 6750 + RFC 9728). The
 * claude.ai connector follows `resource_metadata` to auto-discover the AS.
 */
export function wwwAuthenticate(
  authOrigin: string,
  resourceMetadataSlug: string,
  error?: string,
): string {
  const base = `Bearer realm="MCP", resource_metadata="${authOrigin}/.well-known/oauth-protected-resource/${resourceMetadataSlug}"`;
  return error ? `${base}, error="${error}"` : base;
}

/**
 * Verify `Authorization: Bearer <binding_jwt>` against auth-worker
 * `/mcp/introspect` and return the claims. Framework-agnostic; throws
 * {@link BindingJwtError} on failure.
 *
 * - header missing / bad scheme / empty → 401 invalid_request
 * - fetch failure / introspect 503 / non-ok / bad JSON / missing claims → 503 (fail-closed)
 * - active:false / 401 / aud mismatch → 401 invalid_token
 */
export async function introspectBindingJwt(
  authHeader: string | null | undefined,
  env: BindingJwtEnv,
  options: IntrospectBindingJwtOptions = {},
): Promise<BindingJwtClaims> {
  if (!authHeader || !authHeader.startsWith(SCHEME_PREFIX)) {
    // Bearer header absent → `error="invalid_request"` (a request-shape problem,
    // not an invalid token). Matches the live ref-files-worker wire behaviour.
    throw new BindingJwtError(
      401,
      "invalid_request",
      "missing or malformed Authorization: Bearer header",
    );
  }
  const token = authHeader.slice(SCHEME_PREFIX.length);
  if (!token) {
    throw new BindingJwtError(401, "invalid_request", "empty bearer token");
  }

  const authOrigin =
    options.authWorkerOrigin ?? env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;
  // Service binding takes precedence over the origin-based fetch when
  // resolved — the binding request still needs a URL, but workerd's binding
  // fetch routes on the binding itself, not on the URL's host, so a fixed
  // dummy origin is fine (never touches DNS/TLS).
  const authWorkerBinding = options.authWorkerBinding ?? env.AUTH_WORKER;
  const fetchImpl =
    options.introspectFetch ??
    (authWorkerBinding ? authWorkerBinding.fetch.bind(authWorkerBinding) : fetch);
  const introspectUrl = authWorkerBinding
    ? "https://auth-worker.internal/mcp/introspect"
    : `${authOrigin}/mcp/introspect`;
  let resp: Response;
  try {
    resp = await fetchImpl(introspectUrl, {
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
    email?: unknown;
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

  // `github_login` (GitHub flow) and `email` (Google flow) are IdP-specific —
  // exactly one identifies the caller, neither is universally required.
  // Refs ippoan/auth-worker#414 / ohishi-exp/nuxt-dtako-admin#376: kyuyo-mcp
  // was the first Google-flow consumer and hard-required `github_login` broke
  // it outright (every active Google token got rejected as "missing claims").
  if (
    typeof body.sub !== "string" ||
    typeof body.scope !== "string" ||
    typeof body.exp !== "number" ||
    (typeof body.github_login !== "string" && typeof body.email !== "string")
  ) {
    throw new BindingJwtError(503, null, "introspect response missing required claims");
  }

  if (
    options.expectedAud &&
    typeof body.aud === "string" &&
    !options.expectedAud.includes(body.aud)
  ) {
    throw new BindingJwtError(401, "invalid_token", "aud not in allowlist");
  }

  return {
    sub: body.sub,
    ...(typeof body.github_login === "string" ? { github_login: body.github_login } : {}),
    ...(typeof body.email === "string" ? { email: body.email } : {}),
    scope: body.scope,
    exp: body.exp,
  };
}

/**
 * Resolve the auth-worker origin from options → env → default. Exposed so the
 * Hono adapter shares the exact same precedence.
 */
export function resolveAuthWorkerOrigin(
  env: BindingJwtEnv,
  options: IntrospectBindingJwtOptions = {},
): string {
  return options.authWorkerOrigin ?? env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;
}

export { DEFAULT_RESOURCE_METADATA_SLUG };
