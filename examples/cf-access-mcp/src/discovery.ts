/**
 * claude.ai connector の **fresh OAuth discovery** 対応 (Refs #26)。
 *
 * 実 log (cf_logging) で判明した事実:
 * claude.ai は新規 connector 登録時、WWW-Authenticate の `resource_metadata`
 * (RFC 9728 → auth-staging) を辿らず、**MCP server origin 自身を authorization
 * server とみなして** RFC 8414 の origin discovery を叩く:
 *
 *   GET  https://cf-access-mcp.ippoan.org/.well-known/oauth-authorization-server
 *   POST https://cf-access-mcp.ippoan.org/register   (RFC 7591 DCR の default endpoint)
 *
 * これらを 404 にしていた (PR #40) ため DCR が失敗し「サインインサービスへの登録
 * ができませんでした」になっていた。ref-files-worker が動くのは OAuth client が
 * claude.ai 側に既に登録済 (cache) で fresh discovery を一切走らせないため
 * (4 日分の log に OAuth traffic 0)。= 「ref-files の 404 と parity」は誤りで、
 * ref-files の 404 は claude.ai から呼ばれないので無害だっただけ。
 *
 * 対応: claude.ai が実際に叩く discovery endpoint を auth-staging に proxy する。
 * AS metadata の `issuer` は auth-staging のまま透過する (= auth-staging が mint
 * する token の `iss` と整合)。RFC 8414 §3.3 の「issuer == fetch 元 origin」は
 * claude.ai が厳格 enforce しない前提。log で issuer mismatch reject が観測されたら
 * issuer を origin に書き換える版へ切替える。
 */
import type { Env } from "./env";

/** binding_jwt introspect / discovery proxy 先 (auth-worker)。 */
function authOrigin(env: Env): string {
  return env.AUTH_WORKER_ORIGIN && env.AUTH_WORKER_ORIGIN !== ""
    ? env.AUTH_WORKER_ORIGIN
    : "https://auth-staging.ippoan.org";
}

/**
 * Resource slug。auth-worker の per-resource metadata endpoint
 * (`/.well-known/oauth-protected-resource/<slug>`) と一致させる規約
 * (= hostname 先頭 label、Refs ippoan/auth-worker#195)。
 */
const RESOURCE_SLUG = "cf-access-mcp";

/** upstream のレスポンスを body 透過で返す (CORS は付けない = 稼働サーバーと parity)。 */
async function passthrough(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * fresh OAuth discovery のリクエストなら auth-staging に proxy した Response を、
 * そうでなければ `null` を返す (= 呼び出し側が通常 routing を続ける)。
 *
 * framework 非依存。`fetchImpl` はテスト差し替え用。
 */
export async function handleDiscovery(
  req: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const origin = authOrigin(env);

  // RFC 8414: claude.ai が MCP origin を AS とみなして叩く AS metadata。
  if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    return passthrough(await fetchImpl(`${origin}/.well-known/oauth-authorization-server`));
  }

  // RFC 9728: protected-resource metadata。resource = origin なので slug 無しの
  // `/.well-known/oauth-protected-resource` で来るが、念のため slug 付きも受ける。
  if (
    req.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === `/.well-known/oauth-protected-resource/${RESOURCE_SLUG}`)
  ) {
    return passthrough(
      await fetchImpl(`${origin}/.well-known/oauth-protected-resource/${RESOURCE_SLUG}`),
    );
  }

  // RFC 7591 Dynamic Client Registration の default endpoint (origin + /register)。
  // AS metadata を読めれば claude.ai は registration_endpoint=auth-staging/mcp/register
  // を使うが、metadata 取得前の default path 用に保険で proxy しておく。
  if (req.method === "POST" && pathname === "/register") {
    const body = await req.text();
    return passthrough(
      await fetchImpl(`${origin}/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": req.headers.get("Content-Type") ?? "application/json" },
        body,
      }),
    );
  }

  return null;
}
