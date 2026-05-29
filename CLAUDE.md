# CLAUDE.md

Claude Code 向けの本リポジトリ作業ルール。

## Worktree / branch 命名規則

形式: `<issue-number>-<type>-<short-description>`

- `issue-number`: 必須。先に issue を立ててから worktree / branch を作る
- `type`: `feat` | `fix` | `refactor` | `infra`
- `short-description`: 半角小文字英数字とハイフン

例:

- `1-feat-factory-skeleton`
- `2-fix-jwks-cache-leak`

issue 番号を持たない branch (Claude Code が自動採番する `claude/...` 等)
で実装に入る前に、対応する issue を作成し、上記の形式で rename / 再切り出し
すること。

## PR description / commit message のキーワード

- 使用禁止: `Closes #N` / `Fixes #N` / `Resolves #N`
  - PR auto-merge が走った瞬間に issue が自動 close されるため、release 時の
    close 確認 UI と整合しない
- 使用推奨: `Refs #N` / `Related to #N` / `Part of #N`
  - GitHub の Development セクションには紐付くが auto-close されない
  - release tag 後に ci-dashboard 経由で目視 close する

PR テンプレートは `.github/pull_request_template.md` で `Refs` を強制する。

## このリポジトリの方針

- **薄く保つ**。SDK が出来ることはそのまま借りる (= `McpServer` /
  `WebStandardStreamableHTTPServerTransport`)。lib 側は wiring と
  framework-agnostic auth helper だけ
- consumer は peer dep 経由で SDK / hono / jose / zod を持ち込む (= 版固定は
  consumer 責任)
- Hono 依存は optional peer。core (`factory.ts` / `cf-access.ts`) は
  framework-agnostic
- 公開 API surface を小さく保つ。`./src/index.ts` / `./src/durable.ts` /
  `./src/auth/index.ts` の named export だけが SemVer 対象

## durable (DO+WS) path の構成 (Refs #6)

- `./durable` export は Cloudflare `agents` SDK の `McpAgent` をそのまま借りた
  stateful transport。`agents` は **optional peer dep** (durable path 利用時のみ)
- `agents/mcp` は `cloudflare:workers` を import するため **node (vitest) では
  読めない**。なので agents 非依存の純粋ロジック (server 構築 =
  `durable-server.ts` / edge mount 配線 = `durable-mount.ts`) と agents 依存の
  薄い DO factory (`durable.ts` の `createDurableMcp`) を分離している。前者 2 つは
  InMemoryTransport / stub で node テスト、後者は `vi.mock("agents/mcp")` で
  テストする。新ロジックを足す時はこの分離を保つこと
- `listChanged` capability は `DURABLE_MCP_CAPABILITIES` で single-source。
  stateless `createWorkerMcp` は push 不可なので listChanged を宣言しない

## Phase 0 hard gate 実機検証結果 (Refs #12 / #6, 2026-05-29)

`examples/echo-do-ws` を deploy し、ライブ Claude Code (Web) session +
素の MCP クライアント (curl) の両方で実測した確定事項。**ここを誤解すると
listChanged 周りで無駄な「サーバ修正」を繰り返すので必読。**

### サーバ側 (echo-do-ws / 本 lib) は 100% spec 準拠 — ワイヤレベルで実証済み

curl (= 素の Streamable HTTP クライアント) で同一 `mcp-session-id` を維持して検証:

1. `initialize` → `capabilities.tools.listChanged: true` を宣言 ✅
2. `GET /mcp` (with session-id) → `200 text/event-stream`。server-initiated
   通知用の GET SSE stream を**ちゃんと開く** ✅
3. `bump_version` (= `server.registerTool` + `server.sendToolListChanged()`)
   → **GET SSE stream に `notifications/tools/list_changed` が実際に届く** ✅
   (curl で wire 上に捕捉済み)
4. 同一 session の `tools/list` に runtime 登録した `echo_v2` が出る ✅

→ register/enable/disable/update + 自動 list_changed push は **MCP SDK
(`@modelcontextprotocol/sdk` の `McpServer`) 標準機能**。我々は自作していない。
サーバ側に欠陥は無い。`additionalProperties:false` の strict schema 等の
「サーバを直す」系の対処は **listChanged 不達の原因ではない**ので入れても無駄。

### 詰まりは一点: Claude Code クライアントが wire 上の通知を消費しない

- 上記 curl では echo_v2 が出るのに、**Claude Code Web session の tool list には
  出ない** (same-turn / cross-turn 両方で ✗ を実測)。
- root cause: Claude Code の MCP クライアントは `notifications/tools/list_changed`
  の Zod schema を持つが **`setNotificationHandler` を一度も呼んでいない**
  (decompiled cli.js で確認済み)。`_onnotification` がハンドラ無しで早期 return。
- = SDK にフック (`client.setNotificationHandler`) はあるが、その上の
  Claude Code アプリが配線していない。**サーバ側からは直せない (upstream 案件)。**

### 判定 (#6 Phase 0)

| Gate | 内容 | 結果 |
|------|------|------|
| **A** | deploy → WS drop → 自動再接続 → initialize/tools-list 再取得 | ✅ **PASS** (`echo` の BUILD_TAG が同一 session のまま `605466d`→`e5351ac` に更新) |
| **B** | runtime `bump_version` → 再接続なしで `echo_v2` 反映 | ❌ **FAIL** (クライアント欠落。サーバは正しく push 済み) |

- **#70 の実害 (deploy で schema 変化 → live session が旧 schema で固まる) は
  Gate A = reconnect で解決する。** DO+WS 移行はこの用途で価値がある。
- runtime listChanged push が Web で効かないのは別問題 (クライアント欠落) で、
  #70 のクローズ条件には影響しない。secrets-inventory#70 を対応案③ (再接続必須を
  明記) に後退させる必要は**ない**。
- optional param 追加程度なら inputSchema を `additionalProperties:true` に
  しておくと旧 schema を握ったクライアントでも素通りする (reconnect すら不要)。

### 参照ソース

- 実機検証 issue: ippoan/mcp-cf-workers#12 (本 PoC), epic #6, ippoan/secrets-inventory#70
- Claude Code クライアント欠落:
  - anthropics/claude-code#13646 ([Bug] tool list not refreshed on list_changed)
  - anthropics/claude-code#4118 (list_changed 対応の本流 issue)
  - anthropics/claude-code#31893 (MCP spec compliance: same-turn ✗ / cross-turn ✓ の挙動表)
- MCP spec: [Transports — Streamable HTTP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
  (server-initiated 通知は client が開く GET SSE stream 経由で配送)
- MCP SDK 動的 tool 管理: `McpServer.registerTool` の戻り値ハンドル
  `.update()/.enable()/.disable()/.remove()` が自動で list_changed を push
