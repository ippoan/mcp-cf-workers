# @ippoan/mcp-cf-workers

Thin building blocks for MCP servers on Cloudflare Workers.

3 repo (`ippoan/secrets-inventory` / `ippoan/secrets-inventory-gcp`
`packages/rotate-mcp` / `ippoan/ci-dashboard`) で重複していた MCP server
boilerplate を共通化する薄い lib。`@modelcontextprotocol/sdk` 同梱の
`WebStandardStreamableHTTPServerTransport` をそのまま使い、Workers entry
point への wiring と CF Access JWT 検証 helper だけを提供する。

## Install

GitHub Packages 経由 (private)。`.npmrc` に scope registry を設定:

```
@ippoan:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
npm install @ippoan/mcp-cf-workers \
  @modelcontextprotocol/sdk hono jose zod
```

SDK / hono / jose / zod は peer dependency。consumer 側で版を固定する。
`hono` は optional (raw `fetch` で使う場合は不要)。

## Usage

### MCP server (Hono mount)

```ts
import { Hono } from "hono";
import { z } from "zod";
import { createWorkerMcp } from "@ippoan/mcp-cf-workers";
import { cfAccessMiddleware } from "@ippoan/mcp-cf-workers/auth/cf-access-hono";

type Env = {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
};

const mcp = createWorkerMcp<Env>({
  name: "my-server",
  version: "0.1.0",
  registerTools: (server, env) => {
    server.registerTool(
      "echo",
      { description: "echo back", inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
  },
});

const app = new Hono<{ Bindings: Env }>();
app.use("/mcp", cfAccessMiddleware());
app.all("/mcp", (c) => mcp(c.req.raw, c.env));

export default app;
```

### CF Access verification (framework-agnostic)

```ts
import { verifyCfAccessJwt } from "@ippoan/mcp-cf-workers/auth/cf-access";

const claims = await verifyCfAccessJwt(request, {
  teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
  audience: env.CF_ACCESS_AUD,
});
```

## Design

- `ippoan/ci-dashboard` の `src/mcp/server.ts` pattern (SDK `McpServer` +
  `WebStandardStreamableHTTPServerTransport`) を抽出した薄い factory
- 1 request あたり 1 `McpServer` + 1 transport を生成、response 後に close
  する stateless 設計。session 永続が必要な場合は Durable Objects +
  `@cloudflare/agents` を使うこと
- CF Access JWT 検証は `jose.createRemoteJWKSet` の in-memory cache に
  乗る (= isolate ごと再利用)。tests では `jwksOverride` で差し替え可能
- OAuth 2.1 + DCR + PKCE provider helper は **v0.2 で別 export 追加予定**
  (`./oauth`)。v0.1 は CF Access 専用

## License

MIT
