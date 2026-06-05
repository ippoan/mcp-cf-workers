/**
 * cf-access-mcp Worker エントリ。
 *
 * Cloudflare Zero Trust (Access) を操作する MCP server。@ippoan/mcp-cf-workers の
 * `createWorkerMcp` を consume する薄い worker (issue ippoan/mcp-cf-workers#26)。
 *
 *   POST /mcp     … MCP tool (stateless streamable HTTP)。binding_jwt 認証。
 *   GET  /healthz … ヘルスチェック (認証前段でも通す)
 *
 * 認証は 2 層: edge の CF Access (人間 operator) は `/mcp` では bypassAll にし、
 * worker 側で auth-worker が mint した binding_jwt (Bearer) を検証する。値 (CF API
 * token) は CF Secrets Store binding から runtime 取得し、worker code には焼かない。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { bindingJwtMiddleware, type BindingJwtClaims } from "./middleware/binding-jwt";

type Variables = { bindingJwt: BindingJwtClaims };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", cors());

// /healthz は binding_jwt より先に置き、認証なしで疎通確認できるようにする。
app.get("/healthz", (c) => c.json({ ok: true, service: "cf-access-mcp" }));

// ─── OAuth discovery endpoints (claude.ai connector 用) ──────────────────────
// claude.ai connector は MCP server origin に対して **直接** OAuth discovery を
// 叩く (= RFC 9728 の WWW-Authenticate resource_metadata だけでは fallback して
// くれず、404 だと connector 登録が "サインインサービスへの登録ができませんでした"
// で失敗する)。auth-worker の per-resource Protected Resource Metadata と AS
// metadata を MCP server origin から見せる必要がある。
//
// `/.well-known/oauth-protected-resource`: 自分自身の RS metadata を返す
// (`authorization_servers` は AUTH_WORKER_ORIGIN を指す)。auth-worker 側にも
// `/.well-known/oauth-protected-resource/cf-access-mcp` があり同値を返すが、
// connector は RS origin の方を先に見るためここで答える必要がある。
//
// `/.well-known/oauth-authorization-server`: auth-worker の AS metadata を
// そのまま proxy する (issuer 等の正規値を維持するため fetch + JSON return)。
app.get("/.well-known/oauth-protected-resource", (c) => {
  const requestOrigin = new URL(c.req.url).origin;
  return c.json({
    resource: requestOrigin,
    authorization_servers: [c.env.AUTH_WORKER_ORIGIN],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp.read", "mcp.write", "offline_access"],
  });
});

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const upstream = `${c.env.AUTH_WORKER_ORIGIN}/.well-known/oauth-authorization-server`;
  const resp = await fetch(upstream, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!resp.ok) {
    return c.json({ error: "upstream_metadata_fetch_failed", status: resp.status }, 502);
  }
  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
});

// /mcp と /mcp/* は auth-worker (`AUTH_WORKER_ORIGIN`) が mint した binding_jwt
// (Bearer) で認証する。Hono の `/mcp/*` は `/mcp/foo` 以下しかマッチしないため
// `/mcp` 自身にも別途 mount する (secrets-inventory と同じ)。
app.use("/mcp", bindingJwtMiddleware());
app.use("/mcp/*", bindingJwtMiddleware());

// MCP transport (stateless streamable HTTP)。SDK (+ ajv) は重いので /mcp 到達時に
// 遅延 import する (ui-preview と同じ。non-MCP path / テストに SDK を乗せない)。
app.all("/mcp", async (c) => {
  const { handleMcp } = await import("./mcp/server");
  return handleMcp(c.req.raw, c.env, c.get("bindingJwt"));
});

export default app;
