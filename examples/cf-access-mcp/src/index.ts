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
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { bindingJwtMiddleware, type BindingJwtClaims } from "./middleware/binding-jwt";

type Variables = { bindingJwt: BindingJwtClaims };
type AppEnv = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnv>();

app.use("*", cors());

// /healthz は binding_jwt より先に置き、認証なしで疎通確認できるようにする。
app.get("/healthz", (c) => c.json({ ok: true, service: "cf-access-mcp" }));

// ─── OAuth discovery endpoints (claude.ai connector 用) ──────────────────────
// claude.ai connector は MCP server origin と **MCP endpoint URL suffix** の両方
// で OAuth discovery を試みる (新仕様 MCP 2025-06-18: discovery が <mcp_url>
// /.well-known/oauth-* で行われる)。両方とも 200 を返さないと connector 登録が
// 「サインインサービスへの登録ができませんでした」/「Authorization failed」で fail。
//
// 2 endpoint x 2 prefix = 4 route:
//   /.well-known/oauth-protected-resource          (RFC 9728 RS metadata)
//   /.well-known/oauth-authorization-server        (RFC 8414 AS metadata proxy)
//   /mcp/.well-known/oauth-protected-resource      (MCP 2025-06-18 spec)
//   /mcp/.well-known/oauth-authorization-server    (同)
//
// /mcp/.well-known/* は binding_jwt middleware より **前段** で登録すること
// (= middleware の `/mcp/*` が 401 を返してしまうのを防ぐ)。
const protectedResource = (c: Context<AppEnv>) => {
  const url = new URL(c.req.url);
  return c.json({
    resource: `${url.origin}/mcp`,
    authorization_servers: [c.env.AUTH_WORKER_ORIGIN],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp.read", "mcp.write", "offline_access"],
  });
};
const asMetadataProxy = async (c: Context<AppEnv>) => {
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
};

// route handler を middleware の前に登録 (Hono は登録順で match)
app.get("/.well-known/oauth-protected-resource", protectedResource);
app.get("/.well-known/oauth-authorization-server", asMetadataProxy);
app.get("/mcp/.well-known/oauth-protected-resource", protectedResource);
app.get("/mcp/.well-known/oauth-authorization-server", asMetadataProxy);

// /mcp と /mcp/* は auth-worker (`AUTH_WORKER_ORIGIN`) が mint した binding_jwt
// (Bearer) で認証する。Hono の `/mcp/*` は `/mcp/foo` 以下しかマッチしないため
// `/mcp` 自身にも別途 mount する (secrets-inventory と同じ)。
// `/mcp/.well-known/*` は上で route handler 登録済みなので middleware 適用前に
// match して 200 を返す (Hono の route handler は middleware と同 path で先に
// 登録された方が match)。
app.use("/mcp", bindingJwtMiddleware());
app.use("/mcp/*", async (c, next) => {
  // MCP spec 2025-06-18: client が discovery で叩く path は middleware を skip
  if (c.req.path.startsWith("/mcp/.well-known/")) return next();
  return bindingJwtMiddleware()(c, next);
});

// MCP transport (stateless streamable HTTP)。SDK (+ ajv) は重いので /mcp 到達時に
// 遅延 import する (ui-preview と同じ。non-MCP path / テストに SDK を乗せない)。
app.all("/mcp", async (c) => {
  const { handleMcp } = await import("./mcp/server");
  return handleMcp(c.req.raw, c.env, c.get("bindingJwt"));
});

export default app;
