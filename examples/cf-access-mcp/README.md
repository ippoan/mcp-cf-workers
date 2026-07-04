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

### read — 実装済み (PR1)

`requiresScope` 無し (binding_jwt が valid なら可)。

| tool | CF endpoint |
|---|---|
| `list_access_apps` | `GET /access/apps` |
| `get_access_app` | `GET /access/apps/{uid}` |
| `list_access_policies` | `GET /access/policies` |
| `list_service_tokens` | `GET /access/service_tokens` |
| `list_identity_providers` | `GET /access/identity_providers` |
| `list_access_groups` | `GET /access/groups` |
| `list_audit_logs` | `GET /audit_logs` |

`list_audit_logs` (issue [#51]) は account の Audit Log を read-only で返す。
`since` / `before` (ISO8601) / `actor_email` / `resource_product` / `per_page` /
`page` で絞り込める。production worker の custom domain / DNS / secret 等の
設定変更を「いつ・誰が・何を」を Claude Code session から直接調査するための tool
(dashboard の Audit Log 画面を手動で見に行かなくて済む)。CF API token に
**Account Audit Logs: Read** scope が必要 (無いと CF 側 403 → `isError` で返る)。

```jsonc
list_audit_logs({
  since: "2026-07-01T00:00:00Z",
  resource_product: "workers", // dns / access / workers 等
})
```

[#51]: https://github.com/ippoan/mcp-cf-workers/issues/51

### write — 実装済み (PR2)

いずれも `requiresScope: "mcp.write"` (binding_jwt の scope に `mcp.write` が
無ければ 403 相当を返す)。scope gating の判定は `mcp/scope.ts` の `isToolAllowed`
に切り出してある (pure、node でテスト可能)。

| tool | CF endpoint | 備考 |
|---|---|---|
| `create_access_policy` | `POST /access/policies` | `allow` (emails/email_domains/everyone) → `include[]` 変換 |
| `delete_access_policy` | `DELETE /access/policies/{uid}` | |
| `create_access_app` | `POST /access/apps` | `type:"self_hosted"`、応答に `aud` |
| `update_access_app` | `PUT /access/apps/{uid}` | CF は full replace |
| `delete_access_app` | `DELETE /access/apps/{uid}` | |
| `protect_hostname` | (policy POST → app POST) | 高レベル便利 tool |

```jsonc
// protect_hostname: 1 発で policy 作成 → self_hosted app 作成
protect_hostname({
  hostname: "egov-staging.ippoan.org",
  allow: { emails: ["m.tama.ramu@gmail.com"] }, // or email_domains / everyone
  allowed_idps: []                               // 空なら One-time PIN (メール)
})
// → { app_uid, aud, policy_id, domain }
```

これが PR5 で egov-staging を保護する最終 tool。`allow` が空 (どの include も
生成されない) なら API を一切叩かず error を返す (誤って全公開 app を作らない fail-safe)。

## ロードマップ (issue #26 の PR 分割)

- **PR1** ✅: scaffold + read tools + `lib/cf-api.ts` + binding_jwt middleware。
- **PR2** ✅ (この PR): write tools + `protect_hostname`。scope gating を `scope.ts`
  に切り出し。CF token を Write 権限へ。
- **PR3**: service tokens / IdP / groups の write (secrets-inventory の既存 CF
  service token tool と重複に注意)。
- **PR4**: auth-worker の `MCP_RESOURCE_ORIGINS_ALLOWLIST` に origin 追加 +
  claude-md 登録 (別 repo)。
- **PR5**: `protect_hostname` で egov-staging 保護 → `cf_logging` で invocation 0 検証。
- **issue #51** ✅: `list_audit_logs` (read-only Audit Log 閲覧 tool) を追加。

## ローカル開発

```sh
cd examples/cf-access-mcp
npm install            # @ippoan/mcp-cf-workers は file:../.. で取り込む
npm run typecheck
npm test
```

ロジック (`lib/cf-api.ts` の CF REST client、`mcp/tools.ts` の tool 実体、
`mcp/scope.ts` の gating、`middleware/binding-jwt.ts` の introspect) はすべて
fetch / client を引数で差し替え可能な pure 関数なので、`vitest` を plain node で
回せる (本体 lib と同じ)。

## deploy

deploy はまだ active 化しない (CF token 投入 + custom domain route 設定が前提)。
`wrangler.jsonc` に `cf-access-mcp.ippoan.org` の custom domain と secrets store
binding を記述済み。

CF API token の投入 (値は context/log に出さず CF Secrets Store + GCP Secret
Manager へ shell 経由で投入):

```sh
bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh \
  CF_ZEROTRUST_API_TOKEN --targets cf,gcp
```

必要な CF API token 権限 (account-scoped, account_id = `24b45709d060d957340180e995f0d373`):

- read: `Access: Apps and Policies Read` + `Access: Organizations, Identity
  Providers, and Groups Read`
- write (PR2 の write tool / `protect_hostname` を実トラフィックで使う場合):
  `Access: Apps and Policies Write` (apps/policies CRUD)
- `list_audit_logs` (issue #51) を使う場合: **`Access: Audit Logs Read`**
  (CF のトークン発行 UI では単に `Account` → `Audit Logs` → `Read` と表示される)

3 つとも Read/Edit で 1 つの custom token にまとめて発行できる (Apps and
Policies は Edit を選べば Read も含まれる)。

> PR2 の write tool を実際に叩くには、token を **Write 権限付き**で再投入する
> (同名 `CF_ZEROTRUST_API_TOKEN` を secret-inject で上書き)。read のみの token の
> ままだと write tool は CF 側で 403 になる。

投入後に `npx wrangler deploy`。MCP endpoint は `https://cf-access-mcp.ippoan.org/mcp`。
