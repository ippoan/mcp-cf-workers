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
 *
 * ⚠ /.well-known/oauth-* discovery endpoint は **意図的に提供しない** (404 のまま)。
 * 動いている他 MCP (ref-files-worker / ui-preview / secrets-inventory) の挙動を
 * 実調査した結果、claude.ai connector は MCP server origin の /.well-known/* を
 * **見ておらず**、`/mcp` 401 の WWW-Authenticate header の `resource_metadata`
 * URL (= auth-staging が host する per-resource metadata) だけを信頼して
 * discovery する。cf-access-mcp が独自に metadata を 200 で返すと auth-staging の
 * metadata と不一致になり (resource field 等)、claude.ai が confused で fail する
 * 事故が PR #34-#39 で実証された。PR #37 と同じ判断だが、protected-resource も
 * 含めて完全削除する点が異なる (PR #37 は protected-resource を残した)。
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
