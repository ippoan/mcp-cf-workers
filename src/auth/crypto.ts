/**
 * Framework-agnostic crypto primitives for Workers auth helpers.
 *
 * Centralises three pieces that were hand-copied across consumers
 * (cdp-relay `src/lib/auth.ts`, auth-worker `src/lib/security.ts`,
 * ref-files-worker `src/lib/jwt.ts`, HealthConnectReaderWorker `src/jwt.ts`):
 *
 *   - `timingSafeEqual` — constant-time string compare that also hides length
 *   - base64url encode / decode (string ↔ string, string ↔ bytes)
 *
 * Pure Web Crypto / `atob` / `btoa`; no node deps, no `jose`. Importable from
 * node (vitest) so the logic stays unit-testable without `cloudflare:workers`.
 */

const HMAC_COMPARE_KEY = "mcp-cf-workers-timing-safe-compare";

let cachedCompareKey: Promise<CryptoKey> | null = null;

function compareKey(): Promise<CryptoKey> {
  if (!cachedCompareKey) {
    cachedCompareKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(HMAC_COMPARE_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedCompareKey;
}

/**
 * Compare two strings in constant time, leaking neither value nor length.
 *
 * Workers has no `crypto.timingSafeEqual`, so each input is first hashed to a
 * fixed-length (32-byte) HMAC-SHA256 digest and the digests are XOR-compared.
 * Because both sides are always 32 bytes the loop count is independent of the
 * input lengths — this is the only correct shape when the secret length must
 * also stay hidden (the HMAC key is a fixed constant; its purpose is diffusion,
 * not authentication).
 *
 * Use this for opaque shared-secret tokens (e.g. `RELAY_TOKEN`,
 * `UPLOAD_TOKEN`). For comparing two equal-length byte arrays (e.g. a
 * recomputed JWT signature) use {@link constantTimeEqualBytes}.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await compareKey();
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ma);
  const vb = new Uint8Array(mb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/**
 * Constant-time compare of two byte arrays. Returns false immediately on a
 * length mismatch (lengths are not secret in the JWT-signature use case — the
 * digest length is a public constant of the algorithm).
 */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Decode a base64url string to raw bytes. Tolerates missing padding. */
export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a base64url string to a UTF-8 string. */
export function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

/** Encode raw bytes to a base64url string (no padding). */
export function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode a UTF-8 string to a base64url string (no padding). */
export function stringToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}
