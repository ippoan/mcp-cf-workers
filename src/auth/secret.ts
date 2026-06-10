/**
 * Generic CF Secrets Store binding resolver.
 *
 * A `wrangler.toml` `[[secrets_store_secrets]]` binding is injected as a
 * `SecretsStoreSecret` (`{ get(): Promise<string> }`) in production, but vitest
 * / `wrangler dev` hand the *same* binding name over as a plain string. This
 * normalises both shapes (plus `undefined`) to `string | null` so callers can
 * branch once (`if (!value) return 503` / fail-closed).
 *
 * Mirrors auth-worker `src/lib/secret.ts` and the inline `resolveSecret` in
 * cdp-relay `src/lib/auth.ts`. Framework-agnostic; importable from node.
 */

/**
 * Minimal structural type of a CF Secrets Store binding. We avoid depending on
 * the ambient `SecretsStoreSecret` from `@cloudflare/workers-types` here so the
 * helper is usable from plain node contexts too; the real binding satisfies it.
 */
export interface SecretGetter {
  get(): Promise<string>;
}

export type SecretBinding = string | SecretGetter | undefined | null;

/**
 * Resolve the three binding shapes to `string | null`:
 *
 *   - `undefined` / `null` / falsy → `null`
 *   - `string` (vitest / `wrangler dev`) → returned as-is
 *   - `SecretsStoreSecret` (`.get()` present) → resolved
 *   - `.get()` throws / empty string → `null`
 *
 * Callers should treat `null` as "unbound or unavailable" and fail closed.
 */
export async function resolveSecret(binding: SecretBinding): Promise<string | null> {
  if (!binding) return null;
  if (typeof binding === "string") return binding;
  try {
    const value = await binding.get();
    return value || null;
  } catch {
    return null;
  }
}
