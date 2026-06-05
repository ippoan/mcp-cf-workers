# cf-access-mcp — Cloudflare Zero Trust (Access) 管理 MCP server

Cloudflare Access (Zero Trust) を Claude から操作する Worker-native MCP server。
`@ippoan/mcp-cf-workers` の `createWorkerMcp` (stateless streamable HTTP) を
consume する thin worker。Refs [ippoan/mcp-cf-workers#26]。

[ippoan/mcp-cf-workers#26]: https://github.com/ippoan/mcp-cf-workers/issues/26

## 動機

hostname に CF Access を被せると、未認証リクエストは edge でログインへ 302 され
**Worker invocation が 0** になる (bot の辞書スキャン = `/.env.production` 等への
404 ノイズ対策)。その CF Access 設定を Claude から行う MCP tool が無かったため新設。
最終ゴールは高レベル tool `protect_hostname` で `egov-staging.ippoan.org` を保護する
こと (PR5)。

## endpoints

| path | 説明 |
|---|---|
| `POST /mcp` | MCP tool (stateless streamable HTTP)。binding_jwt 認証必須。 |
| `GET /healthz` | ヘルスチェック (認証不要)。 |

## 認証 (2 層)

- **edge CF Access** — 人間 operator 用 (browser OAuth)。`/mcp` は edge で bypassAll。
- **binding_jwt** — caller → MCP の per-tool-call 認証。auth-worker が mint した
  Bearer JWT を `POST {AUTH_WORKER_ORIGIN}/mcp/introspect` で検証し、`scope` を
  write tool の gating に使う (secrets-inventory 方式)。401 では RFC 9728 の
  `WWW-Authenticate: ... resource_metadata=...` を返し、claude.ai connector の
  OAuth 2.1 auto-discovery を起動する。

CF API token は CF Secrets Store binding (`CF_ZEROTRUST_API_TOKEN`) から runtime
取得し、worker code / wrangler vars に焼かない。

## tools

### PR1 (read) — 実装済み

| tool | CF endpoint |
|---|---|
| `list_access_apps` | `GET /access/apps` |
| `get_access_app` | `GET /access/apps/{uid}` |
| `list_access_policies` | `GET /access/policies` |
| `list_service_tokens` | `GET /access/service_tokens` |
| `list_identity_providers` | `GET /access/identity_providers` |
| `list_access_groups` | `GET /access/groups` |

### PR2+ (write) — 予定

`create_access_policy` / `delete_access_policy` / `create_access_app` /
`update_access_app` / `delete_access_app` / 高レベル便利 tool `protect_hostname`。
いずれも `requiresScope: "mcp.write"`。

## ロードマップ (issue #26 の PR 分割)

- **PR1** (この PR): scaffold + read tools + `lib/cf-api.ts` + binding_jwt middleware。CI green。
- **PR2**: write tools + `protect_hostname`。CF token を Write 権限へ。
- **PR3**: service tokens / IdP / groups の write (secrets-inventory の既存 CF
  service token tool と重複に注意)。
- **PR4**: auth-worker の `MCP_RESOURCE_ORIGINS_ALLOWLIST` に origin 追加 +
  claude-md 登録 (別 repo)。
- **PR5**: `protect_hostname` で egov-staging 保護 → `cf_logging` で invocation 0 検証。

## ローカル開発

```sh
cd examples/cf-access-mcp
npm install            # @ippoan/mcp-cf-workers は file:../.. で取り込む
npm run typecheck
npm test
```

ロジック (`lib/cf-api.ts` の CF REST client、`mcp/tools.ts` の tool 実体、
`middleware/binding-jwt.ts` の introspect) はすべて fetch / client を引数で差し替え
可能な pure 関数なので、`vitest` を plain node で回せる (本体 lib と同じ)。

## deploy

PR1 時点では deploy はまだ active 化しない (CF token 投入 + custom domain route
設定が前提)。`wrangler.jsonc` に `cf-access-mcp.ippoan.org` の custom domain と
secrets store binding を記述済み。

CF API token の投入 (値は context/log に出さず CF Secrets Store + GCP Secret
Manager へ shell 経由で投入):

```sh
bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh \
  CF_ZEROTRUST_API_TOKEN --targets cf,gcp
```

必要な CF API token 権限 (account-scoped, account_id = `24b45709d060d957340180e995f0d373`):

- read (PR1): `Access: Apps and Policies Read` + `Access: Organizations, Identity
  Providers, and Groups Read`
- write (PR2+): `Access: Apps and Policies Write`

投入後に `npx wrangler deploy`。MCP endpoint は `https://cf-access-mcp.ippoan.org/mcp`。
