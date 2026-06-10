/**
 * binding_jwt middleware for cf-access-mcp.
 *
 * The verification logic now lives in the lib (`@ippoan/mcp-cf-workers/auth`),
 * promoted from this file in Refs #46 (it was a ~175-line copy of
 * secrets-inventory's middleware). This shim just pins the RFC 9728
 * resource-metadata slug to `cf-access-mcp` (this worker is its own RS:
 * `cf-access-mcp.ippoan.org`, advertised via
 * `/.well-known/oauth-protected-resource/cf-access-mcp`, allowlisted in
 * auth-worker `MCP_RESOURCE_ORIGINS_ALLOWLIST`).
 */
import { bindingJwtMiddleware as libBindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { IntrospectBindingJwtOptions } from "@ippoan/mcp-cf-workers/auth";
import type { Env } from "../env";

export type { BindingJwtClaims } from "@ippoan/mcp-cf-workers/auth";

const RESOURCE_METADATA_SLUG = "cf-access-mcp";

export function bindingJwtMiddleware(
  options: IntrospectBindingJwtOptions = {},
) {
  return libBindingJwtMiddleware<Env>({
    resourceMetadataSlug: RESOURCE_METADATA_SLUG,
    ...options,
  });
}
