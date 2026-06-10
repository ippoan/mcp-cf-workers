export {
  verifyCfAccessJwt,
  CfAccessError,
  _resetJwksCacheForTests,
} from "./cf-access";
export type { CfAccessConfig, CfAccessClaims } from "./cf-access";

export { verifyMcpJwt, McpJwtError } from "./mcp-jwt";
export type { McpJwtConfig, McpJwtClaims } from "./mcp-jwt";

// Framework-agnostic crypto primitives (timing-safe compare + base64url).
export {
  timingSafeEqual,
  constantTimeEqualBytes,
  b64urlToBytes,
  b64urlToString,
  bytesToB64url,
  stringToB64url,
} from "./crypto";

// CF Secrets Store binding resolver (string | SecretsStoreSecret → string|null).
export { resolveSecret } from "./secret";
export type { SecretBinding, SecretGetter } from "./secret";

// HS256 JWT verifier (Web Crypto, generic claim shape + validator injection).
export { verifyHs256Jwt, Hs256JwtError } from "./hs256-jwt";
export type { Hs256BaseClaims, VerifyHs256Options } from "./hs256-jwt";

// binding_jwt introspection (auth-worker /mcp/introspect) — framework-agnostic core.
export {
  introspectBindingJwt,
  resolveAuthWorkerOrigin,
  wwwAuthenticate,
  BindingJwtError,
  DEFAULT_AUTH_WORKER_ORIGIN,
  DEFAULT_RESOURCE_METADATA_SLUG,
} from "./binding-jwt";
export type {
  BindingJwtClaims,
  BindingJwtEnv,
  IntrospectBindingJwtOptions,
} from "./binding-jwt";
