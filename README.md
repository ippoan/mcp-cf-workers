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
`hono` は optional (raw `fetch` で使う場合は不要)。`agents` も optional peer で、
durable (DO+WS) path (`@ippoan/mcp-cf-workers/durable`) を使う場合のみ必要:

```sh
npm install agents
```

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

### Stateful MCP server (Durable Object + WebSocket)

Stateless `createWorkerMcp` freezes a client's `tools/list` for the life of the
session: a deploy that changes the tool-set is invisible until the client
reconnects (ippoan/secrets-inventory#70). The durable path runs the MCP session
inside a Durable Object over a hibernatable WebSocket, so a deploy drops the
connection, the client auto-reconnects and re-runs `tools/list`, and runtime tool
changes can be pushed live via `notifications/tools/list_changed`
(`capabilities.tools.listChanged` is advertised).

```ts
import { z } from "zod";
import { createDurableMcp, mountDurableMcp } from "@ippoan/mcp-cf-workers/durable";

interface Env {
  MCP_OBJECT: DurableObjectNamespace; // wrangler.toml DO binding
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}

// `EchoMcp` is the Durable Object class — export it and wire it in wrangler.toml.
export const EchoMcp = createDurableMcp<Env>({
  name: "echo",
  version: "1.0.0",
  registerTools(server, env, props) {
    // `props` carries the authenticated context from mountDurableMcp's
    // `authenticate` step. Gate write tools by inspecting props.scope here.
    server.registerTool(
      "echo",
      { description: "echo back", inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: message }] }),
    );
  },
});

export default {
  fetch: mountDurableMcp<Env>({
    agent: EchoMcp,
    path: "/mcp",
    async authenticate(request, env) {
      const claims = await verifyCfAccessJwt(request, {
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audience: env.CF_ACCESS_AUD,
      });
      return { sub: claims.sub, scope: "mcp.read" }; // becomes `props`
    },
  }),
};
```

`wrangler.toml` needs a SQLite-backed DO binding + migration:

```toml
[[durable_objects.bindings]]
name = "MCP_OBJECT"
class_name = "EchoMcp"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["EchoMcp"]
```

A runnable PoC (with the deploy→reconnect hard-gate runbook) lives in
[`examples/echo-do-ws`](./examples/echo-do-ws).

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
  する stateless 設計 (`createWorkerMcp`)。session 永続 / server→client push /
  deploy 後の live 反映が必要な場合は durable path (`createDurableMcp` +
  `mountDurableMcp`、Cloudflare `agents` SDK の `McpAgent` ベース) を使う。
  両者は併存し、consumer は段階移行する (Refs #6)
- CF Access JWT 検証は `jose.createRemoteJWKSet` の in-memory cache に
  乗る (= isolate ごと再利用)。tests では `jwksOverride` で差し替え可能
- OAuth 2.1 + DCR + PKCE provider helper は **v0.2 で別 export 追加予定**
  (`./oauth`)。v0.1 は CF Access 専用

## License

MIT
