import type { MiddlewareHandler } from "hono";
import {
  introspectBindingJwt,
  resolveAuthWorkerOrigin,
  wwwAuthenticate,
  BindingJwtError,
  DEFAULT_RESOURCE_METADATA_SLUG,
  type BindingJwtClaims,
  type BindingJwtEnv,
  type IntrospectBindingJwtOptions,
} from "./binding-jwt";

/**
 * Hono adapter for {@link introspectBindingJwt}. The verification logic lives
 * in the framework-agnostic core; this only handles Context wiring
 * (`WWW-Authenticate` header + `c.set("bindingJwt", …)`).
 *
 * - header missing / bad scheme → 401 + WWW-Authenticate (error="invalid_request")
 * - active:false / aud mismatch → 401 + WWW-Authenticate (error="invalid_token")
 * - introspect 503 / fetch failure → 503 (fail-closed, no WWW-Authenticate)
 * - success → `c.set("bindingJwt", { sub, github_login, scope, exp })`
 *
 * Mount in front of the `/mcp` route so the MCP handler only sees authenticated
 * requests; gate write tools by inspecting `c.var.bindingJwt.scope`.
 */
export function bindingJwtMiddleware<E extends BindingJwtEnv = BindingJwtEnv>(
  options: IntrospectBindingJwtOptions = {},
): MiddlewareHandler<{ Bindings: E; Variables: { bindingJwt: BindingJwtClaims } }> {
  const slug = options.resourceMetadataSlug ?? DEFAULT_RESOURCE_METADATA_SLUG;
  return async (c, next) => {
    const authOrigin = resolveAuthWorkerOrigin(c.env, options);
    let claims: BindingJwtClaims;
    try {
      claims = await introspectBindingJwt(c.req.header("Authorization"), c.env, options);
    } catch (err) {
      if (err instanceof BindingJwtError) {
        if (err.status === 401) {
          // errorCode null/undefined → wwwAuthenticate omits the error attribute.
          c.header(
            "WWW-Authenticate",
            wwwAuthenticate(authOrigin, slug, err.errorCode ?? undefined),
          );
          return c.json({ error: err.message }, 401);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
    c.set("bindingJwt", claims);
    await next();
  };
}
