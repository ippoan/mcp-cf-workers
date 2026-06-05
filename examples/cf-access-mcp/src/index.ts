/**
 * cf-access-mcp Worker エントリ。
 *
 * Cloudflare Zero Trust (Access) を操作する MCP server。@ippoan/mcp-cf-workers の
 * `createWorkerMcp` を consume する薄い worker (issue ippoan/mcp-cf-workers#26)。
 *
 *   POST /mcp     … MCP tool (stateless streamable HTTP)。binding_jwt 認証。
 *   GET  /healthz … ヘルスチェック (認証前段でも通す)
 *   GET  /.well-known/oauth-authorization-server     … AS metadata (auth-staging proxy)
 *   GET  /.well-known/oauth-protected-resource[/...] … PR metadata (auth-staging proxy)
 *   POST /register … Dynamic Client Registration (auth-staging proxy)
 *
 * 認証は 2 層: edge の CF Access (人間 operator) は `/mcp` では bypassAll にし、
 * worker 側で auth-worker が mint した binding_jwt (Bearer) を検証する。値 (CF API
 * token) は CF Secrets Store binding から runtime 取得し、worker code には焼かない。
 *
 * ✅ /.well-known/oauth-* + /register discovery を auth-staging に proxy する
 *    (`src/discovery.ts`、Refs #26)。
 * 前任セッションは「claude.ai は MCP origin の /.well-known/* を見ない」と判断し
 * PR #40 で全削除したが、これは **誤り**だった。cf_logging の実 log で、claude.ai は
 * fresh connector 登録時に MCP origin 自身を AS とみなして
 *   GET  /.well-known/oauth-authorization-server   (10 回)
 *   POST /register                                  (8 回)
 * を叩いており、404 のせいで DCR が失敗していた。ref-files が動くのは OAuth client が
 * claude.ai 側に登録済 (cache) で fresh discovery を走らせないため (= ref-files の 404
 * は呼ばれないので無害)。よって claude.ai が実際に叩く discovery を auth-staging に
 * proxy して fresh 登録を通す。詳細・issuer 設計判断は `src/discovery.ts` 参照。
 */
import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { handleDiscovery } from "./discovery";
import { bindingJwtMiddleware, type BindingJwtClaims } from "./middleware/binding-jwt";

type Variables = { bindingJwt: BindingJwtClaims };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// 注意: 以前は `app.use("*", cors())` でグローバルに
// `access-control-allow-origin: *` を付けていたが、動いている参照
// (ref-files-worker / ui-preview) は CORS header を **一切付けていない**
// (curl 実測)。claude.ai connector の OAuth discovery / MCP fetch は server-side
// で行われ CORS は不要。cf-access-mcp だけが wildcard CORS を出していたのは
// parity gap なので撤去し、稼働サーバーと wire 一致させる (Refs #26)。

// /healthz は binding_jwt より先に置き、認証なしで疎通確認できるようにする。
app.get("/healthz", (c) => c.json({ ok: true, service: "cf-access-mcp" }));

// claude.ai fresh connector の OAuth discovery を auth-staging に proxy する
// (認証なし。`src/discovery.ts`、Refs #26)。SDK 非依存なので遅延 import 不要。
const discovery = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const res = await handleDiscovery(c.req.raw, c.env);
  return res ?? c.json({ error: "not_found" }, 404);
};
app.get("/.well-known/oauth-authorization-server", discovery);
app.get("/.well-known/oauth-protected-resource", discovery);
app.get("/.well-known/oauth-protected-resource/:slug", discovery);
app.post("/register", discovery);

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

// 未知パスは JSON 404 を返す (ref-files-worker と一致)。Hono default の
// text/plain `404 Not Found` だと、claude.ai が試しに叩く /.well-known/* で
// content-type が稼働サーバーと食い違う。parity 維持のため JSON 化 (Refs #26)。
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
